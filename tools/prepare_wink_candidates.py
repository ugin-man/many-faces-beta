#!/usr/bin/env python3
"""Put existing independent wink photographs into the ordinary admission pool.

This copies the exact encoded pixels and their provenance into a deterministic
schema-3 source catalog. It does not certify or reserve any of these candidates.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from clean_core_policy_v3 import quantized_pose_cell


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.out.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("Output must be empty")
    source_bytes = (source / "catalog.json").read_bytes()
    document = json.loads(source_bytes)
    additions = sorted((entry for entry in document["items"] if entry.get("image")), key=lambda entry: entry["id"])
    if len(additions) != int(document.get("addedPhotographs", -1)):
        raise ValueError("Wink addition count differs from source metadata")
    (output / "packs").mkdir(parents=True, exist_ok=True)
    (output / "shards").mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[dict]] = {}
    with (output / "packs/wink-candidates.bin").open("wb") as pack:
        for original in additions:
            filename = original["image"]
            if Path(filename).name != filename:
                raise ValueError("Unsafe wink image path")
            payload = (source / "images" / filename).read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            expected = original.get("imageSha256") or original.get("sha256")
            if expected is not None and digest != expected:
                raise ValueError("Wink source pixels differ from their recorded hash")
            entry = {key: value for key, value in original.items() if key not in ("image", "kind")}
            entry.update(pack="wink-candidates.bin", offset=pack.tell(), length=len(payload))
            pack.write(payload)
            cell = quantized_pose_cell(entry["feature"], 3)[0]
            groups.setdefault(cell, []).append(entry)
    cells = {}
    for index, (cell, entries) in enumerate(sorted(groups.items())):
        filename = f"wink-candidates-{index:03d}.json"
        write_json(output / "shards" / filename, {"cell": cell, "items": entries})
        cells[cell] = {"count": len(entries), "shards": [filename]}
    write_json(output / "manifest.json", {
        "schemaVersion": 3, "catalogId": "wink-exact-source-" + hashlib.sha256(source_bytes).hexdigest()[:16],
        "totalFaces": len(additions), "sourceFaces": len(additions), "searchableFaces": len(additions),
        "poseStep": 3, "featureLength": 55, "featureSchema": "mediapipe-face-actions-v2",
        "shapeVersion": "mediapipe-projection-468-v4", "shardsContainGeometry": True,
        "indexFiles": [], "cells": cells, "candidateAdmissionPerformed": False,
    })
    print(json.dumps({"candidatePhotographs": len(additions), "sourceCatalogSha256": hashlib.sha256(source_bytes).hexdigest()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
