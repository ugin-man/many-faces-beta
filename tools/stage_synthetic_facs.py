#!/usr/bin/env python3
"""Stage the CC BY 4.0 Synthetic Humans FACS dataset for Clean Core.

The source renders exactly one FACS action unit per image. The action annotation
is retained as a target, while the downstream curator still runs MediaPipe,
quality checks and cross-family leakage checks before accepting a face.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import shutil
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

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
    return numbers[-1].lstrip("0") or "0" if numbers else stem.lower()


def save_preview(payload: bytes, destination: Path) -> None:
    with Image.open(io.BytesIO(payload)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, "JPEG", quality=91, optimize=True, progressive=True)


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
                payload = json.loads(zf.read(annotation_name).decode("utf-8-sig"))
            except Exception:
                counts["annotation_error"] += 1
                continue
            au = annotation_value(payload)
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
                save_preview(zf.read(image_name), output / "images" / filename)
            except Exception:
                counts["image_error"] += 1
                continue
            rows.append(make_row(filename, image_name, au, target))
            counts[target] += 1
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
            payload = json.loads(annotation.read_text(encoding="utf-8-sig"))
        except Exception:
            counts["annotation_error"] += 1
            continue
        au = annotation_value(payload)
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
            save_preview(image.read_bytes(), output / "images" / filename)
        except Exception:
            counts["image_error"] += 1
            continue
        rows.append(make_row(filename, str(image.relative_to(root)), au, target))
        counts[target] += 1
    return rows, counts


def make_row(filename: str, original: str, au: int, target: str) -> dict[str, str]:
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
