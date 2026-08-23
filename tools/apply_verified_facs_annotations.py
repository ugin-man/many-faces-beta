#!/usr/bin/env python3
"""Apply verified Synthetic Humans FACS labels to a built schema-v3 catalog.

`build_face_catalog.py` intentionally measures every image with MediaPipe. That
measurement remains the source of pose and geometry, but MediaPipe blendshape
scores can under-report a known synthetic Action Unit. This postprocessor uses
only source-verified Synthetic Humans FACS rows to:

- preserve clean-profile and FACS provenance on every shard entry;
- replace noisy expression dimensions with a canonical isolated single-factor
  feature while keeping measured yaw/pitch/roll;
- correct eye apertures for verified wink/blink labels when MediaPipe's
  projection contradicts the visible, annotated eye state.

Natural-image catalogs never pass through this tool.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import struct
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from clean_core_policy_v3 import BLEND_KEYS, FEATURE_INDEX, FEATURE_LENGTH


CANONICAL_ACTIONS: dict[str, dict[str, float]] = {
    "neutral": {},
    "winkLeft": {"eyeBlinkLeft": 0.84, "eyeBlinkRight": 0.04},
    "winkRight": {"eyeBlinkRight": 0.84, "eyeBlinkLeft": 0.04},
    "blink": {"eyeBlinkLeft": 0.84, "eyeBlinkRight": 0.84},
    "eyesWide": {"eyeWideLeft": 0.76, "eyeWideRight": 0.76},
    "gazeUp": {"eyeLookUpLeft": 0.68, "eyeLookUpRight": 0.68},
    "gazeDown": {"eyeLookDownLeft": 0.68, "eyeLookDownRight": 0.68},
    "gazeLeft": {"eyeLookOutLeft": 0.68, "eyeLookInRight": 0.68},
    "gazeRight": {"eyeLookInLeft": 0.68, "eyeLookOutRight": 0.68},
    "browsUp": {
        "browInnerUp": 0.68,
        "browOuterUpLeft": 0.72,
        "browOuterUpRight": 0.72,
    },
    "browsDown": {"browDownLeft": 0.72, "browDownRight": 0.72},
    "noseSneer": {"noseSneerLeft": 0.72, "noseSneerRight": 0.72},
    "mouthSlightOpen": {"jawOpen": 0.20},
    "mouthOpen": {"jawOpen": 0.62},
    "smileClosed": {"mouthSmileLeft": 0.72, "mouthSmileRight": 0.72},
    "smileOpen": {
        "jawOpen": 0.42,
        "mouthSmileLeft": 0.68,
        "mouthSmileRight": 0.68,
    },
    "mouthRound": {"jawOpen": 0.18, "mouthFunnel": 0.58},
    "mouthPucker": {"mouthPucker": 0.72},
    "mouthWide": {"mouthStretchLeft": 0.72, "mouthStretchRight": 0.72},
    "mouthPress": {
        "mouthClose": 0.62,
        "mouthPressLeft": 0.72,
        "mouthPressRight": 0.72,
    },
    "mouthRoll": {"mouthRollLower": 0.70, "mouthRollUpper": 0.70},
    "mouthLeft": {"mouthLeft": 0.72},
    "mouthRight": {"mouthRight": 0.72},
    "mouthFrown": {"mouthFrownLeft": 0.70, "mouthFrownRight": 0.70},
    "mouthShrug": {"mouthShrugLower": 0.70, "mouthShrugUpper": 0.70},
    "mouthUpperUp": {"mouthUpperUpLeft": 0.70, "mouthUpperUpRight": 0.70},
    "mouthLowerDown": {
        "mouthLowerDownLeft": 0.70,
        "mouthLowerDownRight": 0.70,
    },
}

PROFILE_GROUPS = {
    "neutral": "neutral",
    "winkLeft": "eyes", "winkRight": "eyes", "blink": "eyes",
    "eyesWide": "eyes", "gazeUp": "eyes", "gazeDown": "eyes",
    "gazeLeft": "eyes", "gazeRight": "eyes",
    "browsUp": "brows", "browsDown": "brows",
    "noseSneer": "nose",
    "mouthSlightOpen": "mouth", "mouthOpen": "mouth",
    "smileClosed": "mouth", "smileOpen": "mouth",
    "mouthRound": "mouth", "mouthPucker": "mouth", "mouthWide": "mouth",
    "mouthPress": "mouth", "mouthRoll": "mouth",
    "mouthLeft": "mouth", "mouthRight": "mouth", "mouthFrown": "mouth",
    "mouthShrug": "mouth", "mouthUpperUp": "mouth", "mouthLowerDown": "mouth",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Expanded FACS image directory")
    parser.add_argument("catalog", type=Path, help="Built schema-v3 catalog")
    parser.add_argument("--metadata", type=Path, required=True)
    return parser.parse_args()


def load_rows(source: Path, metadata_path: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    with metadata_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            relative = (row.get("relative_path") or "").replace("\\", "/").strip()
            if not relative:
                continue
            path = source / relative
            if not path.is_file():
                raise FileNotFoundError(f"metadata image is missing: {path}")
            entry_id = hashlib.sha256(path.read_bytes()).hexdigest()[:24]
            if entry_id in rows:
                raise ValueError(f"duplicate source digest in FACS metadata: {entry_id}")
            rows[entry_id] = {key: (value or "").strip() for key, value in row.items()}
    return rows


def canonical_feature(feature: Any, profile: str) -> list[float]:
    if not isinstance(feature, list) or len(feature) != FEATURE_LENGTH:
        raise ValueError(f"feature must contain {FEATURE_LENGTH} values")
    output = [float(feature[0]), float(feature[1]), float(feature[2])]
    output.extend(0.0 for _ in BLEND_KEYS)
    for name, value in CANONICAL_ACTIONS[profile].items():
        output[FEATURE_INDEX[name]] = value
    return output


def decode_projection(encoded: Any) -> list[float] | None:
    if not isinstance(encoded, str) or not encoded:
        return None
    try:
        payload = base64.b64decode(encoded)
        if len(payload) % 2:
            return None
        return [value / 4096.0 for value in struct.unpack(f"<{len(payload) // 2}h", payload)]
    except (ValueError, struct.error):
        return None


def encode_projection(values: Iterable[float]) -> str:
    quantized = [max(-32768, min(32767, round(float(value) * 4096))) for value in values]
    return base64.b64encode(struct.pack(f"<{len(quantized)}h", *quantized)).decode("ascii")


def set_aperture(values: list[float], top: int, bottom: int, aperture: float) -> None:
    top_index, bottom_index = top * 2 + 1, bottom * 2 + 1
    if bottom_index >= len(values):
        return
    midpoint = (values[top_index] + values[bottom_index]) / 2.0
    values[top_index] = midpoint - aperture / 2.0
    values[bottom_index] = midpoint + aperture / 2.0


def corrected_projection(encoded: Any, profile: str) -> Any:
    if profile not in {"winkLeft", "winkRight", "blink", "eyesWide"}:
        return encoded
    values = decode_projection(encoded)
    if values is None:
        return encoded
    # Policy convention: anatomical left blink corresponds to image-space right
    # eye landmarks, matching clean_core_policy_v2.wink_flags().
    if profile == "winkLeft":
        set_aperture(values, 159, 145, 0.060)
        set_aperture(values, 386, 374, 0.008)
    elif profile == "winkRight":
        set_aperture(values, 159, 145, 0.008)
        set_aperture(values, 386, 374, 0.060)
    elif profile == "blink":
        set_aperture(values, 159, 145, 0.008)
        set_aperture(values, 386, 374, 0.008)
    else:
        set_aperture(values, 159, 145, 0.075)
        set_aperture(values, 386, 374, 0.075)
    return encode_projection(values)


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    catalog = args.catalog.resolve()
    rows = load_rows(source, args.metadata.resolve())
    manifest_path = catalog / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    shard_names = sorted({
        name
        for cell in manifest.get("cells", {}).values()
        for name in (cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))
    })
    matched: set[str] = set()
    profiles: Counter[str] = Counter()
    unmatched_entries: list[str] = []

    for shard_name in shard_names:
        path = catalog / "shards" / shard_name
        payload = json.loads(path.read_text(encoding="utf-8"))
        for entry in payload.get("items", []):
            entry_id = str(entry.get("id") or "")
            row = rows.get(entry_id)
            if row is None:
                unmatched_entries.append(entry_id)
                continue
            profile = row.get("clean_profile") or row.get("target_configuration")
            if profile == "wink":
                raise ValueError(f"wink side was not resolved before catalog build: {entry_id}")
            if profile not in CANONICAL_ACTIONS:
                raise ValueError(f"unsupported verified FACS profile {profile!r}: {entry_id}")
            entry["feature"] = canonical_feature(entry.get("feature"), profile)
            entry["projection"] = corrected_projection(entry.get("projection"), profile)
            entry["cleanProfile"] = profile
            entry["cleanGroup"] = row.get("clean_group") or PROFILE_GROUPS[profile]
            entry["cleanTier"] = "strict"
            entry["targetConfiguration"] = row.get("target_configuration") or profile
            entry["annotationVerified"] = True
            entry["facsActionUnit"] = row.get("facs_action_unit") or ""
            entry["sourceKind"] = "verified-synthetic-facs"
            matched.add(entry_id)
            profiles[profile] += 1
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    if unmatched_entries:
        sample = ", ".join(unmatched_entries[:10])
        raise SystemExit(f"{len(unmatched_entries)} catalog entries lacked FACS metadata: {sample}")
    missing = sorted(set(rows) - matched)
    # The catalog builder may discard true image duplicates or out-of-range pose;
    # report them, but every retained catalog entry must have matched metadata.
    report = {
        "schemaVersion": 1,
        "catalogId": manifest.get("catalogId"),
        "metadataRows": len(rows),
        "catalogEntriesUpdated": len(matched),
        "metadataRowsNotPacked": len(missing),
        "profiles": dict(sorted(profiles.items())),
        "featurePolicy": "canonical-isolated-FACS-v1",
        "poseAndGeometry": "MediaPipe measured",
        "annotation": "Synthetic Humans FACS single Action Unit",
    }
    (catalog / "facs-annotation-overlay.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
