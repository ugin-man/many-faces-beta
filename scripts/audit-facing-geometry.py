#!/usr/bin/env python3
"""Find direction-review candidates without repeating the pose classifier.

The stored 2D landmarks are still model measurements. Their nose offsets only
prioritize exact original photos for visual review; they never reject a photo.
This script does not modify the catalog or synthesize/mirror replacement pixels.
"""
import argparse
import base64
import csv
import hashlib
import io
import json
import math
import struct
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

EXPECTED_MANIFEST = "fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a"


def measures(entry):
    raw = base64.b64decode(entry["projection"], validate=True)
    assert len(raw) >= 936 * 2 and len(raw) % 2 == 0
    points = struct.unpack("<" + "h" * (len(raw) // 2), raw)
    x = lambda index: points[index * 2] / 4096.0
    eye_center = (x(33) + x(133) + x(362) + x(263)) / 4
    nose = (x(1) + x(4)) / 2
    width = x(454) - x(234)
    assert width > 0
    result = {
        "yaw": float(entry["feature"][0]) * 90,
        "pitch": float(entry["feature"][1]) * 90,
        "noseEyeOffset": nose - eye_center,
        "noseBridgeOffset": nose - x(168),
        "noseCheekOffset": (nose - (x(234) + x(454)) / 2) / width,
    }
    assert all(math.isfinite(value) for value in result.values())
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=Path("public/seed-catalog"))
    parser.add_argument("--out", type=Path, default=Path("work/facing-geometry-review"))
    args = parser.parse_args()
    manifest_bytes = (args.catalog / "manifest.json").read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == EXPECTED_MANIFEST, "Unexpected catalog"
    manifest = json.loads(manifest_bytes)
    assert manifest["totalFaces"] == manifest["searchableFaces"] == 70000
    assert manifest["poseStep"] == 3 and len(manifest["cells"]) == 775
    rows, entries = [], {}
    for cell_key, cell in manifest["cells"].items():
        for name in cell.get("shards", [cell.get("shard")]):
            for entry in json.loads((args.catalog / "shards" / name).read_text())["items"]:
                assert entry["id"] not in entries
                entries[entry["id"]] = entry
                rows.append({"id": entry["id"], "cell": cell_key, "shard": name, **measures(entry)})
    assert len(rows) == 70000
    # Discover the numeric convention, then export reference photos so the
    # convention can also be checked visually. This does not certify it.
    keys = ("noseEyeOffset", "noseBridgeOffset", "noseCheekOffset")
    convention = {key: (1 if sum(r["yaw"] * r[key] for r in rows if abs(r["yaw"]) >= 20) > 0 else -1)
                  for key in keys}
    for row in rows:
        direction = 1 if row["yaw"] >= 0 else -1
        row["opposingEye"] = -direction * convention["noseEyeOffset"] * row["noseEyeOffset"]
        row["opposingBridge"] = -direction * convention["noseBridgeOffset"] * row["noseBridgeOffset"]
        row["reviewPriority"] = row["opposingEye"] + row["opposingBridge"]
        row["strongGeometryContradiction"] = (abs(row["yaw"]) >= 6 and row["opposingEye"] >= .05
                                              and row["opposingBridge"] >= .03)
    selected, selected_ids = [], set()

    def take(group, candidates, count):
        for row in candidates:
            if row["id"] in selected_ids:
                continue
            selected.append({**row, "reviewGroup": group})
            selected_ids.add(row["id"])
            count -= 1
            if count == 0:
                break

    take("strong-contradiction", sorted((r for r in rows if r["strongGeometryContradiction"]),
                                      key=lambda r: (-r["reviewPriority"], r["id"])), 120)
    for sign in (-1, 1):
        side = [r for r in rows if r["yaw"] * sign >= 12]
        take(f"side-{sign:+d}-closest-opposition", sorted(side, key=lambda r: (-r["reviewPriority"], r["id"])), 30)
        near = [r for r in rows if 3 <= r["yaw"] * sign < 12]
        take(f"near-{sign:+d}-closest-opposition", sorted(near, key=lambda r: (-r["reviewPriority"], r["id"])), 15)
        reference = [r for r in side if abs(r["yaw"]) >= 30 and abs(r["pitch"]) < 10]
        take(f"reference-{sign:+d}", sorted(reference, key=lambda r: hashlib.sha256(r["id"].encode()).hexdigest()), 10)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "images").mkdir(exist_ok=True)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
    sheet = None
    for i, row in enumerate(selected):
        entry = entries[row["id"]]
        with (args.catalog / "packs" / entry["pack"]).open("rb") as f:
            f.seek(entry["offset"])
            payload = f.read(entry["length"])
        digest = hashlib.sha256(payload).hexdigest()
        assert digest == entry["admissionSha256"]
        row.update(sample=f"D{i + 1:03d}", sha256=digest, visualDecision="unreviewed", entry=entry)
        row["image"] = f"images/{row['sample']}.webp"
        (args.out / row["image"]).write_bytes(payload)
        if i % 20 == 0:
            sheet = Image.new("RGB", (1280, 1280), "#20242c")
        photo = Image.open(io.BytesIO(payload)).convert("RGB")
        photo.thumbnail((248, 248))
        x, y = (i % 5) * 256, ((i // 5) % 4) * 320
        sheet.paste(photo, (x + (256 - photo.width) // 2, y))
        draw = ImageDraw.Draw(sheet)
        draw.text((x + 5, y + 252), f"{row['sample']} yaw {row['yaw']:+.1f} pitch {row['pitch']:+.1f}", font=font, fill="white")
        draw.text((x + 5, y + 274), f"eye {row['noseEyeOffset']:+.2f} tip {row['noseBridgeOffset']:+.2f}", font=font, fill="white")
        draw.text((x + 5, y + 296), row["reviewGroup"][:27], font=font, fill="#a8c9eb")
        if i % 20 == 19 or i == len(selected) - 1:
            sheet.save(args.out / f"sheet-{i // 20 + 1:02d}.jpg", quality=92)
    with (args.out / "all-measurements.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    report = {
        "schemaVersion": 1, "status": "unreviewed", "catalogModified": False,
        "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "manifestSha256": EXPECTED_MANIFEST, "totalMeasured": len(rows),
        "metricConvention": convention,
        "strongGeometryContradictions": sum(r["strongGeometryContradiction"] for r in rows),
        "selectedOriginals": len(selected), "samples": selected,
        "limitations": ["Landmarks share the original model; offsets are a review-prioritization heuristic.",
                        "No photo is excluded without visual confirmation of exact original pixels.",
                        "A failure to find a suspect does not resolve the user's reported photo."],
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "samples"}))


if __name__ == "__main__":
    main()
