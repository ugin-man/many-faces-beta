#!/usr/bin/env python3
"""Build a compact, high-quality single-factor Many Faces core catalog."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import io
import json
import math
import os
import re
import shutil
import struct
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from clean_core_policy import (
    FEATURE_LENGTH,
    POLICY_VERSION,
    PROFILE_CELL_LIMITS,
    PROFILE_GROUPS,
    PROFILE_PRIORITY,
    CleanProfile,
    classify_clean_profile,
    quantized_pose_cell,
)

PACK_TARGET_BYTES = 7_500_000
SHARD_ENTRY_LIMIT = 700
ARTWORK_TERMS = {
    "painting", "painted portrait", "drawing", "illustration", "illustrated",
    "sketch", "engraving", "lithograph", "collage", "cartoon", "comic",
    "sculpture", "statue", "ceramic", "wax figure", "poster artwork",
    "digital art", "digital collage", "character art",
}
MOUTH_OCCLUSION_TERMS = {
    "eating", "eat ", "food", "candy", "chocolate", "ice cream", "icecream",
    "spoon", "fork", "straw", "drinking", "drink ", "microphone", "singing",
    "singer", "cigar", "cigarette", "smoking", "pipe", "tongue", "lollipop",
    "toothbrush", "pacifier", "mask", "face paint", "clown",
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
        for handle in self.handles.values():
            handle.close()
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
    image_bytes: bytes | None = None
    image_sha256: str = ""
    dhash: str = ""
    quality: dict[str, float] = field(default_factory=dict)
    score: float = 0.0
    structure: tuple[float, ...] = ()
    reject_reason: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--catalog",
        action="append",
        default=[],
        metavar="LABEL=PATH",
        help="Source catalog; may be repeated",
    )
    parser.add_argument("--max-total", type=int, default=0, help="0 keeps every quota-selected image")
    parser.add_argument("--preselect-multiplier", type=int, default=10)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if not args.catalog:
        parser.error("at least one --catalog LABEL=PATH is required")
    if args.preselect_multiplier < 2:
        parser.error("--preselect-multiplier must be at least 2")
    return args


def parse_catalog_arg(value: str) -> tuple[str, Path]:
    label, separator, raw_path = value.partition("=")
    if not separator or not label.strip() or not raw_path.strip():
        raise ValueError(f"invalid --catalog {value!r}; expected LABEL=PATH")
    return label.strip(), Path(raw_path).resolve()


def load_catalog(label: str, root: Path) -> SourceCatalog:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 3:
        raise ValueError(f"{root}: schemaVersion must be 3")
    if int(manifest.get("featureLength", 0)) != FEATURE_LENGTH:
        raise ValueError(f"{root}: featureLength must be {FEATURE_LENGTH}")
    names = sorted({
        name
        for cell in manifest.get("cells", {}).values()
        for name in (cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))
    })
    entries: list[dict[str, Any]] = []
    for name in names:
        payload = json.loads((root / "shards" / name).read_text(encoding="utf-8"))
        entries.extend(payload.get("items", []))
    catalog_id = str(manifest.get("catalogId") or label)
    return SourceCatalog(label=label, root=root, manifest=manifest, catalog_id=catalog_id, entries=entries)


def decode_vector(encoded: str | None, *, stride: int = 1, limit: int = 96) -> tuple[float, ...]:
    if not encoded:
        return ()
    try:
        payload = base64.b64decode(encoded)
        if len(payload) % 2:
            return ()
        raw = struct.unpack(f"<{len(payload) // 2}h", payload)
        values = tuple(value / 4096.0 for value in raw[::max(1, stride)][:limit])
        return values
    except (ValueError, struct.error):
        return ()


def title_rejection(entry: dict[str, Any], profile: CleanProfile) -> str | None:
    text = str(entry.get("name", "")).lower()
    if any(term in text for term in ARTWORK_TERMS):
        return "likely_artwork"
    if profile.group == "mouth" and any(term in text for term in MOUTH_OCCLUSION_TERMS):
        return "mouth_occlusion_title"
    return None


def layout_score(entry: dict[str, Any]) -> float:
    layout = entry.get("layout")
    if not isinstance(layout, list) or len(layout) != 4:
        return 0.0
    center_x, center_y, width, height = (float(value) for value in layout)
    center = 1.0 - min(1.0, abs(center_x - 0.5) / 0.24 + abs(center_y - 0.52) / 0.26)
    size = min(1.0, max(0.0, (min(width, height) - 0.42) / 0.28))
    return max(0.0, center * 0.46 + size * 0.54)


def source_bonus(source: SourceCatalog, entry: dict[str, Any]) -> float:
    text = " ".join((
        source.label,
        source.catalog_id,
        str(entry.get("sourceName", "")),
    )).lower()
    if "ffhq" in text:
        return 0.42
    if "open images" in text:
        return 0.00
    return 0.08


def preliminary_score(source: SourceCatalog, entry: dict[str, Any], profile: CleanProfile) -> float:
    roll = abs(profile.roll)
    roll_score = max(0.0, 1.0 - max(0.0, roll - 36) / 54)
    return (
        profile.purity * 0.58
        + min(1.0, profile.strength) * 0.16
        + layout_score(entry) * 0.12
        + source_bonus(source, entry)
        + roll_score * 0.04
    )


def image_metrics(payload: bytes) -> tuple[dict[str, float], str]:
    with Image.open(io.BytesIO(payload)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    pixels = np.asarray(image.resize((128, 128), Image.Resampling.BILINEAR), dtype=np.float32)
    gray = pixels[:, :, 0] * 0.299 + pixels[:, :, 1] * 0.587 + pixels[:, :, 2] * 0.114
    laplacian = (
        -4 * gray
        + np.roll(gray, 1, axis=0)
        + np.roll(gray, -1, axis=0)
        + np.roll(gray, 1, axis=1)
        + np.roll(gray, -1, axis=1)
    )[1:-1, 1:-1]
    red_green = pixels[:, :, 0] - pixels[:, :, 1]
    yellow_blue = (pixels[:, :, 0] + pixels[:, :, 1]) / 2 - pixels[:, :, 2]
    colorfulness = math.sqrt(float(red_green.var() + yellow_blue.var())) + 0.3 * math.sqrt(
        float(red_green.mean() ** 2 + yellow_blue.mean() ** 2)
    )
    hash_pixels = np.asarray(image.convert("L").resize((9, 8), Image.Resampling.BILINEAR))
    bits = hash_pixels[:, 1:] > hash_pixels[:, :-1]
    hash_value = sum(int(bit) << index for index, bit in enumerate(bits.reshape(-1)))
    return {
        "sharpness": float(laplacian.var()),
        "brightness": float(gray.mean()),
        "contrast": float(gray.std()),
        "colorfulness": colorfulness,
        "clippedFraction": float(((gray < 8) | (gray > 247)).mean()),
    }, f"{hash_value:016x}"


def quality_decision(source: SourceCatalog, metrics: dict[str, float]) -> tuple[bool, str, float]:
    source_text = f"{source.label} {source.catalog_id}".lower()
    is_ffhq = "ffhq" in source_text
    sharp_min = 28.0 if is_ffhq else 55.0
    contrast_min = 20.0 if is_ffhq else 28.0
    color_min = 0.0 if is_ffhq else 7.0
    brightness_min = 32.0 if is_ffhq else 42.0
    brightness_max = 222.0 if is_ffhq else 210.0
    clip_max = 0.46 if is_ffhq else 0.36

    if metrics["sharpness"] < sharp_min:
        return False, "blur", 0.0
    if not brightness_min <= metrics["brightness"] <= brightness_max:
        return False, "brightness", 0.0
    if metrics["contrast"] < contrast_min:
        return False, "low_contrast", 0.0
    if metrics["colorfulness"] < color_min:
        return False, "low_colorfulness", 0.0
    if metrics["clippedFraction"] > clip_max:
        return False, "clipping", 0.0

    sharp = min(1.0, math.log1p(metrics["sharpness"]) / math.log1p(720.0))
    brightness = max(0.0, 1.0 - abs(metrics["brightness"] - 118.0) / 118.0)
    contrast = min(1.0, metrics["contrast"] / 68.0)
    color = min(1.0, metrics["colorfulness"] / 58.0)
    clipping = max(0.0, 1.0 - metrics["clippedFraction"] / max(clip_max, 1e-6))
    score = sharp * 0.34 + brightness * 0.18 + contrast * 0.24 + color * 0.10 + clipping * 0.14
    return True, "", score


def hamming(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def structure_distance(left: Sequence[float], right: Sequence[float]) -> float:
    length = min(len(left), len(right))
    if not length:
        return 0.0
    total = sum((left[index] - right[index]) ** 2 for index in range(length))
    return min(1.0, math.sqrt(total / length) / 0.24)


def creator_key(candidate: Candidate) -> str:
    return str(candidate.entry.get("creator", "")).strip().lower()


def rank_diverse(candidates: list[Candidate], limit: int) -> list[Candidate]:
    if not candidates or limit <= 0:
        return []
    remaining = sorted(candidates, key=lambda item: (-item.score, item.source.catalog_id, str(item.entry.get("id"))))
    selected: list[Candidate] = []
    creator_counts: Counter[str] = Counter()
    hashes: list[str] = []
    while remaining and len(selected) < limit:
        best_index = -1
        best_value = -10.0
        for index, candidate in enumerate(remaining[:240]):
            if any(hamming(candidate.dhash, previous) <= 3 for previous in hashes):
                continue
            if selected:
                diversity = min(
                    structure_distance(candidate.structure, previous.structure)
                    for previous in selected
                )
            else:
                diversity = 1.0
            creator = creator_key(candidate)
            repeat_penalty = min(0.18, creator_counts[creator] * 0.06) if creator else 0.0
            value = candidate.score + diversity * 0.26 - repeat_penalty
            if value > best_value:
                best_value = value
                best_index = index
        if best_index < 0:
            break
        chosen = remaining.pop(best_index)
        selected.append(chosen)
        hashes.append(chosen.dhash)
        creator = creator_key(chosen)
        if creator:
            creator_counts[creator] += 1
    return selected


def pose_token(value: int) -> str:
    return f"p{value:03d}" if value >= 0 else f"n{abs(value):03d}"


def safe_slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized[:28] or "source"


def write_contact_sheet(path: Path, profile: str, items: list[Candidate]) -> None:
    if not items:
        return
    # Favor pose spread first, then score.
    ordered = sorted(items, key=lambda item: (-item.score, item.yaw, item.pitch))
    chosen: list[Candidate] = []
    seen_cells: set[str] = set()
    for candidate in ordered:
        if candidate.cell not in seen_cells:
            chosen.append(candidate)
            seen_cells.add(candidate.cell)
        if len(chosen) >= 24:
            break
    if len(chosen) < 24:
        for candidate in ordered:
            if candidate not in chosen:
                chosen.append(candidate)
            if len(chosen) >= 24:
                break

    width, height = 168, 188
    sheet = Image.new("RGB", (width * 6, height * 4), "white")
    draw = ImageDraw.Draw(sheet)
    for index, candidate in enumerate(chosen):
        with Image.open(io.BytesIO(candidate.image_bytes or b"")) as opened:
            image = ImageOps.fit(ImageOps.exif_transpose(opened).convert("RGB"), (width, width))
        x, y = index % 6 * width, index // 6 * height
        sheet.paste(image, (x, y))
        draw.text(
            (x + 3, y + width + 2),
            f"{candidate.yaw:+d},{candidate.pitch:+d}  {candidate.score:.2f}",
            fill="black",
        )
    sheet.save(path, "JPEG", quality=88, optimize=True)


def build_review_html(
    path: Path,
    selected_by_profile: dict[str, list[Candidate]],
    audit: dict[str, Any],
) -> None:
    cards = []
    for profile in PROFILE_PRIORITY:
        items = selected_by_profile.get(profile, [])
        if not items:
            continue
        cards.append(
            f"<section><h2>{html.escape(profile)} <small>{len(items):,} images / "
            f"{len({item.cell for item in items}):,} pose cells</small></h2>"
            f"<img src='contact-sheets/{html.escape(profile)}.jpg' alt='{html.escape(profile)} samples'></section>"
        )
    path.write_text(
        """<!doctype html><html lang='en'><head><meta charset='utf-8'>
