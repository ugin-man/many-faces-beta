#!/usr/bin/env python3
"""Build a small, full-pose runtime catalog for browser verification.

The production catalog stays untouched.  Each pose cell contributes a bounded,
deterministically spread sample of entries.  Selected WebP byte ranges are
repacked so the resulting artifact contains no unused production images.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--per-cell", type=int, default=8)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    args.per_cell = max(1, min(64, args.per_cell))
    return args


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_token(value: str) -> str:
    token = value.replace("-", "n").replace(":", "_").replace("+", "p")
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", token)


def spread_indices(length: int, limit: int) -> list[int]:
    if length <= limit:
        return list(range(length))
    if limit == 1:
        return [length // 2]
    values = {
        min(length - 1, max(0, round(index * (length - 1) / (limit - 1))))
        for index in range(limit)
    }
    if len(values) < limit:
        for index in range(length):
            values.add(index)
            if len(values) >= limit:
                break
    return sorted(values)[:limit]


def load_cell_items(source: Path, cell: dict[str, Any]) -> list[dict[str, Any]]:
    files = cell.get("shards") or ([cell["shard"]] if cell.get("shard") else [])
    items: list[dict[str, Any]] = []
    for filename in files:
        payload = read_json(source / "shards" / filename)
        items.extend(payload.get("items") or [])
    return items


def copy_direct_image(
    source: Path,
    output: Path,
    item: dict[str, Any],
    copied: dict[str, str],
) -> None:
    image = str(item.get("image") or "")
    if not image:
        return
    if image in copied:
        item["image"] = copied[image]
        return
    original = source / "images" / image
    if not original.is_file():
        raise FileNotFoundError(f"Direct image is missing: {original}")
    digest = hashlib.sha256(original.read_bytes()).hexdigest()[:20]
    suffix = original.suffix.lower() or ".webp"
    target_name = f"verify_{digest}{suffix}"
    target = output / "images" / target_name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(original, target)
    copied[image] = target_name
    item["image"] = target_name


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not (source / "manifest.json").is_file():
        raise SystemExit(f"Manifest not found: {source / 'manifest.json'}")
    if output.exists():
        if not args.overwrite:
            raise SystemExit(f"Output exists: {output}")
        shutil.rmtree(output)
    (output / "shards").mkdir(parents=True)
    (output / "packs").mkdir(parents=True)

    manifest = read_json(source / "manifest.json")
    source_cells = manifest.get("cells") or {}
    compact_cells: dict[str, dict[str, Any]] = {}
    pack_handles: dict[str, Any] = {}
    pack_sizes: dict[str, int] = {}
    copied_images: dict[str, str] = {}
    selected_total = 0
    source_total = 0
    image_bytes = 0

    try:
        for cell_key in sorted(source_cells, key=lambda value: tuple(map(int, value.split(":")))):
            cell = source_cells[cell_key]
            items = load_cell_items(source, cell)
            source_total += len(items)
            indices = spread_indices(len(items), args.per_cell)
            selected = [copy.deepcopy(items[index]) for index in indices]
            if not selected:
                continue

            token = safe_token(cell_key)
            shard_name = f"verify_{token}_000.json"
            pack_name = f"verify_{token}.bin"
            pack_path = output / "packs" / pack_name
            pack_handle = pack_path.open("wb")
            pack_handles[pack_name] = pack_handle
            offset = 0

            for item in selected:
                direct_image = item.get("image")
                if direct_image:
                    copy_direct_image(source, output, item, copied_images)
                    continue
                original_pack = str(item.get("pack") or "")
                length = int(item.get("length") or 0)
                original_offset = int(item.get("offset") or 0)
                if not original_pack or length <= 0 or original_offset < 0:
                    raise ValueError(f"Invalid packed item in {cell_key}: {item.get('id')}")
                original_path = source / "packs" / original_pack
                with original_path.open("rb") as original:
                    original.seek(original_offset)
                    payload = original.read(length)
                if len(payload) != length:
                    raise IOError(
                        f"Short range for {item.get('id')}: {len(payload)} != {length}"
                    )
                pack_handle.write(payload)
                item["pack"] = pack_name
                item["offset"] = offset
                item["length"] = length
                offset += length
                image_bytes += length

            pack_handle.close()
            pack_handles.pop(pack_name, None)
            pack_sizes[pack_name] = offset
            (output / "shards" / shard_name).write_text(
                json.dumps({"items": selected}, ensure_ascii=False, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            compact_cells[cell_key] = {
                "count": len(selected),
                "shards": [shard_name],
            }
            selected_total += len(selected)
    finally:
        for handle in pack_handles.values():
            handle.close()

    compact = copy.deepcopy(manifest)
    compact["catalogId"] = (
        f"{manifest.get('catalogId', 'many-faces')}-verification-{args.per_cell}pc"
    )
    compact["generatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    compact["totalFaces"] = selected_total
    compact["sourceFaces"] = selected_total
    compact["searchableFaces"] = selected_total
    compact["indexFiles"] = []
    compact["cells"] = compact_cells
    stats = compact.setdefault("stats", {})
    clean = stats.setdefault("cleanCore", {})
    clean["runtimeImagePolicy"] = "real-photo-only-v1"
    clean["knownSyntheticFaces"] = 0
    stats["verificationCompact"] = {
        "sourceCatalogId": manifest.get("catalogId"),
        "sourceFacesObserved": source_total,
        "perCellLimit": args.per_cell,
        "selectedFaces": selected_total,
        "poseCells": len(compact_cells),
        "packedImageBytes": image_bytes,
        "packCount": len(pack_sizes),
    }
    (output / "manifest.json").write_text(
        json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    report = {
        "schemaVersion": 1,
        "sourceCatalogId": manifest.get("catalogId"),
        "catalogId": compact["catalogId"],
        "sourceFacesObserved": source_total,
        "selectedFaces": selected_total,
        "poseCells": len(compact_cells),
        "perCellLimit": args.per_cell,
        "packedImageBytes": image_bytes,
        "packCount": len(pack_sizes),
        "largestPackBytes": max(pack_sizes.values(), default=0),
        "estimatedMegabytes": math.ceil(image_bytes / (1024 * 1024)),
        "knownSyntheticFaces": 0,
    }
    (output / "verification-catalog-report.json").write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
