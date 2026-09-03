#!/usr/bin/env python3
"""Curate isolated single-factor face states from staged image crops."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import sys
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from clean_core_policy import (
    BLEND_KEYS,
    POLICY_VERSION,
    classify_clean_profile,
)

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("staging", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", type=Path, default=Path(".models/face_landmarker.task"))
    parser.add_argument("--min-face-area", type=float, default=0.10)
    parser.add_argument("--min-sharpness", type=float, default=55.0)
    parser.add_argument("--min-contrast", type=float, default=28.0)
    parser.add_argument("--min-colorfulness", type=float, default=7.0)
    parser.add_argument("--max-files", type=int, default=0)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def ensure_model(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(MODEL_URL, path)


def read_rows(staging: Path) -> list[dict[str, str]]:
    with (staging / "metadata.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def pose_from_matrix(matrix: Any) -> tuple[float, float, float]:
    values = np.asarray(getattr(matrix, "data", matrix), dtype=np.float64).reshape(-1)
    if values.size < 11:
        return 0.0, 0.0, 0.0
    pitch = math.atan2(float(values[9]), float(values[10]))
    yaw = math.atan2(-float(values[8]), math.hypot(float(values[9]), float(values[10])))
    roll = math.atan2(float(values[4]), float(values[0]))
    return (
        yaw / (math.pi / 2),
        max(-1.0, min(1.0, pitch * 1.4 / (math.pi / 2))),
        roll / (math.pi / 2),
    )


def canonical_projection(landmarks: list[Any]) -> list[float] | None:
    if len(landmarks) <= 454:
        return None

    def point(index: int) -> tuple[float, float]:
        return float(landmarks[index].x), float(landmarks[index].y)

    left_a, left_b = point(33), point(133)
    right_a, right_b = point(362), point(263)
    left = ((left_a[0] + left_b[0]) / 2, (left_a[1] + left_b[1]) / 2)
    right = ((right_a[0] + right_b[0]) / 2, (right_a[1] + right_b[1]) / 2)
    dx, dy = right[0] - left[0], right[1] - left[1]
    span = math.hypot(dx, dy)
    if span < 0.01:
        return None
    center = ((left[0] + right[0]) / 2, (left[1] + right[1]) / 2)
    cosine, sine = dx / span, dy / span
    output: list[float] = []
    for item in landmarks[:468]:
        relative_x = float(item.x) - center[0]
        relative_y = float(item.y) - center[1]
        output.extend((
            (relative_x * cosine + relative_y * sine) / span,
            (-relative_x * sine + relative_y * cosine) / span,
        ))
    return output


def difference_hash(image: Image.Image) -> str:
    pixels = np.asarray(image.convert("L").resize((9, 8), Image.Resampling.BILINEAR))
    bits = pixels[:, 1:] > pixels[:, :-1]
    value = sum(int(bit) << index for index, bit in enumerate(bits.reshape(-1)))
    return f"{value:016x}"


def hamming(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def image_quality(image: Image.Image) -> dict[str, float]:
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
    return {
        "sharpness": float(laplacian.var()),
        "brightness": float(gray.mean()),
        "contrast": float(gray.std()),
        "colorfulness": colorfulness,
        "clippedFraction": float(((gray < 8) | (gray > 247)).mean()),
    }


def title_rejection(row: dict[str, str], group: str) -> str | None:
    text = " ".join((
        row.get("title", ""),
        row.get("target_query", ""),
    )).lower()
    if any(term in text for term in ARTWORK_TERMS):
        return "likely_artwork"
    if group == "mouth" and any(term in text for term in MOUTH_OCCLUSION_TERMS):
        return "mouth_occlusion_title"
    return None


def main() -> int:
    args = parse_args()
    staging = args.staging.resolve()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty. Use --overwrite or choose another directory.")
    if args.overwrite and output.exists():
        shutil.rmtree(output)
    image_output = output / "images"
    image_output.mkdir(parents=True, exist_ok=True)
    ensure_model(args.model)

    try:
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        raise SystemExit(
            "MediaPipe is missing. Run: python -m pip install -r tools/requirements-catalog.txt"
        ) from exc

    rows = read_rows(staging)
    if args.max_files > 0:
        rows = rows[: args.max_files]

    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model.resolve())),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=2,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.50,
        min_face_presence_confidence=0.50,
        min_tracking_confidence=0.50,
    )

    accepted_rows: list[dict[str, str]] = []
    hashes_by_prefix: dict[str, list[str]] = {}
    reasons: Counter[str] = Counter()
    profiles: Counter[str] = Counter()
    pose_cells: Counter[str] = Counter()

    with vision.FaceLandmarker.create_from_options(options) as detector:
        for index, row in enumerate(rows, start=1):
            source = staging / row["relative_path"]
            try:
                with Image.open(source) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                quality = image_quality(image)
                if quality["sharpness"] < args.min_sharpness:
                    reasons["blur"] += 1
                    continue
                if not 42 <= quality["brightness"] <= 210:
                    reasons["brightness"] += 1
                    continue
                if quality["contrast"] < args.min_contrast:
                    reasons["low_contrast"] += 1
                    continue
                if quality["colorfulness"] < args.min_colorfulness:
                    reasons["low_colorfulness"] += 1
                    continue
                if quality["clippedFraction"] > 0.36:
                    reasons["clipping"] += 1
                    continue

                result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image)))
                if len(result.face_landmarks) != 1:
                    reasons["face_count"] += 1
                    continue
                landmarks = result.face_landmarks[0]
                xs = [float(point.x) for point in landmarks]
                ys = [float(point.y) for point in landmarks]
                width, height = max(xs) - min(xs), max(ys) - min(ys)
                face_area = width * height
                center_x, center_y = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
                if face_area < args.min_face_area or width < 0.34 or height < 0.42:
                    reasons["face_too_small"] += 1
                    continue
                if not 0.20 <= center_x <= 0.80 or not 0.20 <= center_y <= 0.82:
                    reasons["face_off_center"] += 1
                    continue
                if not result.facial_transformation_matrixes or not result.face_blendshapes:
                    reasons["missing_features"] += 1
                    continue

                pose = pose_from_matrix(result.facial_transformation_matrixes[0])
                scores = {
                    category.category_name: float(category.score)
                    for category in result.face_blendshapes[0]
                }
                feature = [pose[0], pose[1], pose[2], *(scores.get(key, 0.0) for key in BLEND_KEYS)]
                projection = canonical_projection(landmarks)
                profile = classify_clean_profile(feature, projection)
                if profile is None:
                    reasons["mixed_or_unsupported_state"] += 1
                    continue
                title_reason = title_rejection(row, profile.group)
                if title_reason:
                    reasons[title_reason] += 1
                    continue

                visual_hash = difference_hash(image)
                prefix = visual_hash[:4]
                nearby_hashes = hashes_by_prefix.setdefault(prefix, [])
                if any(hamming(visual_hash, previous) <= 4 for previous in nearby_hashes):
                    reasons["visual_duplicate"] += 1
                    continue
                nearby_hashes.append(visual_hash)

                digest = hashlib.sha256(source.read_bytes()).hexdigest()[:20]
                destination_name = f"{len(accepted_rows):07d}-{digest}{source.suffix.lower()}"
                destination = image_output / destination_name
                shutil.copyfile(source, destination)

                output_row = dict(row)
                output_row["relative_path"] = f"images/{destination_name}"
                output_row["clean_profile"] = profile.name
                output_row["clean_group"] = profile.group
                output_row["clean_purity"] = f"{profile.purity:.6f}"
                output_row["clean_strength"] = f"{profile.strength:.6f}"
                output_row["clean_leakage"] = f"{profile.leakage:.6f}"
                output_row["measured_yaw"] = f"{profile.yaw:.4f}"
                output_row["measured_pitch"] = f"{profile.pitch:.4f}"
                output_row["measured_roll"] = f"{profile.roll:.4f}"
                output_row["quality_sharpness"] = f"{quality['sharpness']:.4f}"
                output_row["quality_brightness"] = f"{quality['brightness']:.4f}"
                output_row["quality_contrast"] = f"{quality['contrast']:.4f}"
                output_row["quality_colorfulness"] = f"{quality['colorfulness']:.4f}"
                output_row["policy_version"] = POLICY_VERSION
                accepted_rows.append(output_row)
                profiles[profile.name] += 1
                pose_cells[
                    f"{round(profile.yaw / 3) * 3}:{round(profile.pitch / 3) * 3}"
                ] += 1
            except Exception as exc:
                reasons["error"] += 1
                print(f"warning {source}: {exc}", file=sys.stderr)

            if index % 100 == 0 or index == len(rows):
                print(
                    f"\r{index}/{len(rows)} checked | {len(accepted_rows)} clean | "
                    f"{sum(reasons.values())} rejected",
                    end="",
                    flush=True,
                )
    print()

    columns = list(rows[0].keys()) if rows else []
    for extra in (
        "clean_profile", "clean_group", "clean_purity", "clean_strength", "clean_leakage",
        "measured_yaw", "measured_pitch", "measured_roll",
        "quality_sharpness", "quality_brightness", "quality_contrast",
        "quality_colorfulness", "policy_version",
    ):
        if extra not in columns:
            columns.append(extra)
    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(accepted_rows)

    report: dict[str, Any] = {
        "policyVersion": POLICY_VERSION,
        "checked": len(rows),
        "accepted": len(accepted_rows),
        "rejected": sum(reasons.values()),
        "yield": len(accepted_rows) / max(1, len(rows)),
        "reasons": dict(reasons),
        "profiles": dict(sorted(profiles.items())),
        "poseCells": len(pose_cells),
    }
    (output / "clean-curation-report.json").write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2))
    return 0 if accepted_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
