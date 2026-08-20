#!/usr/bin/env python3
"""Add precomputed MediaPipe mesh vectors to an existing packed catalog.

The script never rewrites image packs. It reads each packed WebP by byte range,
runs Face Landmarker once on the build machine, and stores compact numeric
descriptors in the corresponding JSON shard. Browser clients can then search
the complete index without downloading or detecting candidate images.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import struct
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)

STABLE_LANDMARKS = (
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
    33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 1, 19, 94,
    98, 327, 129, 358,
)

DETAIL_EXTRA = (
    0, 11, 12, 13, 14, 15, 16, 17, 37, 39, 40, 61, 72, 73, 74, 76, 77, 78,
    80, 81, 82, 84, 85, 87, 88, 89, 90, 91, 95, 146, 178, 179, 180, 181,
    183, 184, 185, 191, 267, 269, 270, 291, 302, 303, 304, 306, 307, 308,
    310, 311, 312, 314, 315, 317, 318, 319, 320, 321, 324, 325, 375, 402,
    403, 404, 405, 407, 408, 409, 415,
    33, 133, 144, 145, 153, 154, 155, 157, 158, 159, 160, 161, 163,
    246, 263, 362, 373, 374, 380, 381, 382, 384, 385, 386, 387, 388, 390,
    398, 466,
    46, 52, 53, 55, 63, 65, 66, 70, 105, 107, 276, 282, 283, 285, 293,
    295, 296, 300, 334, 336,
)

DETAIL_LANDMARKS = tuple(dict.fromkeys(
    (*STABLE_LANDMARKS, *(index for index in range(468) if index % 3 == 0), *DETAIL_EXTRA)
))

BLEND_KEYS = (
    "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker",
    "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
    "mouthStretchLeft", "mouthStretchRight", "eyeBlinkLeft", "eyeBlinkRight",
    "eyeSquintLeft", "eyeSquintRight", "browInnerUp", "browDownLeft",
    "browDownRight", "browOuterUpLeft", "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
    "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight",
    "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawRight",
    "mouthDimpleLeft", "mouthDimpleRight", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight",
    "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
    "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight", "_neutral",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("catalog", type=Path)
    parser.add_argument("--model", type=Path, default=Path("/tmp/face_landmarker.task"))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--batch-new",
        type=int,
        default=0,
        help="Checkpoint after this many new detections without publishing a partial manifest.",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--sharded-only",
        action="store_true",
        help="Keep detailed geometry in pose shards and omit the browser-wide full index.",
    )
    return parser.parse_args()


def encode_vector(values: list[float]) -> str:
    quantized = [max(-32768, min(32767, round(value * 4096))) for value in values]
    return base64.b64encode(struct.pack(f"<{len(quantized)}h", *quantized)).decode("ascii")


def canonical_geometry(landmarks: list[Any]) -> tuple[list[float], list[float], list[float], list[float]] | None:
    if len(landmarks) < 468:
        return None

    def point(index: int) -> tuple[float, float, float]:
        item = landmarks[index]
        return float(item.x), float(item.y), float(getattr(item, "z", 0.0))

    def midpoint(left: int, right: int) -> tuple[float, float, float]:
        a, b = point(left), point(right)
        return tuple((a[index] + b[index]) / 2 for index in range(3))

    left_eye = midpoint(33, 133)
    right_eye = midpoint(362, 263)
    eye_dx = right_eye[0] - left_eye[0]
    eye_dy = right_eye[1] - left_eye[1]
    eye_span = math.hypot(eye_dx, eye_dy)
    if eye_span < 0.01:
        return None
    center_x = (left_eye[0] + right_eye[0]) / 2
    center_y = (left_eye[1] + right_eye[1]) / 2
    cosine = eye_dx / eye_span
    sine = eye_dy / eye_span

    def distance(left: int, right: int) -> float:
        a, b = point(left), point(right)
        return math.hypot(a[0] - b[0], a[1] - b[1]) / eye_span

    def distance_to_center(index: int) -> float:
        item = point(index)
        return math.hypot(item[0] - center_x, item[1] - center_y) / eye_span

    def canonical(index: int) -> list[float]:
        x, y, z = point(index)
        relative_x, relative_y = x - center_x, y - center_y
        return [
            (relative_x * cosine + relative_y * sine) / eye_span,
            (-relative_x * sine + relative_y * cosine) / eye_span,
            z / eye_span,
        ]

    structure = [
        distance(234, 454), distance(10, 152), distance(172, 397),
        distance(127, 356), distance(98, 327), distance_to_center(2),
        distance(33, 133), distance(362, 263), distance(2, 152),
    ]
    for index in STABLE_LANDMARKS:
        structure.extend(canonical(index))
    surface: list[float] = []
    for index in DETAIL_LANDMARKS:
        surface.extend(canonical(index))
    projection: list[float] = []
    for index in range(468):
        x, y, _ = canonical(index)
        projection.extend((x, y))
    xs = [point(index)[0] for index in range(468)]
    ys = [point(index)[1] for index in range(468)]
    layout = [
        (min(xs) + max(xs)) / 2,
        (min(ys) + max(ys)) / 2,
        max(xs) - min(xs),
        max(ys) - min(ys),
    ]
    if not all(math.isfinite(value) for value in (*structure, *surface, *projection, *layout)):
        return None
    return structure, surface, projection, layout


def feature_from_result(result: Any) -> list[float]:
    values = np.asarray(result.facial_transformation_matrixes[0], dtype=np.float64).reshape(-1)
    pitch = math.atan2(float(values[9]), float(values[10]))
    yaw = math.atan2(-float(values[8]), math.hypot(float(values[9]), float(values[10])))
    roll = math.atan2(float(values[4]), float(values[0]))

    def quantize(value: float, pitch_scale: float = 1.0) -> float:
        degrees = max(-45, min(45, value * pitch_scale / (math.pi / 2) * 90))
        return round(degrees / 3) * 3 / 90

    scores = {
        category.category_name: float(category.score)
        for category in result.face_blendshapes[0]
    }
    return [
        quantize(yaw), quantize(pitch, 1.4), quantize(roll),
        *(scores.get(key, 0.0) for key in BLEND_KEYS),
    ]


def referenced_shard_paths(catalog: Path, manifest: dict[str, Any]) -> list[Path]:
    names: list[str] = []
    for cell in manifest.get("cells", {}).values():
        names.extend(cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))
    paths = [catalog / "shards" / name for name in dict.fromkeys(names)]
    paths = [path for path in paths if path.exists()]
    return paths or sorted((catalog / "shards").glob("*.json"))


def pose_token(value: int) -> str:
    return f"p{value:03d}" if value >= 0 else f"n{abs(value):03d}"


def pose_cell(feature: list[float], manifest: dict[str, Any]) -> tuple[str, int, int]:
    step = int(manifest.get("poseStep", 3))
    bounds = manifest.get("bounds", {})
    yaw = round(float(feature[0]) * 90 / step) * step
    pitch = round(float(feature[1]) * 90 / step) * step
    yaw = max(int(bounds.get("yawMin", -45)), min(int(bounds.get("yawMax", 45)), yaw))
    pitch = max(int(bounds.get("pitchMin", -36)), min(int(bounds.get("pitchMax", 36)), pitch))
    return f"{yaw}:{pitch}", yaw, pitch


def decode_vector(encoded: str) -> tuple[float, ...]:
    raw = base64.b64decode(encoded)
    return tuple(value / 4096 for value in struct.unpack(f"<{len(raw) // 2}h", raw))


def coverage_report(items: list[dict[str, Any]]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    indexes = {key: index + 3 for index, key in enumerate(BLEND_KEYS)}

    def score(feature: list[float], key: str) -> float:
        return float(feature[indexes[key]]) if len(feature) > indexes[key] else 0.0

    for item in items:
        feature = item["feature"]
        yaw = abs(float(feature[0]) * 90)
        pitch = float(feature[1]) * 90
        if pitch >= 21:
            counts["pitchPositive21"] += 1
        if pitch <= -21:
            counts["pitchNegative21"] += 1
        if (score(feature, "mouthSmileLeft") + score(feature, "mouthSmileRight")) / 2 >= 0.28:
            counts["smile"] += 1
        if score(feature, "jawOpen") >= 0.32:
            counts["mouthOpen"] += 1
        if max(score(feature, "browInnerUp"), score(feature, "browOuterUpLeft"), score(feature, "browOuterUpRight")) >= 0.25:
            counts["browsUp"] += 1
        if (score(feature, "eyeWideLeft") + score(feature, "eyeWideRight")) / 2 >= 0.22:
            counts["eyesWide"] += 1
        if (score(feature, "eyeLookUpLeft") + score(feature, "eyeLookUpRight")) / 2 >= 0.2:
            counts["eyesLookUp"] += 1
        if (score(feature, "eyeLookDownLeft") + score(feature, "eyeLookDownRight")) / 2 >= 0.2:
            counts["eyesLookDown"] += 1
        left_blink = score(feature, "eyeBlinkLeft")
        right_blink = score(feature, "eyeBlinkRight")
        # Side profiles often look like a wink to the action model. Require a
        # near-frontal face and agreement from the actual eyelid apertures.
        if yaw <= 18 and item.get("projection"):
            projection = decode_vector(item["projection"])
            left_aperture = abs(projection[159 * 2 + 1] - projection[145 * 2 + 1])
            right_aperture = abs(projection[386 * 2 + 1] - projection[374 * 2 + 1])
            # MediaPipe names the person's anatomical side; image-space landmark
            # groups appear on the opposite side to the viewer.
            if left_blink - right_blink >= 0.28 and right_aperture < left_aperture * 0.76:
                counts["winkLeft"] += 1
            if right_blink - left_blink >= 0.28 and left_aperture < right_aperture * 0.76:
                counts["winkRight"] += 1
        if min(left_blink, right_blink) >= 0.42:
            counts["blink"] += 1
    required = {
        "winkLeft": 80,
        "winkRight": 80,
        "blink": 120,
        "eyesWide": 160,
        "eyesLookUp": 120,
        "eyesLookDown": 120,
        "browsUp": 160,
        "pitchPositive21": 300,
        "pitchNegative21": 300,
        "smile": 1_000,
        "mouthOpen": 500,
    }
    return {
        "counts": {key: int(counts[key]) for key in required},
        "targets": required,
        "deficits": {key: max(0, target - int(counts[key])) for key, target in required.items()},
    }


def main() -> int:
    args = parse_args()
    catalog = args.catalog.resolve()
    manifest_path = catalog / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    previous_index: dict[str, dict[str, Any]] = {}
    for filename in manifest.get("indexFiles", []):
        index_path = catalog / filename
        if not index_path.exists():
            continue
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        for item in payload.get("items", []):
            if item.get("id") and len(item.get("feature", [])) == 3 + len(BLEND_KEYS):
                previous_index[item["id"]] = item
    if not args.model.exists():
        import urllib.request
        urllib.request.urlretrieve(MODEL_URL, args.model)

    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model)),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.4,
        min_face_presence_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    shard_paths = referenced_shard_paths(catalog, manifest)
    total = sum(len(json.loads(path.read_text(encoding="utf-8")).get("items", [])) for path in shard_paths)
    target = min(total, args.limit) if args.limit else total
    processed = 0
    accepted = 0
    failed = 0
    attempted_new = 0
    pack_cache: dict[str, bytes] = {}

    # Keep the native task alive through final manifest generation. Some
    # sandboxed Linux hosts cannot tear down MediaPipe's EGL sidecar cleanly.
    detector = vision.FaceLandmarker.create_from_options(options)
    if detector:
        for shard_path in shard_paths:
            payload = json.loads(shard_path.read_text(encoding="utf-8"))
            changed = False
            for entry in payload.get("items", []):
                if processed >= target:
                    break
                processed += 1
                cached = previous_index.get(entry.get("id", ""))
                if cached and not args.force:
                    for key in ("feature", "shape", "mesh", "projection", "layout"):
                        if cached.get(key) is not None:
                            entry[key] = cached[key]
                    changed = True
                complete = (
                    len(entry.get("feature", [])) == 3 + len(BLEND_KEYS) and
                    entry.get("mesh") and entry.get("shape") and
                    entry.get("projection") and entry.get("layout")
                )
                if not args.force and complete:
                    accepted += 1
                    continue
                if not args.force and entry.get("indexFailure"):
                    failed += 1
                    continue
                try:
                    attempted_new += 1
                    pack_name = entry["pack"]
                    pack = pack_cache.get(pack_name)
                    if pack is None:
                        pack = (catalog / "packs" / pack_name).read_bytes()
                        pack_cache[pack_name] = pack
                    start = int(entry["offset"])
                    end = start + int(entry["length"])
                    image = Image.open(BytesIO(pack[start:end])).convert("RGB")
                    image_data = np.asarray(image)
                    result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=image_data))
                    if not result.face_landmarks or not result.face_blendshapes or not result.facial_transformation_matrixes:
                        raise ValueError("face not detected")
                    geometry = canonical_geometry(result.face_landmarks[0])
                    if not geometry:
                        raise ValueError("invalid mesh")
                    structure, surface, projection, layout = geometry
                    entry["feature"] = [round(value, 6) for value in feature_from_result(result)]
                    entry["shape"] = encode_vector(structure)
                    entry["mesh"] = encode_vector(surface)
                    entry["projection"] = encode_vector(projection)
                    entry["layout"] = [round(value, 6) for value in layout]
                    entry.pop("indexFailure", None)
                    accepted += 1
                    changed = True
                except Exception as error:
                    failed += 1
                    entry["indexFailure"] = str(error)
                    changed = True
                    print(f"warning {entry.get('id', '?')}: {error}")
                if processed % 100 == 0 or processed == target:
                    print(f"indexed {processed}/{target}; accepted={accepted}; failed={failed}", flush=True)
            if changed:
                shard_path.write_text(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
            if args.batch_new and attempted_new >= args.batch_new:
                print(
                    f"checkpoint: attempted {attempted_new} new faces; "
                    f"processed={processed}, accepted={accepted}, failed={failed}",
                    flush=True,
                )
                sys.stderr.flush()
                os._exit(0)
            if processed >= target:
                break

    by_id: dict[str, dict[str, Any]] = {}
    for shard_path in shard_paths:
        payload = json.loads(shard_path.read_text(encoding="utf-8"))
        for item in payload.get("items", []):
            if (
                item.get("id") and len(item.get("feature", [])) == 3 + len(BLEND_KEYS) and
                item.get("shape") and item.get("mesh") and item.get("projection") and item.get("layout")
            ):
                by_id[item["id"]] = item
    indexed_items = sorted(by_id.values(), key=lambda item: item["id"])
    cells: dict[str, list[dict[str, Any]]] = defaultdict(list)
    cell_pose: dict[str, tuple[int, int]] = {}
    for item in indexed_items:
        key, yaw, pitch = pose_cell(item["feature"], manifest)
        cells[key].append(item)
        cell_pose[key] = (yaw, pitch)

    shard_entry_limit = 700
    manifest_cells: dict[str, dict[str, Any]] = {}
    for key in sorted(cells):
        yaw, pitch = cell_pose[key]
        filenames: list[str] = []
        entries = cells[key]
        for start in range(0, len(entries), shard_entry_limit):
            filename = (
                f"seed_yaw_{pose_token(yaw)}_pitch_{pose_token(pitch)}_"
                f"{start // shard_entry_limit:03d}.json"
            )
            filenames.append(filename)
            (catalog / "shards" / filename).write_text(
                json.dumps(
                    {"cell": key, "items": entries[start:start + shard_entry_limit]},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
        manifest_cells[key] = {"count": len(entries), "shards": filenames}

    manifest["schemaVersion"] = 3
    manifest["catalogId"] = f"seed-ffhq-{int(manifest.get('totalFaces', total))}-actions-v4"
    manifest["generatedAt"] = datetime.now(timezone.utc).isoformat()
    manifest["shapeVersion"] = "mediapipe-projection-468-v4"
    manifest["meshPoints"] = len(DETAIL_LANDMARKS)
    manifest["projectionPoints"] = 468
    manifest["featureSchema"] = "mediapipe-face-actions-v2"
    manifest["featureLength"] = 3 + len(BLEND_KEYS)
    manifest["searchableFaces"] = len(indexed_items)
    manifest["sourceFaces"] = int(manifest.get("totalFaces", total))
    manifest["cells"] = manifest_cells
    stats = manifest.setdefault("stats", {})
    stats["preindexedFaces"] = len(indexed_items)
    stats["preindexFailures"] = int(manifest.get("sourceFaces", manifest.get("totalFaces", total))) - len(indexed_items)
    stats["coverage"] = coverage_report(indexed_items)
    stats["poseCells"] = len(manifest_cells)
    stats["maximumFacesPerCell"] = max((cell["count"] for cell in manifest_cells.values()), default=0)
    stats["minimumFacesPerCell"] = min((cell["count"] for cell in manifest_cells.values()), default=0)

    manifest.pop("indexFile", None)
    if args.sharded_only:
        manifest["indexFiles"] = []
        manifest["shardsContainGeometry"] = True
    else:
        index_files: list[str] = []
        index_chunk_size = 1250
        for start in range(0, len(indexed_items), index_chunk_size):
            filename = f"index_{start // index_chunk_size:03d}.json"
            index_files.append(filename)
            (catalog / filename).write_text(
                json.dumps(
                    {"shapeVersion": manifest["shapeVersion"], "items": indexed_items[start:start + index_chunk_size]},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
        manifest["indexFiles"] = index_files
        manifest["shardsContainGeometry"] = False
        for cell in manifest_cells.values():
            for filename in cell["shards"]:
                shard_path = catalog / "shards" / filename
                payload = json.loads(shard_path.read_text(encoding="utf-8"))
                for item in payload.get("items", []):
                    for field in ("shape", "mesh", "projection", "layout"):
                        item.pop(field, None)
                shard_path.write_text(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"complete: {len(indexed_items)} searchable, {failed} failed, "
        f"{len(manifest_cells)} pose cells, {len(DETAIL_LANDMARKS)} detail points",
        flush=True,
    )
    # Exit while the task is still referenced; see the EGL teardown note above.
    sys.stderr.flush()
    os._exit(0 if indexed_items else 1)


if __name__ == "__main__":
    main()
