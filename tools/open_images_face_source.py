#!/usr/bin/env python3
"""Stage licensed Open Images face crops for coverage-driven curation.

The Open Images bounding box is only a broad face locator. This tool does not
claim that a crop fills a Many Faces pose/expression gap; MediaPipe measures and
routes every staged crop in a later step.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

HUMAN_FACE_MID = "/m/0dzct"
ANNOTATION_LICENSE = "https://creativecommons.org/licenses/by/4.0/"
SPLITS = {
    "validation": {
        "boxes": "https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv",
        "metadata": "https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv",
    },
    "test": {
        "boxes": "https://storage.googleapis.com/openimages/v5/test-annotations-bbox.csv",
        "metadata": "https://storage.googleapis.com/openimages/2018_04/test/test-images-with-rotation.csv",
    },
    "train": {
        "boxes": "https://storage.googleapis.com/openimages/v6/oidv6-train-annotations-bbox.csv",
        "metadata": "https://storage.googleapis.com/openimages/2018_04/train/train-images-boxable-with-rotation.csv",
    },
}
S3_TEMPLATE = "https://open-images-dataset.s3.amazonaws.com/{split}/{image_id}.jpg"
USER_AGENT = "Many Faces Open Images Builder/0.1 (+https://github.com/ugin-man/many-faces-beta)"
CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True)
class FaceBox:
    image_id: str
    xmin: float
    xmax: float
    ymin: float
    ymax: float
    occluded: bool
    truncated: bool
    source: str

    @property
    def area(self) -> float:
        return max(0.0, self.xmax - self.xmin) * max(0.0, self.ymax - self.ymin)

    @property
    def key(self) -> str:
        return (
            f"{self.image_id}:{self.xmin:.6f}:{self.xmax:.6f}:"
            f"{self.ymin:.6f}:{self.ymax:.6f}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--split", choices=sorted(SPLITS), default="validation")
    parser.add_argument("--cache", type=Path, default=Path(".cache/open-images"))
    parser.add_argument("--max-images", type=int, default=240)
    parser.add_argument("--candidate-limit", type=int, default=1500)
    parser.add_argument("--max-per-image", type=int, default=1)
    parser.add_argument("--min-box-area", type=float, default=0.012)
    parser.add_argument("--max-box-area", type=float, default=0.70)
    parser.add_argument("--min-aspect", type=float, default=0.42)
    parser.add_argument("--max-aspect", type=float, default=2.40)
    parser.add_argument("--padding", type=float, default=0.55)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--seed", default="many-faces-open-images-v1")
    parser.add_argument("--allow-occluded", action="store_true")
    parser.add_argument("--allow-truncated", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--metadata-only", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def download_resource(url: str, destination: Path, retries: int = 4) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 0:
        return {
            "path": str(destination),
            "bytes": destination.stat().st_size,
            "sha256": sha256_file(destination),
            "downloaded": False,
        }
    partial = destination.with_suffix(destination.suffix + ".part")
    latest_error: Exception | None = None
    for attempt in range(retries):
        try:
            existing = partial.stat().st_size if partial.exists() else 0
            headers = {"User-Agent": USER_AGENT, "Accept": "text/csv,*/*"}
            if existing:
                headers["Range"] = f"bytes={existing}-"
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                append = existing > 0 and response.status == 206
                if existing and not append:
                    partial.unlink(missing_ok=True)
                with partial.open("ab" if append else "wb") as handle:
                    while chunk := response.read(CHUNK_SIZE):
                        handle.write(chunk)
            os.replace(partial, destination)
            return {
                "path": str(destination),
                "bytes": destination.stat().st_size,
                "sha256": sha256_file(destination),
                "downloaded": True,
            }
        except Exception as error:  # pragma: no cover - network-specific
            latest_error = error
            if attempt + 1 < retries:
                time.sleep(min(20, 2 ** attempt * 2))
    raise RuntimeError(f"Unable to download {url}: {latest_error}")


def flag(row: dict[str, str], name: str) -> bool:
    return str(row.get(name, "0")).strip() == "1"


def deterministic_score(seed: str, key: str) -> int:
    return int.from_bytes(
        hashlib.sha256(f"{seed}:{key}".encode("utf-8")).digest()[:8],
        "big",
    )


def select_face_boxes(path: Path, args: argparse.Namespace) -> tuple[list[FaceBox], dict[str, int]]:
    heap: list[tuple[int, int, FaceBox]] = []
    per_image: dict[str, int] = {}
    counters = {
        "rows": 0,
        "humanFaceRows": 0,
        "eligibleRows": 0,
        "groupOrDepiction": 0,
        "occluded": 0,
        "truncated": 0,
        "area": 0,
        "aspect": 0,
        "perImageLimit": 0,
    }
    sequence = 0
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            counters["rows"] += 1
            if row.get("LabelName") != HUMAN_FACE_MID:
                continue
            counters["humanFaceRows"] += 1
            if flag(row, "IsGroupOf") or flag(row, "IsDepiction") or flag(row, "IsInside"):
                counters["groupOrDepiction"] += 1
                continue
            occluded = flag(row, "IsOccluded")
            truncated = flag(row, "IsTruncated")
            if occluded and not args.allow_occluded:
                counters["occluded"] += 1
                continue
            if truncated and not args.allow_truncated:
                counters["truncated"] += 1
                continue
            try:
                box = FaceBox(
                    image_id=str(row["ImageID"]),
                    xmin=float(row["XMin"]),
                    xmax=float(row["XMax"]),
                    ymin=float(row["YMin"]),
                    ymax=float(row["YMax"]),
                    occluded=occluded,
                    truncated=truncated,
                    source=str(row.get("Source", "")),
                )
            except (KeyError, TypeError, ValueError):
                counters["area"] += 1
                continue
            width = box.xmax - box.xmin
            height = box.ymax - box.ymin
            if box.area < args.min_box_area or box.area > args.max_box_area:
                counters["area"] += 1
                continue
            aspect = width / max(height, 1e-9)
            if aspect < args.min_aspect or aspect > args.max_aspect:
                counters["aspect"] += 1
                continue
            count = per_image.get(box.image_id, 0)
            if count >= args.max_per_image:
                counters["perImageLimit"] += 1
                continue
            per_image[box.image_id] = count + 1
            counters["eligibleRows"] += 1
            score = deterministic_score(args.seed, box.key)
            sequence += 1
            item = (-score, sequence, box)
            if len(heap) < args.candidate_limit:
                heapq.heappush(heap, item)
            elif score < -heap[0][0]:
                heapq.heapreplace(heap, item)
    selected = [item[2] for item in heap]
    selected.sort(key=lambda box: (deterministic_score(args.seed, box.key), box.key))
    return selected, counters


def valid_license(url: str) -> bool:
    normalized = url.strip().lower().rstrip("/")
    return normalized in {
        "http://creativecommons.org/licenses/by/2.0",
        "https://creativecommons.org/licenses/by/2.0",
    }


def load_metadata(path: Path, image_ids: set[str]) -> tuple[dict[str, dict[str, str]], dict[str, int]]:
    metadata: dict[str, dict[str, str]] = {}
    counters = {
        "rows": 0,
        "matched": 0,
        "invalidLicense": 0,
        "missingAttribution": 0,
    }
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            counters["rows"] += 1
            image_id = str(row.get("ImageID", ""))
            if image_id not in image_ids:
                continue
            counters["matched"] += 1
            if not valid_license(str(row.get("License", ""))):
                counters["invalidLicense"] += 1
                continue
            if not str(row.get("OriginalLandingURL", "")).startswith("http") or not str(row.get("Author", "")).strip():
                counters["missingAttribution"] += 1
                continue
            metadata[image_id] = {key: str(value or "").strip() for key, value in row.items()}
    return metadata, counters


def fetch_bytes(url: str, retries: int = 4) -> bytes:
    latest_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "image/jpeg,image/*"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read(12 * 1024 * 1024 + 1)
            if len(payload) > 12 * 1024 * 1024:
                raise RuntimeError("image exceeds 12 MiB limit")
            return payload
        except Exception as error:  # pragma: no cover - network-specific
            latest_error = error
            if attempt + 1 < retries:
                time.sleep(min(12, 2 ** attempt))
    raise RuntimeError(str(latest_error))


def square_crop(image: Image.Image, box: FaceBox, padding: float, rotation: int) -> Image.Image:
    width, height = image.size
    x0 = box.xmin * width
    x1 = box.xmax * width
    y0 = box.ymin * height
    y1 = box.ymax * height
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) * (1 + 2 * padding)
    side = max(32.0, min(side, max(width, height) * 1.25))
    crop = image.crop(
        (
            round(center_x - side / 2),
            round(center_y - side / 2),
            round(center_x + side / 2),
            round(center_y + side / 2),
        )
    )
    if rotation in {90, 180, 270}:
        crop = crop.rotate(rotation, expand=True)
    return crop


def stage_one(
    index: int,
    box: FaceBox,
    metadata: dict[str, str],
    args: argparse.Namespace,
    image_dir: Path,
) -> tuple[dict[str, str] | None, str | None]:
    try:
        source_url = S3_TEMPLATE.format(split=args.split, image_id=box.image_id)
        payload = fetch_bytes(source_url)
        from io import BytesIO

        with Image.open(BytesIO(payload)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
        rotation_value = metadata.get("Rotation", "0")
        try:
            rotation = int(float(rotation_value)) if rotation_value.lower() != "nan" else 0
        except ValueError:
            rotation = 0
        crop = square_crop(image, box, args.padding, rotation)
        crop = ImageOps.fit(
            crop,
            (args.size, args.size),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
        filename = f"{index:07d}-openimages-{args.split}-{box.image_id}.jpg"
        destination = image_dir / filename
        crop.save(destination, format="JPEG", quality=args.quality, optimize=True)
        license_url = metadata["License"]
        return {
            "relative_path": f"images/{filename}",
            "title": metadata.get("Title") or f"Open Images {box.image_id}",
            "source_name": "Open Images V7",
            "source_url": metadata["OriginalLandingURL"],
            "creator": metadata["Author"],
            "license": "CC BY 2.0",
            "license_url": license_url,
            "target_pose": "",
            "target_configuration": "",
            "target_query": "Open Images Human face bounding box",
            "target_pressure": "",
            "open_images_id": box.image_id,
            "open_images_split": args.split,
            "open_images_annotation_source": box.source,
            "open_images_annotation_license": ANNOTATION_LICENSE,
            "box_xmin": f"{box.xmin:.6f}",
            "box_xmax": f"{box.xmax:.6f}",
            "box_ymin": f"{box.ymin:.6f}",
            "box_ymax": f"{box.ymax:.6f}",
            "original_url": metadata.get("OriginalURL", ""),
            "author_profile_url": metadata.get("AuthorProfileURL", ""),
        }, None
    except Exception as error:  # pragma: no cover - network/image-specific
        return None, f"{type(error).__name__}: {error}"


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    columns = [
        "relative_path", "title", "source_name", "source_url", "creator", "license", "license_url",
        "target_pose", "target_configuration", "target_query", "target_pressure",
        "open_images_id", "open_images_split", "open_images_annotation_source",
        "open_images_annotation_license", "box_xmin", "box_xmax", "box_ymin", "box_ymax",
        "original_url", "author_profile_url",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    args = parse_args()
    if args.max_images <= 0 or args.candidate_limit < args.max_images:
        raise SystemExit("--candidate-limit must be at least --max-images, both positive")
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty. Use --overwrite or choose another directory.")
    if args.overwrite and output.exists():
        import shutil

        shutil.rmtree(output)
    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    cache = args.cache.resolve() / args.split
    sources = SPLITS[args.split]
    boxes_path = cache / "boxes.csv"
    metadata_path = cache / "metadata.csv"
    source_report = {
        "split": args.split,
        "humanFaceMid": HUMAN_FACE_MID,
        "annotationLicense": ANNOTATION_LICENSE,
        "sources": {
            "boxes": {"url": sources["boxes"], **download_resource(sources["boxes"], boxes_path)},
            "metadata": {"url": sources["metadata"], **download_resource(sources["metadata"], metadata_path)},
        },
    }
    boxes, box_stats = select_face_boxes(boxes_path, args)
    metadata, metadata_stats = load_metadata(metadata_path, {box.image_id for box in boxes})
    eligible = [box for box in boxes if box.image_id in metadata]
    source_report.update({
        "boxStats": box_stats,
        "metadataStats": metadata_stats,
        "deterministicCandidates": len(boxes),
        "licensedCandidates": len(eligible),
    })
    if args.metadata_only:
        source_report["staged"] = 0
        (output / "source-report.json").write_text(json.dumps(source_report, indent=2), encoding="utf-8")
        print(json.dumps(source_report, indent=2))
        return 0

    rows: list[dict[str, str]] = []
    failures: dict[str, int] = {}
    selected = eligible[: args.max_images]
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(stage_one, index, box, metadata[box.image_id], args, image_dir): box
            for index, box in enumerate(selected)
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            row, error = future.result()
            if row is not None:
                rows.append(row)
            else:
                failures[error or "unknown"] = failures.get(error or "unknown", 0) + 1
            if completed % 25 == 0 or completed == len(futures):
                print(f"{completed}/{len(futures)} downloaded | {len(rows)} staged | {sum(failures.values())} failed")
    rows.sort(key=lambda row: row["relative_path"])
    write_csv(output / "metadata.csv", rows)
    source_report.update({
        "requested": args.max_images,
        "downloadAttempts": len(selected),
        "staged": len(rows),
        "downloadFailures": failures,
    })
    (output / "source-report.json").write_text(json.dumps(source_report, indent=2), encoding="utf-8")
    print(json.dumps(source_report, indent=2))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
