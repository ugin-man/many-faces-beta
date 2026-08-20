#!/usr/bin/env python3
"""Build a sharded Many Faces catalog from a directory of source images."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import math
import os
import struct
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
IMAGE_EXTENSIONS = {".avif", ".jpeg", ".jpg", ".png", ".webp"}
BLEND_KEYS = (
    "jawOpen",
    "mouthClose",
    "mouthFunnel",
    "mouthPucker",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "mouthStretchLeft",
    "mouthStretchRight",
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "eyeSquintLeft",
    "eyeSquintRight",
    "browInnerUp",
    "browDownLeft",
    "browDownRight",
    "browOuterUpLeft",
    "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
    "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight",
    "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawRight",
    "mouthDimpleLeft", "mouthDimpleRight", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight",
    "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
    "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight", "_neutral",
)
PACK_TARGET_BYTES = 6 * 1024 * 1024
SHARD_ENTRY_LIMIT = 512
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
    403, 404, 405, 407, 408, 409, 415, 144, 145, 153, 154, 155, 157, 158,
    159, 160, 161, 163, 246, 373, 374, 380, 381, 382, 384, 385, 386, 387,
    388, 390, 398, 466, 46, 52, 53, 55, 63, 65, 66, 70, 105, 107, 276,
    282, 283, 285, 293, 295, 296, 300, 334, 336,
)
DETAIL_LANDMARKS = tuple(dict.fromkeys(
    (*STABLE_LANDMARKS, *(index for index in range(468) if index % 3 == 0), *DETAIL_EXTRA)
))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Detect, align, compress, and shard a face-image directory."
    )
    parser.add_argument("input", type=Path, help="Directory containing source images")
    parser.add_argument("output", type=Path, help="Output catalog directory")
    parser.add_argument("--model", type=Path, default=Path(".models/face_landmarker.task"))
    parser.add_argument("--metadata", type=Path, help="Optional UTF-8 CSV keyed by relative_path")
    parser.add_argument("--size", type=int, default=256, choices=(128, 192, 256, 384))
    parser.add_argument("--quality", type=int, default=78)
    parser.add_argument("--pose-step", type=int, default=3)
    parser.add_argument("--yaw-min", type=int, default=-30)
    parser.add_argument("--yaw-max", type=int, default=30)
    parser.add_argument("--pitch-min", type=int, default=-15)
    parser.add_argument("--pitch-max", type=int, default=15)
    parser.add_argument("--max-files", type=int, default=0, help="0 means no limit")
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def ensure_model(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Face Landmarker model to {path}")
    urllib.request.urlretrieve(MODEL_URL, path)


def load_metadata(path: Path | None) -> dict[str, dict[str, str]]:
    if not path:
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle)
        result: dict[str, dict[str, str]] = {}
        for row in rows:
            key = (row.get("relative_path") or "").replace("\\", "/").strip()
            if key:
                result[key] = {name: (value or "").strip() for name, value in row.items()}
        return result


def matrix_values(matrix: Any) -> np.ndarray:
    raw = getattr(matrix, "data", matrix)
    return np.asarray(raw, dtype=np.float64).reshape(-1)


def pose_from_matrix(matrix: Any) -> tuple[float, float, float]:
    values = matrix_values(matrix)
    if values.size < 11:
        return 0.0, 0.0, 0.0
    pitch = math.atan2(float(values[9]), float(values[10]))
    yaw = math.atan2(-float(values[8]), math.hypot(float(values[9]), float(values[10])))
    roll = math.atan2(float(values[4]), float(values[0]))
    return tuple(max(-1.0, min(1.0, value / (math.pi / 2))) for value in (yaw, pitch, roll))


def quantized_pose(value: float, step: int) -> float:
    degrees = round((value * 90) / step) * step
    return degrees / 90


def average_landmark(landmarks: list[Any], indexes: tuple[int, ...]) -> tuple[float, float]:
    return (
        sum(float(landmarks[index].x) for index in indexes) / len(indexes),
        sum(float(landmarks[index].y) for index in indexes) / len(indexes),
    )


def aligned_crop(image: Image.Image, landmarks: list[Any], output_size: int) -> Image.Image:
    width, height = image.size
    left_eye = average_landmark(landmarks, (33, 133, 159, 145))
    right_eye = average_landmark(landmarks, (362, 263, 386, 374))
    eye_center = ((left_eye[0] + right_eye[0]) / 2, (left_eye[1] + right_eye[1]) / 2)
    angle = math.atan2(
        (right_eye[1] - left_eye[1]) * height,
        (right_eye[0] - left_eye[0]) * width,
    )

    xs = [float(point.x) * width for point in landmarks]
    ys = [float(point.y) * height for point in landmarks]
    face_height = max(1.0, max(ys) - min(ys))
    source_x = eye_center[0] * width
    source_y = eye_center[1] * height + face_height * 0.16
    target_face_height = output_size * (274 / 384)
    scale = min(3.2, max(0.18, target_face_height / face_height))

    target_x = output_size / 2
    target_y = output_size * 0.49
    cosine = math.cos(angle) / scale
    sine = math.sin(angle) / scale
    transform = (
        cosine,
        -sine,
        source_x - cosine * target_x + sine * target_y,
        sine,
        cosine,
        source_y - sine * target_x - cosine * target_y,
    )
    return image.transform(
        (output_size, output_size),
        Image.Transform.AFFINE,
        transform,
        resample=Image.Resampling.LANCZOS,
        fillcolor=(216, 212, 204),
    )


def difference_hash(image: Image.Image) -> str:
    pixels = np.asarray(image.convert("L").resize((9, 8), Image.Resampling.BILINEAR))
    bits = pixels[:, 1:] > pixels[:, :-1]
    value = sum(int(bit) << index for index, bit in enumerate(bits.reshape(-1)))
    return f"{value:016x}"


def face_geometry(
    landmarks: list[Any],
) -> tuple[list[float], list[float], list[float], list[float]] | None:
    if len(landmarks) <= 454:
        return None

    def point(index: int) -> tuple[float, float, float]:
        item = landmarks[index]
        return float(item.x), float(item.y), float(getattr(item, "z", 0.0))

    left_eye = tuple((a + b) / 2 for a, b in zip(point(33), point(133)))
    right_eye = tuple((a + b) / 2 for a, b in zip(point(362), point(263)))
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

    def distance_to_eye_center(index: int) -> float:
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
        distance(127, 356), distance(98, 327), distance_to_eye_center(2),
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


def encode_structure(values: list[float]) -> str:
    quantized = [max(-32768, min(32767, round(value * 4096))) for value in values]
    return base64.b64encode(struct.pack(f"<{len(quantized)}h", *quantized)).decode("ascii")


def cell_filename(yaw: int, pitch: int) -> str:
    yaw_token = f"p{yaw:03d}" if yaw >= 0 else f"n{abs(yaw):03d}"
    pitch_token = f"p{pitch:03d}" if pitch >= 0 else f"n{abs(pitch):03d}"
    return f"yaw_{yaw_token}_pitch_{pitch_token}.json"


def main() -> int:
    args = parse_args()
    os.environ.setdefault(
        "MPLCONFIGDIR",
        str((args.output.resolve() / ".matplotlib-cache")),
    )
    try:
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        raise SystemExit(
            "MediaPipe is missing. Run: python -m pip install -r tools/requirements-catalog.txt"
        ) from exc
    input_dir = args.input.resolve()
    output_dir = args.output.resolve()
    if not input_dir.is_dir():
        raise SystemExit(f"Input directory does not exist: {input_dir}")
    if output_dir.exists() and any(output_dir.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty. Use --overwrite or choose another directory.")
    if args.pose_step <= 0 or 90 % args.pose_step:
        raise SystemExit("--pose-step must be a positive divisor of 90")

    ensure_model(args.model)
    metadata = load_metadata(args.metadata)
    packs_dir = output_dir / "packs"
    shards_dir = output_dir / "shards"
    packs_dir.mkdir(parents=True, exist_ok=True)
    shards_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(
        path for path in input_dir.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )
    if args.max_files > 0:
        files = files[: args.max_files]

    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model.resolve())),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.45,
        min_face_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )

    shards: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen_hashes: set[str] = set()
    rejected = 0
    duplicates = 0
    outside = 0
    pack_index = 0
    pack_size = 0
    pack_handle = None

    def append_to_pack(payload: bytes) -> tuple[str, int, int]:
        nonlocal pack_index, pack_size, pack_handle
        if pack_handle is None or (pack_size and pack_size + len(payload) > PACK_TARGET_BYTES):
            if pack_handle is not None:
                pack_handle.close()
            pack_name = f"faces_{pack_index:05d}.bin"
            pack_index += 1
            pack_size = 0
            pack_handle = (packs_dir / pack_name).open("wb")
        else:
            pack_name = Path(pack_handle.name).name
        offset = pack_size
        pack_handle.write(payload)
        pack_size += len(payload)
        return pack_name, offset, len(payload)

    try:
        detector_context = vision.FaceLandmarker.create_from_options(options)
    except OSError as exc:
        if "libGLES" in str(exc):
            raise SystemExit(
                "MediaPipe needs the system OpenGL ES runtime on Linux. "
                "Install your distribution's libgles2 package, then rerun this command."
            ) from exc
        raise

    with detector_context as detector:
        for index, source_path in enumerate(files, start=1):
            relative_path = source_path.relative_to(input_dir).as_posix()
            try:
                with Image.open(source_path) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                mp_image = mp.Image(
                    image_format=mp.ImageFormat.SRGB,
                    data=np.asarray(image),
                )
                result = detector.detect(mp_image)
                if not result.face_landmarks or not result.facial_transformation_matrixes:
                    rejected += 1
                    continue

                pose = pose_from_matrix(result.facial_transformation_matrixes[0])
                pose = (pose[0], max(-1.0, min(1.0, pose[1] * 1.4)), pose[2])
                yaw = round((pose[0] * 90) / args.pose_step) * args.pose_step
                pitch = round((pose[1] * 90) / args.pose_step) * args.pose_step
                if not (args.yaw_min <= yaw <= args.yaw_max and args.pitch_min <= pitch <= args.pitch_max):
                    outside += 1
                    continue

                crop = aligned_crop(image, result.face_landmarks[0], args.size)
                crop_result = detector.detect(
                    mp.Image(
                        image_format=mp.ImageFormat.SRGB,
                        data=np.asarray(crop),
                    )
                )
                geometry = face_geometry(crop_result.face_landmarks[0]) if crop_result.face_landmarks else None
                if not geometry:
                    rejected += 1
                    continue
                structure, surface, projection, layout = geometry
                visual_hash = difference_hash(crop)
                if visual_hash in seen_hashes:
                    duplicates += 1
                    continue
                seen_hashes.add(visual_hash)

                source_digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
                encoded = BytesIO()
                crop.save(
                    encoded,
                    "WEBP",
                    quality=max(40, min(95, args.quality)),
                    method=6,
                )
                pack_name, pack_offset, pack_length = append_to_pack(encoded.getvalue())

                scores = {
                    category.category_name: float(category.score)
                    for category in (result.face_blendshapes[0] if result.face_blendshapes else [])
                }
                feature = [
                    quantized_pose(pose[0], args.pose_step),
                    quantized_pose(pose[1], args.pose_step),
                    quantized_pose(pose[2], args.pose_step),
                    *(round(scores.get(key, 0.0), 5) for key in BLEND_KEYS),
                ]
                source_meta = metadata.get(relative_path, {})
                entry = {
                    "id": source_digest[:24],
                    "name": source_meta.get("title") or source_path.stem,
                    "pack": pack_name,
                    "offset": pack_offset,
                    "length": pack_length,
                    "feature": feature,
                    "shape": encode_structure(structure),
                    "mesh": encode_structure(surface),
                    "projection": encode_structure(projection),
                    "layout": [round(value, 6) for value in layout],
                    "sourceName": source_meta.get("source_name", "Local catalog"),
                    "sourceUrl": source_meta.get("source_url", ""),
                    "creator": source_meta.get("creator", ""),
                    "license": source_meta.get("license", "Unspecified"),
                    "licenseUrl": source_meta.get("license_url", ""),
                }
                shards[f"{yaw}:{pitch}"].append(entry)
            except Exception as exc:  # continue a long batch after corrupt files
                rejected += 1
                print(f"\nRejected {relative_path}: {exc}", file=sys.stderr)

            if index % 25 == 0 or index == len(files):
                accepted = sum(len(items) for items in shards.values())
                print(
                    f"\r{index}/{len(files)} checked | {accepted} accepted | "
                    f"{rejected} rejected | {duplicates} duplicates | {outside} outside",
                    end="",
                    flush=True,
                )
    print()
    if pack_handle is not None:
        pack_handle.close()

    cells: dict[str, dict[str, Any]] = {}
    for key, entries in sorted(shards.items()):
        yaw, pitch = (int(value) for value in key.split(":"))
        base_filename = cell_filename(yaw, pitch).removesuffix(".json")
        shard_files: list[str] = []
        for chunk_index in range(0, len(entries), SHARD_ENTRY_LIMIT):
            filename = f"{base_filename}_{chunk_index // SHARD_ENTRY_LIMIT:03d}.json"
            chunk = entries[chunk_index : chunk_index + SHARD_ENTRY_LIMIT]
            with (shards_dir / filename).open("w", encoding="utf-8") as handle:
                json.dump(
                    {"cell": key, "items": chunk},
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            shard_files.append(filename)
        cells[key] = {"count": len(entries), "shards": shard_files}

    total_faces = sum(cell["count"] for cell in cells.values())
    manifest = {
        "schemaVersion": 3,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totalFaces": total_faces,
        "poseStep": args.pose_step,
        "bounds": {
            "yawMin": args.yaw_min,
            "yawMax": args.yaw_max,
            "pitchMin": args.pitch_min,
            "pitchMax": args.pitch_max,
        },
        "outputSize": args.size,
        "shapeVersion": "mediapipe-projection-468-v4",
        "meshPoints": len(DETAIL_LANDMARKS),
        "projectionPoints": 468,
        "featureSchema": "mediapipe-face-actions-v2",
        "featureLength": 3 + len(BLEND_KEYS),
        "shardsContainGeometry": True,
        "cells": cells,
        "stats": {
            "checked": len(files),
            "accepted": total_faces,
            "rejected": rejected,
            "duplicates": duplicates,
            "outsideBounds": outside,
        },
    }
    with (output_dir / "manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))

    print(
        f"Catalog ready: {total_faces} faces across {len(cells)} pose cells "
        f"in {pack_index} packs"
    )
    print(f"Choose this directory in the site's catalog uploader: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
