#!/usr/bin/env python3
"""Create an exact coverage checkpoint from a validated packed supplement.

Only faces that actually survived final packing are counted. Packed shard
provenance is joined back to the curated metadata by source URL so the output
contains the exact Open Images IDs and routed coverage cells consumed by the
batch.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("accepted_metadata", type=Path)
    parser.add_argument("supplement", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", default="Open Images")
    parser.add_argument("--split", default="")
    parser.add_argument("--workflow-run-id", type=int, default=0)
    parser.add_argument("--head-commit", default="")
    parser.add_argument("--staged", type=int, default=0)
    parser.add_argument("--curation-accepted", type=int, default=0)
    return parser.parse_args()


def load_rows(path: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            source_url = str(row.get("source_url", "")).strip()
            if not source_url:
                continue
            if source_url in rows:
                raise ValueError(f"Duplicate source_url in accepted metadata: {source_url}")
            rows[source_url] = {key: str(value or "").strip() for key, value in row.items()}
    return rows


def iter_items(supplement: Path):
    for path in sorted((supplement / "shards").glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        items = document.get("items", document if isinstance(document, list) else [])
        if not isinstance(items, list):
            raise ValueError(f"Unexpected shard shape: {path}")
        for item in items:
            yield path, item


def main() -> int:
    args = parse_args()
    manifest_path = args.supplement / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"Missing supplement manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = load_rows(args.accepted_metadata)

    assigned: Counter[str] = Counter()
    source_ids: list[str] = []
    seen_source_ids: set[str] = set()
    packed = 0
    provenance_complete = True

    for shard_path, item in iter_items(args.supplement):
        packed += 1
        source_url = str(item.get("sourceUrl", "")).strip()
        row = rows.get(source_url)
        if row is None:
            raise ValueError(f"{shard_path}: packed source URL missing from accepted metadata: {source_url}")
        pose = row.get("target_pose", "").strip()
        configuration = row.get("target_configuration", "").strip()
        if not pose or not configuration:
            raise ValueError(f"Packed face has no routed gap: {source_url}")
        assigned[f"{pose}|{configuration}"] += 1

        source_id = row.get("open_images_id", "").strip()
        if source_id:
            if source_id in seen_source_ids:
                raise ValueError(f"Duplicate packed Open Images ID: {source_id}")
            seen_source_ids.add(source_id)
            source_ids.append(source_id)

        provenance_complete = provenance_complete and all(
            str(item.get(key, "")).strip()
            for key in ("sourceUrl", "creator", "license", "licenseUrl")
        )

    searchable = int(manifest.get("searchableFaces", manifest.get("totalFaces", 0)))
    if packed != searchable:
        raise ValueError(f"Read {packed} packed entries, manifest says {searchable}")
    if sum(assigned.values()) != packed:
        raise ValueError("Coverage assignment total does not equal packed face count")
    if not provenance_complete:
        raise ValueError("Packed supplement contains incomplete provenance")

    output: dict[str, Any] = {
        "schemaVersion": 2,
        "active": True,
        "source": args.source,
        "split": args.split,
        "workflowRunId": args.workflow_run_id or None,
        "artifactId": None,
        "artifactSha256": None,
        "headCommit": args.head_commit or None,
        "staged": args.staged,
        "curationAccepted": args.curation_accepted,
        "packedFaces": packed,
        "poseCells": len(manifest.get("cells", {})),
        "provenanceComplete": True,
        "sourceIds": sorted(source_ids),
        "assignedByGap": dict(sorted(assigned.items())),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "packedFaces": packed,
        "sourceIds": len(source_ids),
        "assignedGaps": len(assigned),
        "provenanceComplete": True,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
