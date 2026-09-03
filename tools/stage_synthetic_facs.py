#!/usr/bin/env python3
"""Stage the CC BY 4.0 Synthetic Humans FACS dataset for Clean Core.

The source renders exactly one FACS action unit per image and ships projected
face landmarks in each annotation.  The raw FHD renders leave enough canvas
around the MetaHuman that a portrait-oriented face detector can reject an
otherwise valid frame.  Staging therefore uses the source-provided projected
landmarks only to create a generous square face crop.  The downstream curator
still performs independent MediaPipe detection, action measurement, quality
checks and cross-family leakage checks before accepting anything.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import shutil
import statistics
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

DATASET_HANDLE = "allexmendes/synthetic-humans-facs"
DOWNLOAD_URL = f"https://www.kaggle.com/api/v1/datasets/download/{DATASET_HANDLE}"
SOURCE_URL = "https://www.kaggle.com/datasets/allexmendes/synthetic-humans-facs"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"

AU_TARGETS = {
    46: "wink",
    45: "blink",
    5: "eyesWide",
    2: "browsUp",
    4: "browsDown",
    9: "noseSneer",
    18: "mouthPucker",
    27: "mouthWide",
    25: "mouthSlightOpen",
    24: "mouthPress",
    12: "smileClosed",
    22: "mouthRound",
    10: "mouthUpperUp",
    16: "mouthLowerDown",
    15: "mouthFrown",
    23: "mouthPress",
}

COLUMNS = [
    "relative_path", "title", "source_name", "source_url", "creator",
    "license", "license_url", "target_pose", "target_configuration",
    "target_query", "target_pressure", "open_images_id", "open_images_split",
    "open_images_annotation_source", "open_images_annotation_license",
    "box_xmin", "box_xmax", "box_ymin", "box_ymax", "original_url",
    "author_profile_url", "annotation_verified", "facs_action_unit",
    "staging_crop",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--cache", type=Path, default=Path(".cache/synthetic-humans-facs"))
    parser.add_argument("--dataset-root", type=Path)
    parser.add_argument("--max-images", type=int, default=0)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def action_unit(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        return int(value)
    match = re.search(r"(?:AU)?\s*(\d+)", str(value or ""), re.IGNORECASE)
    return int(match.group(1)) if match else None


def annotation_value(payload: Any) -> int | None:
    if isinstance(payload, dict):
        for key in ("ActionUnit", "actionUnit", "action_unit", "AU", "au"):
            if key in payload:
                return action_unit(payload[key])
        for value in payload.values():
            result = annotation_value(value)
            if result is not None:
                return result
    elif isinstance(payload, list):
        for value in payload:
            result = annotation_value(value)
            if result is not None:
                return result
    return None


def numeric_key(name: str) -> str:
    stem = Path(name).stem
    numbers = re.findall(r"\d+", stem)
    return (numbers[-1].lstrip("0") or "0") if numbers else stem.lower()


def _landmark_tree(payload: Any) -> Any | None:
    if isinstance(payload, dict):
        for key, value in payload.items():
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in {"landmark", "landmarks"}:
                return value
        for value in payload.values():
            found = _landmark_tree(value)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _landmark_tree(value)
            if found is not None:
                return found
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if abs(result) < 100_000 else None


def _collect_points(value: Any, output: list[tuple[float, float]]) -> None:
    if isinstance(value, dict):
        lowered = {str(key).lower(): item for key, item in value.items()}
        if "x" in lowered and "y" in lowered:
            x, y = _number(lowered["x"]), _number(lowered["y"])
            if x is not None and y is not None:
                output.append((x, y))
                return
        for item in value.values():
            _collect_points(item, output)
        return
    if isinstance(value, (list, tuple)):
        if 2 <= len(value) <= 4:
            x, y = _number(value[0]), _number(value[1])
            if x is not None and y is not None:
                output.append((x, y))
                return
        for item in value:
            _collect_points(item, output)


def projected_points(payload: Any, width: int, height: int) -> list[tuple[float, float]]:
    tree = _landmark_tree(payload)
    if tree is None:
        return []
    raw: list[tuple[float, float]] = []
    _collect_points(tree, raw)
    if not raw:
        return []

    max_abs = max(max(abs(x), abs(y)) for x, y in raw)
    min_x = min(x for x, _ in raw); min_y = min(y for _, y in raw)
    max_x = max(x for x, _ in raw); max_y = max(y for _, y in raw)
    output: list[tuple[float, float]] = []

    # The public dataset describes LandMarks as projected image-space points.
    # Accommodate the common pixel, [0,1], and [-1,1] encodings defensively.
    if max_abs <= 1.5:
        ndc = min_x < -0.05 or min_y < -0.05
        for x, y in raw:
            if ndc:
                nx, ny = (x + 1.0) / 2.0, (1.0 - y) / 2.0
            else:
                nx, ny = x, y
            if -0.2 <= nx <= 1.2 and -0.2 <= ny <= 1.2:
                output.append((nx * width, ny * height))
    else:
        for x, y in raw:
            if -0.2 * width <= x <= 1.2 * width and -0.2 * height <= y <= 1.2 * height:
                output.append((x, y))
    return output


def face_crop(image: Image.Image, annotation: Any) -> tuple[Image.Image, str]:
    width, height = image.size
    points = projected_points(annotation, width, height)
    if points:
        xs = [point[0] for point in points]; ys = [point[1] for point in points]
        landmark_x = statistics.median(xs); landmark_y = statistics.median(ys)
        # AU annotations can contain only eye or mouth landmarks, so pull the
        # local landmark center toward the image center and use a deliberately
        # generous minimum crop rather than treating the landmark extent as a
        # full-face box.
        center_x = landmark_x * 0.68 + width * 0.5 * 0.32
        center_y = landmark_y * 0.58 + height * 0.5 * 0.42
        landmark_span = max(max(xs) - min(xs), max(ys) - min(ys))
        side = max(min(width, height) * 0.42, landmark_span * 5.0)
        side = min(side, min(width, height) * 0.72)
        mode = "projected-landmarks"
    else:
        center_x, center_y = width * 0.5, height * 0.5
        side = min(width, height) * 0.55
        mode = "center-fallback"

    side = max(160.0, min(float(side), float(min(width, height))))
    half = side / 2.0
    center_x = min(width - half, max(half, center_x))
    center_y = min(height - half, max(half, center_y))
    crop = image.crop((round(center_x - half), round(center_y - half), round(center_x + half), round(center_y + half)))
    crop = ImageOps.fit(crop, (768, 768), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    return crop, mode


def save_preview(payload: bytes, destination: Path, annotation: Any) -> str:
    with Image.open(io.BytesIO(payload)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    image, mode = face_crop(image, annotation)
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, "JPEG", quality=93, optimize=True, progressive=True)
    return mode


def download_dataset(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / "synthetic-humans-facs.zip"
    if archive.exists() and archive.stat().st_size > 1_000_000:
        return archive
    try:
        request = urllib.request.Request(DOWNLOAD_URL, headers={"User-Agent": "Many Faces Clean Core Builder/3"})
        with urllib.request.urlopen(request, timeout=180) as response, archive.open("wb") as handle:
            shutil.copyfileobj(response, handle, length=1024 * 1024)
        if not zipfile.is_zipfile(archive):
            raise RuntimeError("Kaggle response was not a ZIP archive")
        return archive
    except Exception as direct_error:
        archive.unlink(missing_ok=True)
        try:
            import kagglehub  # type: ignore
            root = Path(kagglehub.dataset_download(DATASET_HANDLE))
            if not root.exists():
                raise RuntimeError(f"kagglehub returned missing path: {root}")
            return root
        except Exception as hub_error:
            raise RuntimeError(f"Synthetic Humans FACS download failed: direct={direct_error}; kagglehub={hub_error}") from hub_error


def stage_zip(archive: Path, output: Path, max_images: int) -> tuple[list[dict[str, str]], Counter[str]]:
    rows: list[dict[str, str]] = []
    counts: Counter[str] = Counter()
    with zipfile.ZipFile(archive) as zf:
        names = [name for name in zf.namelist() if not name.endswith("/")]
        annotations = [name for name in names if name.lower().endswith(".json")]
        images = [name for name in names if Path(name).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}]
        image_by_key: dict[str, str] = {}
        for name in images:
            image_by_key.setdefault(numeric_key(name), name)
        fallback_images = iter(sorted(images))
        for annotation_name in sorted(annotations):
            if max_images and len(rows) >= max_images:
                break
            try:
                annotation = json.loads(zf.read(annotation_name).decode("utf-8-sig"))
            except Exception:
                counts["annotation_error"] += 1
                continue
            au = annotation_value(annotation)
            target = AU_TARGETS.get(au or -1)
            if not target:
                counts[f"unsupported_au_{au}"] += 1
                continue
            image_name = image_by_key.get(numeric_key(annotation_name))
            if image_name is None:
                image_name = next(fallback_images, None)
            if image_name is None:
                counts["missing_image"] += 1
                continue
            filename = f"{len(rows):06d}-au{au:02d}-{numeric_key(image_name)}.jpg"
            try:
                crop_mode = save_preview(zf.read(image_name), output / "images" / filename, annotation)
            except Exception:
                counts["image_error"] += 1
                continue
            rows.append(make_row(filename, image_name, au, target, crop_mode))
            counts[target] += 1
            counts[f"crop_{crop_mode}"] += 1
    return rows, counts


def stage_directory(root: Path, output: Path, max_images: int) -> tuple[list[dict[str, str]], Counter[str]]:
    annotations = sorted(root.rglob("*.json"))
    images = [path for path in root.rglob("*") if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}]
    image_by_key: dict[str, Path] = {}
    for image in images:
        image_by_key.setdefault(numeric_key(image.name), image)
    rows: list[dict[str, str]] = []
    counts: Counter[str] = Counter()
    fallback_images = iter(sorted(images))
    for annotation in annotations:
        if max_images and len(rows) >= max_images:
            break
        try:
            annotation_payload = json.loads(annotation.read_text(encoding="utf-8-sig"))
        except Exception:
            counts["annotation_error"] += 1
            continue
        au = annotation_value(annotation_payload)
        target = AU_TARGETS.get(au or -1)
        if not target:
            counts[f"unsupported_au_{au}"] += 1
            continue
        image = image_by_key.get(numeric_key(annotation.name)) or next(fallback_images, None)
        if image is None:
            counts["missing_image"] += 1
            continue
        filename = f"{len(rows):06d}-au{au:02d}-{numeric_key(image.name)}.jpg"
        try:
            crop_mode = save_preview(image.read_bytes(), output / "images" / filename, annotation_payload)
        except Exception:
            counts["image_error"] += 1
            continue
        rows.append(make_row(filename, str(image.relative_to(root)), au, target, crop_mode))
        counts[target] += 1
        counts[f"crop_{crop_mode}"] += 1
    return rows, counts


def make_row(filename: str, original: str, au: int, target: str, crop_mode: str) -> dict[str, str]:
    return {
        "relative_path": f"images/{filename}",
        "title": f"Synthetic Humans FACS AU{au}",
        "source_name": "Synthetic Humans FACS",
        "source_url": SOURCE_URL,
        "creator": "Alexandre Mendes / Unreal Engine MetaHuman",
        "license": "CC BY 4.0",
        "license_url": LICENSE_URL,
        "target_pose": "",
        "target_configuration": target,
        "target_query": f"FACS AU{au}",
        "target_pressure": "",
        "open_images_id": "",
        "open_images_split": "",
        "open_images_annotation_source": "",
        "open_images_annotation_license": "",
        "box_xmin": "", "box_xmax": "", "box_ymin": "", "box_ymax": "",
        "original_url": original,
        "author_profile_url": "https://www.kaggle.com/allexmendes",
        "annotation_verified": "true",
        "facs_action_unit": str(au),
        "staging_crop": crop_mode,
    }


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty")
    if args.overwrite and output.exists():
        shutil.rmtree(output)
    (output / "images").mkdir(parents=True, exist_ok=True)
    source = args.dataset_root.resolve() if args.dataset_root else download_dataset(args.cache.resolve())
    if source.is_file() and zipfile.is_zipfile(source):
        rows, counts = stage_zip(source, output, args.max_images)
    elif source.is_dir():
        rows, counts = stage_directory(source, output, args.max_images)
    else:
        raise SystemExit(f"Unsupported FACS source: {source}")
    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader(); writer.writerows(rows)
    report = {
        "source": "Synthetic Humans FACS",
        "sourceUrl": SOURCE_URL,
        "license": "CC BY 4.0",
        "staged": len(rows),
        "targets": dict(sorted(counts.items())),
    }
    (output / "source-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
