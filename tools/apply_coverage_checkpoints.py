#!/usr/bin/env python3
"""Apply physically packed supplement checkpoints to a fresh coverage plan.

The base FFHQ catalog remains immutable while collection is in progress. Each
validated supplement batch records exactly one routed coverage gap for every
face that survived final catalog packing. This tool treats those packed faces as
virtual additions so later batches do not keep collecting the same holes.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path, help="Fresh coverage-200k-plan JSON")
    parser.add_argument("output", type=Path, help="Adjusted plan JSON")
    parser.add_argument(
        "--checkpoints",
        type=Path,
        default=Path("data/coverage-checkpoints"),
        help="Directory of validated packed-batch checkpoint JSON files",
    )
    return parser.parse_args()


def load_checkpoints(directory: Path) -> tuple[list[dict[str, Any]], Counter[str], Counter[str], int]:
    documents: list[dict[str, Any]] = []
    gaps: Counter[str] = Counter()
    poses: Counter[str] = Counter()
    packed_total = 0
    if not directory.exists():
        return documents, gaps, poses, packed_total

    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        packed = int(data.get("packedFaces", 0))
        assigned = Counter({str(k): int(v) for k, v in data.get("assignedByGap", {}).items()})
        assigned_total = sum(assigned.values())
        if packed < 0 or assigned_total != packed:
            raise ValueError(
                f"{path}: assignedByGap totals {assigned_total}, expected packedFaces={packed}"
            )
        if not data.get("provenanceComplete", False):
            raise ValueError(f"{path}: provenanceComplete must be true before a checkpoint is applied")
        for key, count in assigned.items():
            pose, separator, configuration = key.partition("|")
            if not separator or not configuration:
                raise ValueError(f"{path}: invalid gap key {key!r}")
            gaps[key] += count
            poses[pose] += count
        packed_total += packed
        documents.append({"path": path.as_posix(), **data})
    return documents, gaps, poses, packed_total


def apply(plan: dict[str, Any], checkpoint_dir: Path) -> dict[str, Any]:
    checkpoints, packed_gaps, packed_poses, packed_total = load_checkpoints(checkpoint_dir)
    base_faces = int(plan.get("currentFaces", 0))
    target_faces = int(plan.get("targetFaces", 0))
    if target_faces < base_faces:
        raise ValueError("targetFaces must be >= currentFaces")
    if base_faces + packed_total > target_faces:
        raise ValueError("Packed checkpoints exceed targetFaces")

    queue: list[dict[str, Any]] = []
    matched_packed = 0
    for original in plan.get("collectionQueue", []):
        item = dict(original)
        pose = str(item.get("pose", ""))
        configuration = str(item.get("configuration", ""))
        key = f"{pose}|{configuration}"
        packed_for_gap = packed_gaps.get(key, 0)
        packed_for_pose = packed_poses.get(pose, 0)
        matched_packed += packed_for_gap

        item["baseCount"] = int(item.get("count", 0))
        item["checkpointCount"] = packed_for_gap
        item["count"] = item["baseCount"] + packed_for_gap
        item["deficit"] = max(0, int(item.get("target", 0)) - item["count"])

        item["basePoseCurrent"] = int(item.get("poseCurrent", 0))
        item["checkpointPoseCount"] = packed_for_pose
        item["poseCurrent"] = item["basePoseCurrent"] + packed_for_pose
        item["poseDeficit"] = max(0, int(item.get("poseTarget", 0)) - item["poseCurrent"])

        # The original allocation sums exactly to targetFaces-currentFaces. A
        # packed face consumes one slot in that allocation and one physical face
        # toward 200k. Subtracting the routed checkpoint count therefore keeps
        # the remaining collection budget exact without inventing new weights.
        item["recommendedAdditions"] = max(
            0,
            int(item.get("recommendedAdditions", 0)) - packed_for_gap,
        )
        item["candidateAttempts"] = max(
            int(item["recommendedAdditions"]),
            int(item.get("candidateAttempts", 0)) - packed_for_gap,
        )
        if item["recommendedAdditions"] > 0:
            queue.append(item)

    unknown = {key: count for key, count in packed_gaps.items() if not any(
        key == f"{item.get('pose')}|{item.get('configuration')}"
        for item in plan.get("collectionQueue", [])
    )}
    if unknown:
        raise ValueError(f"Checkpoint gaps not present in the fresh coverage plan: {unknown}")
    if matched_packed != packed_total:
        raise ValueError(
            f"Matched {matched_packed} checkpoint assignments, expected {packed_total}"
        )

    remaining = target_faces - base_faces - packed_total
    recommended_total = sum(int(item["recommendedAdditions"]) for item in queue)
    if recommended_total != remaining:
        raise ValueError(
            f"Adjusted queue totals {recommended_total}, expected remaining {remaining}. "
            "Regenerate checkpoints against the current base catalog before continuing."
        )

    output = dict(plan)
    output["baseFaces"] = base_faces
    output["checkpointFaces"] = packed_total
    output["currentFaces"] = base_faces + packed_total
    output["neededImages"] = remaining
    output["collectionQueue"] = queue
    output["weakest"] = sorted(
        queue,
        key=lambda item: (
            -float(item.get("pressure", 0)),
            -int(item.get("deficit", 0)),
            str(item.get("pose", "")),
            str(item.get("configuration", "")),
        ),
    )[:12]
    output["checkpointSummary"] = {
        "directory": checkpoint_dir.as_posix(),
        "files": [item["path"] for item in checkpoints],
        "packedFaces": packed_total,
        "assignedGaps": len(packed_gaps),
        "remainingImages": remaining,
    }
    return output


def main() -> int:
    args = parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    adjusted = apply(plan, args.checkpoints)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(adjusted, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "baseFaces": adjusted["baseFaces"],
        "checkpointFaces": adjusted["checkpointFaces"],
        "currentFaces": adjusted["currentFaces"],
        "targetFaces": adjusted["targetFaces"],
        "neededImages": adjusted["neededImages"],
        "queueItems": len(adjusted["collectionQueue"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
