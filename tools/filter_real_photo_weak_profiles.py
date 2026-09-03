#!/usr/bin/env python3
"""Keep only measured weak Clean Core v3 real-photo profiles.

The search query never becomes the class label.  `curate-clean-core-v3.py`
measures every image with MediaPipe first; this filter then keeps only weak
profiles that are actually present, preserves attribution, and emits contact
sheets for visual review.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageOps

WEAK_PROFILES = {
    "winkLeft",
    "winkRight",
    "eyesWide",
    "noseSneer",
    "mouthRound",
    "mouthSlightOpen",
    "mouthOpen",
    "smileOpen",
    "mouthWide",
    "mouthLeft",
    "mouthRight",
    "mouthFrown",
    "mouthUpperUp",
    "mouthLowerDown",
}

SYNTHETIC_MARKERS = (
    "verified-synthetic-facs",
    "synthetic humans",
    "synthetic-humans",
    "computer-generated",
    "computer generated",
    "3d render",
    "3d-render",
    "3d model",
    "virtual human",
    "metahuman",
    "cgi portrait",
    "cg portrait",
    "digital art",
    "illustration",
    "cartoon",
    "anime",
    "game character",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--max-per-profile", type=int, default=0)
    return parser.parse_args()


def row_text(row: dict[str, str]) -> str:
    fields = (
        "title",
        "source_name",
        "source_url",
        "source_kind",
        "provider",
        "source_collection",
        "target_query",
    )
    return " ".join((row.get(field) or "").lower() for field in fields)


def synthetic_reason(row: dict[str, str]) -> str | None:
    text = row_text(row)
    for marker in SYNTHETIC_MARKERS:
        if marker in text:
            return marker
    return None


def contact_sheet(path: Path, profile: str, rows: list[dict[str, str]], root: Path) -> None:
    if not rows:
        return
    tile_width, image_height, caption_height = 170, 170, 38
    columns, rows_per_sheet = 6, 5
    selected = rows[: columns * rows_per_sheet]
    sheet = Image.new("RGB", (tile_width * columns, (image_height + caption_height) * rows_per_sheet), "white")
    draw = ImageDraw.Draw(sheet)
    for index, row in enumerate(selected):
        source = root / row["relative_path"]
        try:
            with Image.open(source) as opened:
                image = ImageOps.fit(ImageOps.exif_transpose(opened).convert("RGB"), (tile_width, image_height))
        except Exception:
            continue
        x = (index % columns) * tile_width
        y = (index // columns) * (image_height + caption_height)
        sheet.paste(image, (x, y))
        yaw = row.get("measured_yaw", "?")
        pitch = row.get("measured_pitch", "?")
        source_name = (row.get("source_name") or "source")[:20]
        draw.text((x + 4, y + image_height + 3), f"{yaw},{pitch} {source_name}", fill="black")
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, "JPEG", quality=89, optimize=True)


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty")
    if args.overwrite and output.exists():
        shutil.rmtree(output)
    (output / "images").mkdir(parents=True, exist_ok=True)
    (output / "review").mkdir(parents=True, exist_ok=True)

    with (source / "metadata.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
        columns = list(handle.fieldnames or [])

    for extra in ("sourceKind", "runtimeImagePolicy", "targetedWeakProfile"):
        if extra not in columns:
            columns.append(extra)

    kept: list[dict[str, str]] = []
    profile_counts: Counter[str] = Counter()
    requested_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    rejections: Counter[str] = Counter()
    exact_hashes: set[str] = set()

    for row in rows:
        profile = (row.get("clean_profile") or "").strip()
        if profile not in WEAK_PROFILES:
            rejections["not_weak_profile"] += 1
            continue
        reason = synthetic_reason(row)
        if reason:
            rejections[f"synthetic_marker:{reason}"] += 1
            continue
        if args.max_per_profile > 0 and profile_counts[profile] >= args.max_per_profile:
            rejections["profile_cap"] += 1
            continue
        relative = (row.get("relative_path") or "").replace("\\", "/")
        source_path = source / relative
        if not source_path.is_file():
            rejections["missing_image"] += 1
            continue
        payload = source_path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if digest in exact_hashes:
            rejections["exact_duplicate"] += 1
            continue
        exact_hashes.add(digest)
        destination_name = f"{len(kept):07d}-{digest[:20]}{source_path.suffix.lower()}"
        shutil.copyfile(source_path, output / "images" / destination_name)
        clean = dict(row)
        clean["relative_path"] = f"images/{destination_name}"
        clean["sourceKind"] = "real-photo-targeted"
        clean["runtimeImagePolicy"] = "real-photo-only-v1"
        clean["targetedWeakProfile"] = profile
        kept.append(clean)
        profile_counts[profile] += 1
        requested_counts[(row.get("target_configuration") or "unknown").strip()] += 1
        source_counts[(row.get("source_name") or "unknown").strip()] += 1

    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(kept)

    by_profile: dict[str, list[dict[str, str]]] = {}
    for row in kept:
        by_profile.setdefault(row["clean_profile"], []).append(row)
    for profile, profile_rows in sorted(by_profile.items()):
        profile_rows.sort(
            key=lambda row: (
                abs(float(row.get("measured_yaw") or 0.0)),
                abs(float(row.get("measured_pitch") or 0.0)),
                row.get("source_url") or "",
            )
        )
        contact_sheet(output / "review" / f"{profile}.jpg", profile, profile_rows, output)

    report: dict[str, Any] = {
        "schemaVersion": 1,
        "checked": len(rows),
        "kept": len(kept),
        "profiles": dict(sorted(profile_counts.items())),
        "requestedProfiles": dict(sorted(requested_counts.items())),
        "sources": dict(sorted(source_counts.items())),
        "rejections": dict(sorted(rejections.items())),
        "runtimeImagePolicy": "real-photo-only-v1",
        "knownSyntheticFacesKept": 0,
    }
    (output / "filter-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if kept else 1


if __name__ == "__main__":
    raise SystemExit(main())
