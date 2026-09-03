#!/usr/bin/env python3
"""Add physically reprocessed horizontal mirrors for clean FACS profiles.

Asymmetric states swap their semantic side after mirroring. Symmetric
single-factor states keep the same profile but gain the opposite yaw sample.
That second case matters for Clean Core: the controlled FACS source has strong
expression labels but limited camera directions, so mirroring is a legitimate
way to expand pattern-by-angle coverage without inventing a compound state.
All mirrored files are reprocessed by MediaPipe downstream; pose and geometry
are never copied from the original image.
"""

from __future__ import annotations

import argparse
import csv
import shutil
from pathlib import Path

from PIL import Image, ImageOps

MIRROR_TARGETS = {
    # Anatomically asymmetric states swap sides.
    "winkLeft": "winkRight",
    "winkRight": "winkLeft",
    "gazeLeft": "gazeRight",
    "gazeRight": "gazeLeft",
    "mouthLeft": "mouthRight",
    "mouthRight": "mouthLeft",
    # Symmetric isolated states keep their label while yaw flips.
    "neutral": "neutral",
    "blink": "blink",
    "eyesWide": "eyesWide",
    "gazeUp": "gazeUp",
    "gazeDown": "gazeDown",
    "browsUp": "browsUp",
    "browsDown": "browsDown",
    "noseSneer": "noseSneer",
    "mouthSlightOpen": "mouthSlightOpen",
    "mouthOpen": "mouthOpen",
    "smileClosed": "smileClosed",
    "smileOpen": "smileOpen",
    "mouthRound": "mouthRound",
    "mouthPucker": "mouthPucker",
    "mouthWide": "mouthWide",
    "mouthPress": "mouthPress",
    "mouthRoll": "mouthRoll",
    "mouthFrown": "mouthFrown",
    "mouthShrug": "mouthShrug",
    "mouthUpperUp": "mouthUpperUp",
    "mouthLowerDown": "mouthLowerDown",
}

# Backwards-compatible name used by older tests/tools.
PAIRS = MIRROR_TARGETS


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty")
    if args.overwrite and output.exists():
        shutil.rmtree(output)
    (output / "images").mkdir(parents=True)

    with (source / "metadata.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
        columns = list(rows[0].keys()) if rows else []
    for extra in ("is_mirrored", "mirror_source_profile"):
        if extra not in columns:
            columns.append(extra)

    output_rows = []
    for row in rows:
        original = source / row["relative_path"]
        copied_name = f"original-{Path(row['relative_path']).name}"
        shutil.copyfile(original, output / "images" / copied_name)
        base = dict(row)
        base.update(
            {
                "relative_path": f"images/{copied_name}",
                "is_mirrored": "0",
                "mirror_source_profile": "",
            }
        )
        output_rows.append(base)

        profile = row.get("clean_profile", "")
        target_profile = MIRROR_TARGETS.get(profile)
        if not target_profile:
            continue
        with Image.open(original) as opened:
            image = ImageOps.mirror(ImageOps.exif_transpose(opened).convert("RGB"))
        mirrored_name = f"mirror-{Path(row['relative_path']).stem}.jpg"
        image.save(output / "images" / mirrored_name, "JPEG", quality=93, optimize=True)
        mirrored = dict(row)
        mirrored.update(
            {
                "relative_path": f"images/{mirrored_name}",
                "title": f"{row.get('title', '')} / horizontally mirrored",
                "clean_profile": target_profile,
                "target_configuration": target_profile,
                "is_mirrored": "1",
                "mirror_source_profile": profile,
                "license": f"{row.get('license', '')} / horizontal mirror",
            }
        )
        output_rows.append(mirrored)

    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(output_rows)
    print(f"wrote {len(output_rows)} rows ({len(output_rows) - len(rows)} mirrors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
