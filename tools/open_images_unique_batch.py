#!/usr/bin/env python3
"""Stage a new Open Images batch while excluding already packed source IDs.

The underlying source selector is deterministic for a seed. This wrapper asks it
for an oversampled pool, removes Open Images IDs already present in active
coverage checkpoints, and keeps at most the requested number of fresh crops.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--split", choices=("validation", "test", "train"), default="train")
    parser.add_argument("--cache", type=Path, default=Path(".cache/open-images"))
    parser.add_argument("--checkpoints", type=Path, default=Path("data/coverage-checkpoints"))
    parser.add_argument("--max-images", type=int, default=6000)
    parser.add_argument("--candidate-limit", type=int, default=14000)
    parser.add_argument("--oversample", type=float, default=1.35)
    parser.add_argument("--seed", default="many-faces-open-images-train-0001")
    parser.add_argument("--min-box-area", type=float, default=0.006)
    parser.add_argument("--workers", type=int, default=20)
    parser.add_argument("--allow-occluded", action="store_true")
    parser.add_argument("--allow-truncated", action="store_true")
    return parser.parse_args()


def active_exclusions(directory: Path) -> set[str]:
    excluded: set[str] = set()
    if not directory.exists():
        return excluded
    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("active", True) is False:
            continue
        excluded.update(str(value) for value in data.get("openImagesIds", []) if value)
    return excluded


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_rows(path: Path, rows: list[dict[str, str]]) -> None:
    if not rows:
        raise RuntimeError("No fresh rows survived source-ID exclusion")
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    args = parse_args()
    if args.max_images <= 0:
        raise SystemExit("--max-images must be positive")
    output = args.output.resolve()
    excluded = active_exclusions(args.checkpoints.resolve())
    requested = max(args.max_images, int(round(args.max_images * max(1.0, args.oversample))))
    candidate_limit = max(args.candidate_limit, requested)

    if output.exists():
        shutil.rmtree(output)

    source_tool = Path(__file__).with_name("open_images_face_source.py")
    command = [
        sys.executable,
        str(source_tool),
        str(output),
        "--split", args.split,
        "--cache", str(args.cache),
        "--max-images", str(requested),
        "--candidate-limit", str(candidate_limit),
        "--min-box-area", str(args.min_box_area),
        "--workers", str(args.workers),
        "--seed", args.seed,
    ]
    if args.allow_occluded:
        command.append("--allow-occluded")
    if args.allow_truncated:
        command.append("--allow-truncated")
    subprocess.run(command, check=True)

    metadata_path = output / "metadata.csv"
    rows = read_rows(metadata_path)
    fresh: list[dict[str, str]] = []
    removed: list[dict[str, str]] = []
    for row in rows:
        image_id = row.get("open_images_id", "")
        if image_id in excluded or len(fresh) >= args.max_images:
            removed.append(row)
        else:
            fresh.append(row)

    keep_paths = {row["relative_path"] for row in fresh}
    for path in (output / "images").glob("*"):
        relative = f"images/{path.name}"
        if relative not in keep_paths:
            path.unlink(missing_ok=True)
    write_rows(metadata_path, fresh)

    report_path = output / "source-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["uniqueBatch"] = {
        "seed": args.seed,
        "activeCheckpointIds": len(excluded),
        "oversampledRows": len(rows),
        "excludedPreviouslyPacked": sum(1 for row in rows if row.get("open_images_id", "") in excluded),
        "discardedBeyondBatchLimit": max(0, len(rows) - len(fresh) - sum(
            1 for row in rows if row.get("open_images_id", "") in excluded
        )),
        "freshStaged": len(fresh),
        "requestedFresh": args.max_images,
    }
    report["staged"] = len(fresh)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["uniqueBatch"], indent=2))
    if len(fresh) < args.max_images:
        print(
            f"warning: only {len(fresh)} fresh rows available after exclusions; requested {args.max_images}",
            file=sys.stderr,
        )
    return 0 if fresh else 1


if __name__ == "__main__":
    raise SystemExit(main())
