#!/usr/bin/env python3
"""Build an honest >=70k Clean Core v3 catalog.

Strict isolated profiles are gated first. A separately labelled one-family
background pool then supplies pose and identity density without pretending to
cover missing strict states.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import io
import json
import math
import re
import shutil
import struct
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from clean_core_policy_v3 import (
    BACKGROUND_MINIMUMS, BACKGROUND_POSE_CELL_MINIMUMS, BACKGROUND_PRIORITY,
    FEATURE_LENGTH, POLICY_VERSION, PROFILE_CELL_LIMITS, PROFILE_GROUPS,
    PROFILE_MINIMUMS, PROFILE_POSE_CELL_MINIMUMS,
    STRICT_PROFILE_PRIORITY, CleanProfile, classify_assignment, quantized_pose_cell,
)

PROFILE_PRIORITY = STRICT_PROFILE_PRIORITY + BACKGROUND_PRIORITY

PACK_TARGET_BYTES = 7_500_000
SHARD_ENTRY_LIMIT = 700
ARTWORK_TERMS = {
    "painting", "painted portrait", "drawing", "illustration", "illustrated", "sketch",
    "engraving", "lithograph", "collage", "cartoon", "comic", "sculpture", "statue",
    "ceramic", "wax figure", "poster artwork", "digital art", "digital collage", "character art",
}
MOUTH_OCCLUSION_TERMS = {
    "eating", "eat ", "food", "candy", "chocolate", "ice cream", "icecream", "spoon",
    "fork", "straw", "drinking", "drink ", "microphone", "singing", "singer", "cigar",
    "cigarette", "smoking", "pipe", "tongue", "lollipop", "toothbrush", "pacifier",
}
# These hide regions required by the matcher regardless of expression profile.
# Ordinary clear eyeglasses and face paint remain allowed.
GLOBAL_FACE_OCCLUSION_TERMS = {
    "sunglasses", "sun glasses", "dark glasses", "shades",
    "face mask", "facemask", "surgical mask", "n95", "kn95", "respirator",
    "balaclava", "ski mask",
}


@dataclass
class SourceCatalog:
    label: str
    root: Path
    manifest: dict[str, Any]
    catalog_id: str
    entries: list[dict[str, Any]]
    handles: dict[str, BinaryIO] = field(default_factory=dict)

    def read_image(self, entry: dict[str, Any]) -> bytes:
        pack = str(entry["pack"])
        handle = self.handles.get(pack)
        if handle is None:
            handle = (self.root / "packs" / pack).open("rb")
            self.handles[pack] = handle
        handle.seek(int(entry["offset"]))
        payload = handle.read(int(entry["length"]))
        if len(payload) != int(entry["length"]):
            raise ValueError(f"{self.catalog_id}:{entry.get('id')}: truncated packed image")
        return payload

    def close(self) -> None:
        for handle in self.handles.values(): handle.close()
        self.handles.clear()


@dataclass
class Candidate:
    source: SourceCatalog
    entry: dict[str, Any]
    profile: CleanProfile
    cell: str
    yaw: int
    pitch: int
    preliminary: float
    tier: str = "strict"
    structure: tuple[float, ...] = ()
    image_bytes: bytes | None = None
    image_sha256: str = ""
    dhash: str = ""
    quality: dict[str, float] = field(default_factory=dict)
    score: float = 0.0

    @property
    def key(self) -> str:
        return f"{self.source.catalog_id}:{self.entry.get('id')}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--catalog", action="append", default=[], metavar="LABEL=PATH")
    parser.add_argument("--target-total", type=int, default=70_000)
    parser.add_argument("--preselect-multiplier", type=int, default=6)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if not args.catalog: parser.error("at least one --catalog LABEL=PATH is required")
    if args.target_total < 70_000: parser.error("target-total must be at least 70,000")
    return args


def parse_catalog_arg(value: str) -> tuple[str, Path]:
    label, sep, raw = value.partition("=")
    if not sep or not label.strip() or not raw.strip():
        raise ValueError(f"invalid --catalog {value!r}")
    return label.strip(), Path(raw).resolve()


def load_catalog(label: str, root: Path) -> SourceCatalog:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 3: raise ValueError(f"{root}: schemaVersion must be 3")
    if int(manifest.get("featureLength", 0)) != FEATURE_LENGTH: raise ValueError(f"{root}: featureLength must be {FEATURE_LENGTH}")
    names = sorted({name for cell in manifest.get("cells", {}).values() for name in (cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))})
    entries: list[dict[str, Any]] = []
    for name in names:
        payload = json.loads((root / "shards" / name).read_text(encoding="utf-8"))
        entries.extend(payload.get("items", []))
    return SourceCatalog(label, root, manifest, str(manifest.get("catalogId") or label), entries)


def decode_vector(encoded: str | None, *, stride: int = 2, limit: int = 96) -> tuple[float, ...]:
    if not encoded: return ()
    try:
        payload = base64.b64decode(encoded)
        raw = struct.unpack(f"<{len(payload)//2}h", payload)
        return tuple(value / 4096.0 for value in raw[::max(1, stride)][:limit])
    except Exception:
        return ()


def title_rejection(entry: dict[str, Any], profile: CleanProfile) -> str | None:
    text = str(entry.get("name", "")).lower()
    if any(term in text for term in ARTWORK_TERMS): return "likely_artwork"
    if any(term in text for term in GLOBAL_FACE_OCCLUSION_TERMS): return "face_occlusion_title"
    if "mouth" in profile.group and any(term in text for term in MOUTH_OCCLUSION_TERMS): return "mouth_occlusion_title"
    return None