<title>Many Faces clean core v1 review</title>
<style>body{{font:16px system-ui;margin:24px;background:#f5f5f5;color:#111}}
header,section{{background:white;padding:18px;margin:0 0 18px;border-radius:12px}}
img{{max-width:100%;height:auto;border-radius:8px}}small{{font-weight:400;color:#555}}
code{{background:#eee;padding:2px 5px;border-radius:4px}}</style></head><body>
<header><h1>Many Faces clean core v1</h1>
<p>Isolated single-factor states at 3-degree yaw/pitch cells. Mixed eye + mouth
states are intentionally excluded from this first clean pass.</p>
<p><code>{count:,}</code> selected images from <code>{input_count:,}</code> indexed candidates.</p></header>
{cards}</body></html>""".format(
            count=audit["selectedFaces"],
            input_count=audit["inputEntries"],
            cards="\n".join(cards),
        ),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty. Use --overwrite or choose another directory.")
    if args.overwrite and output.exists():
        shutil.rmtree(output)
    catalog_output = output / "catalog"
    packs_output = catalog_output / "packs"
    shards_output = catalog_output / "shards"
    review_output = output / "review"
    sheets_output = review_output / "contact-sheets"
    packs_output.mkdir(parents=True, exist_ok=True)
    shards_output.mkdir(parents=True, exist_ok=True)
    sheets_output.mkdir(parents=True, exist_ok=True)

    sources = [load_catalog(*parse_catalog_arg(value)) for value in args.catalog]
    rejects: Counter[str] = Counter()
    classified: Counter[str] = Counter()
    input_entries = sum(len(source.entries) for source in sources)
    groups: dict[tuple[str, str], list[Candidate]] = defaultdict(list)

    try:
        for source in sources:
            for entry in source.entries:
                feature = entry.get("feature")
                if not isinstance(feature, list) or len(feature) != FEATURE_LENGTH:
                    rejects["invalid_feature"] += 1
                    continue
                if not all(math.isfinite(float(value)) for value in feature):
                    rejects["invalid_feature"] += 1
                    continue
                profile = classify_clean_profile(feature, entry.get("projection"))
                if profile is None:
                    rejects["mixed_or_unsupported_state"] += 1
                    continue
                title_reason = title_rejection(entry, profile)
                if title_reason:
                    rejects[title_reason] += 1
                    continue
                cell, yaw, pitch = quantized_pose_cell(feature, 3)
                candidate = Candidate(
                    source=source,
                    entry=entry,
                    profile=profile,
                    cell=cell,
                    yaw=yaw,
                    pitch=pitch,
                    preliminary=preliminary_score(source, entry, profile),
                    structure=decode_vector(entry.get("shape"), stride=2, limit=96),
                )
                groups[(profile.name, cell)].append(candidate)
                classified[profile.name] += 1

        # Decode only the strongest candidates in every profile/cell. This keeps
        # the full 70k scan bounded while leaving enough fallbacks for quality
        # rejection and identity diversity.
        evaluated_groups: dict[tuple[str, str], list[Candidate]] = {}
        exact_hashes: set[str] = set()
        source_urls: set[str] = set()
        for key, candidates in sorted(groups.items()):
            profile_name = key[0]
            cell_limit = PROFILE_CELL_LIMITS[profile_name]
            preselect = max(cell_limit * args.preselect_multiplier, cell_limit + 8)
            ranked = sorted(
                candidates,
                key=lambda item: (-item.preliminary, item.source.catalog_id, str(item.entry.get("id"))),
            )[:preselect]
            accepted: list[Candidate] = []
            for candidate in ranked:
                source_url = str(candidate.entry.get("sourceUrl", "")).strip()
                source_name = str(candidate.entry.get("sourceName", "")).lower()
                unique_url = source_url if source_url and "ffhq" not in source_name else ""
                if unique_url and unique_url in source_urls:
                    rejects["duplicate_source_url"] += 1
                    continue
                try:
                    payload = candidate.source.read_image(candidate.entry)
                    digest = hashlib.sha256(payload).hexdigest()
                    if digest in exact_hashes:
                        rejects["exact_image_duplicate"] += 1
                        continue
                    metrics, dhash = image_metrics(payload)
                    quality_ok, reason, quality_score = quality_decision(candidate.source, metrics)
                    if not quality_ok:
                        rejects[reason] += 1
                        continue
                except Exception:
                    rejects["image_read_error"] += 1
                    continue
                candidate.image_bytes = payload
                candidate.image_sha256 = digest
                candidate.dhash = dhash
                candidate.quality = metrics
                candidate.score = (
                    candidate.preliminary * 0.68
                    + quality_score * 0.28
                    + layout_score(candidate.entry) * 0.04
                )
                accepted.append(candidate)
                exact_hashes.add(digest)
                if unique_url:
                    source_urls.add(unique_url)
            evaluated_groups[key] = accepted

        selected_by_group: dict[tuple[str, str], list[Candidate]] = {}
        for key, candidates in evaluated_groups.items():
            selected_by_group[key] = rank_diverse(candidates, PROFILE_CELL_LIMITS[key[0]])

        # Breadth-first global cap. Round 0 keeps one image in every available
        # profile/cell before any group receives a second identity.
        selected: list[Candidate] = []
        max_rounds = max(PROFILE_CELL_LIMITS.values())
        cells = sorted({cell for _, cell in selected_by_group}, key=lambda value: tuple(map(int, value.split(":"))))
        for round_index in range(max_rounds):
            for profile in PROFILE_PRIORITY:
                for cell in cells:
                    items = selected_by_group.get((profile, cell), [])
                    if round_index < len(items):
                        selected.append(items[round_index])
                        if args.max_total > 0 and len(selected) >= args.max_total:
                            break
                if args.max_total > 0 and len(selected) >= args.max_total:
                    break
            if args.max_total > 0 and len(selected) >= args.max_total:
                break

        selected_by_profile: dict[str, list[Candidate]] = defaultdict(list)
        for candidate in selected:
            selected_by_profile[candidate.profile.name].append(candidate)

        # Repack selected images and write catalog entries.
        selected.sort(key=lambda item: (item.yaw, item.pitch, item.profile.name, -item.score))
        pack_index = 0
        pack_size = 0
        pack_handle: BinaryIO | None = None
        output_entries: dict[str, list[dict[str, Any]]] = defaultdict(list)

        def append_pack(payload: bytes) -> tuple[str, int, int]:
            nonlocal pack_index, pack_size, pack_handle
            if pack_handle is None or (pack_size and pack_size + len(payload) > PACK_TARGET_BYTES):
                if pack_handle is not None:
                    pack_handle.close()
                name = f"clean_faces_{pack_index:05d}.bin"
                pack_index += 1
                pack_size = 0
                pack_handle = (packs_output / name).open("wb")
            else:
                name = Path(pack_handle.name).name
            offset = pack_size
            pack_handle.write(payload)
            pack_size += len(payload)
            return name, offset, len(payload)

        for candidate in selected:
            payload = candidate.image_bytes
            if payload is None:
                raise RuntimeError("selected candidate lost image payload")
            pack_name, offset, length = append_pack(payload)
            source_slug = safe_slug(candidate.source.catalog_id)
            original_id = str(candidate.entry.get("id"))
            new_id = f"clean-{source_slug}-{original_id}"
            entry = {
                **candidate.entry,
                "id": new_id,
                "pack": pack_name,
                "offset": offset,
                "length": length,
                "cleanProfile": candidate.profile.name,
                "cleanGroup": candidate.profile.group,
                "cleanPolicy": POLICY_VERSION,
                "cleanPurity": round(candidate.profile.purity, 6),
                "cleanScore": round(candidate.score, 6),
                "sourceCatalogId": candidate.source.catalog_id,
            }
            output_entries[candidate.cell].append(entry)
        if pack_handle is not None:
            pack_handle.close()

        cells_manifest: dict[str, dict[str, Any]] = {}
        shard_count = 0
        for cell, cell_entries in sorted(
            output_entries.items(),
            key=lambda item: tuple(map(int, item[0].split(":"))),
        ):
            yaw, pitch = map(int, cell.split(":"))
            names = []
            for start in range(0, len(cell_entries), SHARD_ENTRY_LIMIT):
                name = (
                    f"clean_yaw_{pose_token(yaw)}_pitch_{pose_token(pitch)}_"
                    f"{start // SHARD_ENTRY_LIMIT:03d}.json"
                )
                (shards_output / name).write_text(
                    json.dumps(
                        {"cell": cell, "items": cell_entries[start:start + SHARD_ENTRY_LIMIT]},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
                names.append(name)
                shard_count += 1
            cells_manifest[cell] = {"count": len(cell_entries), "shards": names}

        profile_counts = {profile: len(selected_by_profile.get(profile, [])) for profile in PROFILE_PRIORITY}
        profile_cells = {
            profile: len({candidate.cell for candidate in selected_by_profile.get(profile, [])})
            for profile in PROFILE_PRIORITY
        }
        source_counts = Counter(candidate.source.catalog_id for candidate in selected)
        manifest = {
            "schemaVersion": 3,
            "catalogId": "many-faces-clean-core-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "totalFaces": len(selected),
            "sourceFaces": len(selected),
            "searchableFaces": len(selected),
            "poseStep": 3,
            "bounds": {"yawMin": -45, "yawMax": 45, "pitchMin": -36, "pitchMax": 36},
            "outputSize": 256,
            "shapeVersion": "mediapipe-projection-468-v4",
            "featureSchema": "mediapipe-face-actions-v2",
            "featureLength": FEATURE_LENGTH,
            "shardsContainGeometry": True,
            "indexFiles": [],
            "cells": cells_manifest,
            "stats": {
                "cleanCore": {
                    "policyVersion": POLICY_VERSION,
                    "inputEntries": input_entries,
                    "classifiedCandidates": sum(classified.values()),
                    "selectedFaces": len(selected),
                    "profileCounts": profile_counts,
                    "profilePoseCells": profile_cells,
                    "sourceCatalogCounts": dict(sorted(source_counts.items())),
                    "rejections": dict(sorted(rejects.items())),
                    "selection": {
                        "strategy": "single-factor breadth-first then structure diversity",
                        "profileCellLimits": PROFILE_CELL_LIMITS,
                        "maxTotal": args.max_total,
                    },
                },
                "poseCells": len(cells_manifest),
                "packCount": pack_index,
                "shardCount": shard_count,
            },
        }
        (catalog_output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        audit = {
            "policyVersion": POLICY_VERSION,
            "inputEntries": input_entries,
            "inputCatalogs": {
                source.catalog_id: len(source.entries)
                for source in sources
            },
            "classifiedCandidates": sum(classified.values()),
            "classifiedProfiles": dict(sorted(classified.items())),
            "selectedFaces": len(selected),
            "selectedProfiles": profile_counts,
            "selectedProfilePoseCells": profile_cells,
            "selectedSources": dict(sorted(source_counts.items())),
            "selectedPoseCells": len(cells_manifest),
            "rejections": dict(sorted(rejects.items())),
            "limits": PROFILE_CELL_LIMITS,
        }
        (output / "audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")

        with (output / "coverage.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(("profile", "cell", "yaw", "pitch", "count", "best_score"))
            for (profile, cell), items in sorted(selected_by_group.items()):
                if not items:
                    continue
                yaw, pitch = map(int, cell.split(":"))
                writer.writerow((profile, cell, yaw, pitch, len(items), f"{max(item.score for item in items):.6f}"))

        for profile, items in selected_by_profile.items():
            write_contact_sheet(sheets_output / f"{profile}.jpg", profile, items)
        build_review_html(review_output / "index.html", selected_by_profile, audit)

        (output / "README.md").write_text(
            f"""# Many Faces clean core v1

This artifact is a first-pass replacement candidate for the old additive 70k
catalog. It contains **{len(selected):,}** images selected at 3-degree yaw/pitch
resolution.

The policy intentionally permits only one anatomical action group at a time:

- neutral;
- isolated left wink, right wink, or blink with a neutral closed mouth;
- isolated mouth states with neutral eyes, brows, nose and jaw translation.

Combinatorial states such as wink + open mouth are excluded from v1. Mouth
states are deliberately finer-grained than eye states. See `audit.json`,
`coverage.csv`, and `review/index.html`.

The image data keeps each source image's original attribution and license
metadata. The catalog is an evaluation artifact until its source-license audit
and side-by-side application review are complete.
""",
            encoding="utf-8",
        )
        print(json.dumps(audit, indent=2))
        return 0
    finally:
        for source in sources:
            source.close()


if __name__ == "__main__":
    raise SystemExit(main())
