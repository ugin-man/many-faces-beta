#!/usr/bin/env python3
"""Read-only structural audit for the full Many Faces seed catalog.

This deliberately audits the 70k asset as it exists. It does not build a
subset, rewrite shards, or make a quality claim from metadata alone.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import statistics
from pathlib import Path
from typing import Any, Iterable


def percentile(values: list[int | float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return float(ordered[index])


def summary(values: Iterable[int | float]) -> dict[str, float]:
    data = list(values)
    if not data:
        return {"min": 0, "median": 0, "p95": 0, "max": 0, "mean": 0}
    return {
        "min": float(min(data)),
        "median": float(statistics.median(data)),
        "p95": percentile(data, 0.95),
        "max": float(max(data)),
        "mean": float(statistics.fmean(data)),
    }


def compact_json_bytes(value: Any) -> int:
    if value is None:
        return 0
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def feature_signature(feature: Any, digits: int) -> str | None:
    if not isinstance(feature, list) or not feature:
        return None
    try:
        normalized = tuple(round(float(value), digits) for value in feature)
    except (TypeError, ValueError):
        return None
    return hashlib.blake2b(repr(normalized).encode(), digest_size=12).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("catalog", nargs="?", default="public/seed-catalog")
    parser.add_argument("--output", default="work/astra-evidence/catalog-audit.json")
    args = parser.parse_args()

    root = Path(args.catalog)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    cells = manifest.get("cells") or {}

    shard_to_cells: dict[str, list[str]] = collections.defaultdict(list)
    for cell_key, cell in cells.items():
        names = cell.get("shards") or ([cell.get("shard")] if cell.get("shard") else [])
        for name in names:
            shard_to_cells[str(name)].append(str(cell_key))

    shard_names = sorted(shard_to_cells)
    source_counts: collections.Counter[str] = collections.Counter()
    source_bytes: collections.Counter[str] = collections.Counter()
    pack_refs: collections.Counter[str] = collections.Counter()
    feature_lengths: collections.Counter[int] = collections.Counter()
    exact_ids: set[str] = set()
    duplicate_ids: list[str] = []
    quantized_2: collections.Counter[str] = collections.Counter()
    quantized_3: collections.Counter[str] = collections.Counter()
    shard_item_counts: list[int] = []
    shard_file_bytes: list[int] = []
    image_lengths: list[int] = []
    cell_counts: collections.Counter[str] = collections.Counter()

    item_count = 0
    geometry_json_bytes = 0
    feature_json_bytes = 0
    item_json_bytes = 0
    image_referenced_bytes = 0
    missing_geometry = 0
    missing_feature = 0
    missing_image_reference = 0
    malformed_shards: list[str] = []

    for shard_name in shard_names:
        path = root / "shards" / shard_name
        if not path.is_file():
            malformed_shards.append(shard_name)
            continue
        shard_file_bytes.append(path.stat().st_size)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            malformed_shards.append(shard_name)
            continue
        items = payload.get("items")
        if not isinstance(items, list):
            malformed_shards.append(shard_name)
            continue
        shard_item_counts.append(len(items))
        owners = shard_to_cells.get(shard_name) or ["unknown"]
        for owner in owners:
            cell_counts[owner] += len(items)

        for item in items:
            if not isinstance(item, dict):
                continue
            item_count += 1
            identifier = str(item.get("id") or "")
            if identifier:
                if identifier in exact_ids and len(duplicate_ids) < 100:
                    duplicate_ids.append(identifier)
                exact_ids.add(identifier)

            source = str(item.get("sourceName") or item.get("source") or item.get("dataset") or "unknown")
            source_counts[source] += 1

            geometry = item.get("geometry")
            feature = item.get("feature")
            geometry_size = compact_json_bytes(geometry)
            feature_size = compact_json_bytes(feature)
            geometry_json_bytes += geometry_size
            feature_json_bytes += feature_size
            item_size = compact_json_bytes(item)
            item_json_bytes += item_size
            source_bytes[source] += item_size
            if not geometry:
                missing_geometry += 1
            if not isinstance(feature, list) or not feature:
                missing_feature += 1
            else:
                feature_lengths[len(feature)] += 1
                for digits, counter in ((2, quantized_2), (3, quantized_3)):
                    signature = feature_signature(feature, digits)
                    if signature:
                        counter[signature] += 1

            pack = item.get("pack")
            image = item.get("image")
            length = item.get("length")
            if pack:
                pack_refs[str(pack)] += 1
            if isinstance(length, int) and length > 0:
                image_lengths.append(length)
                image_referenced_bytes += length
            elif not image:
                missing_image_reference += 1

    unique_pack_sizes: dict[str, int | None] = {}
    for pack in sorted(pack_refs):
        path = root / "packs" / pack
        unique_pack_sizes[pack] = path.stat().st_size if path.is_file() else None
    present_pack_sizes = [value for value in unique_pack_sizes.values() if value is not None]

    def collision_report(counter: collections.Counter[str]) -> dict[str, Any]:
        repeated = [count for count in counter.values() if count > 1]
        return {
            "uniqueBuckets": len(counter),
            "itemsInRepeatedBuckets": sum(repeated),
            "repeatedBuckets": len(repeated),
            "largestBucket": max(counter.values(), default=0),
        }

    shard_payload_bytes = sum(shard_file_bytes)
    report = {
        "schemaVersion": 1,
        "readOnlyAudit": True,
        "catalog": {
            "catalogId": manifest.get("catalogId"),
            "declaredFaces": manifest.get("totalFaces"),
            "searchableFaces": manifest.get("searchableFaces"),
            "observedItems": item_count,
            "uniqueIds": len(exact_ids),
            "duplicateIdExamples": duplicate_ids,
            "poseStep": manifest.get("poseStep"),
            "poseCells": len(cells),
            "shards": len(shard_names),
            "indexFiles": manifest.get("indexFiles") or [],
            "indexComplete": bool(manifest.get("indexComplete")),
            "allShardsContainGeometry": manifest.get("allShardsContainGeometry"),
        },
        "payload": {
            "shardFileBytes": shard_payload_bytes,
            "geometryJsonBytesInsideItems": geometry_json_bytes,
            "featureJsonBytesInsideItems": feature_json_bytes,
            "itemJsonBytes": item_json_bytes,
            "geometryShareOfItemJson": geometry_json_bytes / item_json_bytes if item_json_bytes else 0,
            "geometryShareOfShardFiles": geometry_json_bytes / shard_payload_bytes if shard_payload_bytes else 0,
            "referencedImageBytes": image_referenced_bytes,
            "uniquePackFileBytes": sum(present_pack_sizes),
            "declaredImagePackBytes": manifest.get("imagePackBytes"),
        },
        "distributions": {
            "itemsPerShard": summary(shard_item_counts),
            "itemsPerPoseCell": summary(cell_counts.values()),
            "imageEncodedBytes": summary(image_lengths),
            "packFileBytes": summary(present_pack_sizes),
            "featureLengths": dict(sorted(feature_lengths.items())),
        },
        "sourceCounts": source_counts.most_common(),
        "sourcePayloadBytes": source_bytes.most_common(),
        "featureRedundancySignals": {
            "rounded2Decimals": collision_report(quantized_2),
            "rounded3Decimals": collision_report(quantized_3),
            "note": "Collisions are a redundancy signal only; they do not prove visually duplicate faces.",
        },
        "integrity": {
            "missingGeometry": missing_geometry,
            "missingFeature": missing_feature,
            "missingImageReference": missing_image_reference,
            "missingPackFiles": sorted(pack for pack, size in unique_pack_sizes.items() if size is None),
            "malformedOrMissingShards": malformed_shards,
        },
        "runtimeDesignSignals": {
            "hasSidecarIndex": bool(manifest.get("indexFiles")),
            "coarseAndDetailedGeometryCoLocated": bool(manifest.get("allShardsContainGeometry")),
            "uniquePacksReferenced": len(pack_refs),
            "largestPackReferenceCount": max(pack_refs.values(), default=0),
        },
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    declared = manifest.get("totalFaces")
    if isinstance(declared, int) and declared != item_count:
        print(f"WARNING: manifest declares {declared} faces but {item_count} shard items were observed")
    if malformed_shards or duplicate_ids:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
