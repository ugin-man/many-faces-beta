#!/usr/bin/env python3
"""Stage a deterministic, non-overlapping window of Open Images face crops.

This is a thin production wrapper around open_images_face_source.py. It keeps a
stable global ordering for a split and slices [candidate_offset,
candidate_offset + max_images), so successive 200k-build batches do not spend
compute on the same source faces again.
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import open_images_face_source as source


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--split", choices=sorted(source.SPLITS), default="train")
    parser.add_argument("--cache", type=Path, default=Path(".cache/open-images"))
    parser.add_argument("--max-images", type=int, default=8000)
    parser.add_argument("--candidate-offset", type=int, default=0)
    parser.add_argument("--candidate-limit", type=int, default=8000)
    parser.add_argument("--max-per-image", type=int, default=1)
    parser.add_argument("--min-box-area", type=float, default=0.006)
    parser.add_argument("--max-box-area", type=float, default=0.70)
    parser.add_argument("--min-aspect", type=float, default=0.42)
    parser.add_argument("--max-aspect", type=float, default=2.40)
    parser.add_argument("--padding", type=float, default=0.55)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--seed", default="many-faces-open-images-v1")
    parser.add_argument("--allow-occluded", action="store_true")
    parser.add_argument("--allow-truncated", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.candidate_offset < 0 or args.max_images <= 0:
        raise SystemExit("candidate offset must be >= 0 and max-images must be > 0")
    needed = args.candidate_offset + args.max_images
    if args.candidate_limit < needed:
        raise SystemExit(
            f"candidate-limit must cover the requested window: need at least {needed}"
        )

    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty. Use --overwrite or choose another directory.")
    if args.overwrite and output.exists():
        import shutil
        shutil.rmtree(output)
    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    cache = args.cache.resolve() / args.split
    resources = source.SPLITS[args.split]
    boxes_path = cache / "boxes.csv"
    metadata_path = cache / "metadata.csv"
    source_report = {
        "split": args.split,
        "humanFaceMid": source.HUMAN_FACE_MID,
        "annotationLicense": source.ANNOTATION_LICENSE,
        "candidateOffset": args.candidate_offset,
        "candidateWindowSize": args.max_images,
        "candidateLimit": args.candidate_limit,
        "sources": {
            "boxes": {
                "url": resources["boxes"],
                **source.download_resource(resources["boxes"], boxes_path),
            },
            "metadata": {
                "url": resources["metadata"],
                **source.download_resource(resources["metadata"], metadata_path),
            },
        },
    }

    boxes, box_stats = source.select_face_boxes(boxes_path, args)
    metadata, metadata_stats = source.load_metadata(
        metadata_path, {box.image_id for box in boxes}
    )
    eligible = [box for box in boxes if box.image_id in metadata]
    start = args.candidate_offset
    end = min(len(eligible), start + args.max_images)
    selected = eligible[start:end]
    source_report.update({
        "boxStats": box_stats,
        "metadataStats": metadata_stats,
        "deterministicCandidates": len(boxes),
        "licensedCandidates": len(eligible),
        "windowStart": start,
        "windowEnd": end,
        "windowAvailable": len(selected),
    })
    if not selected:
        source_report.update({"requested": args.max_images, "downloadAttempts": 0, "staged": 0, "downloadFailures": {}})
        (output / "source-report.json").write_text(json.dumps(source_report, indent=2), encoding="utf-8")
        print(json.dumps(source_report, indent=2))
        return 2

    rows: list[dict[str, str]] = []
    failures: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(
                source.stage_one,
                start + index,
                box,
                metadata[box.image_id],
                args,
                image_dir,
            ): box
            for index, box in enumerate(selected)
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            row, error = future.result()
            if row is not None:
                rows.append(row)
            else:
                failures[error or "unknown"] = failures.get(error or "unknown", 0) + 1
            if completed % 100 == 0 or completed == len(futures):
                print(
                    f"{completed}/{len(futures)} downloaded | "
                    f"{len(rows)} staged | {sum(failures.values())} failed"
                )

    rows.sort(key=lambda row: row["relative_path"])
    source.write_csv(output / "metadata.csv", rows)
    source_report.update({
        "requested": args.max_images,
        "downloadAttempts": len(selected),
        "staged": len(rows),
        "downloadFailures": failures,
    })
    (output / "source-report.json").write_text(
        json.dumps(source_report, indent=2), encoding="utf-8"
    )
    print(json.dumps(source_report, indent=2))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
