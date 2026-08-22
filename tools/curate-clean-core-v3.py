#!/usr/bin/env python3
"""Curate strict and clean one-family fallback faces for Clean Core v3."""

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

from clean_core_policy_v3 import (
    BLEND_KEYS, POLICY_VERSION, classify_assignment, classify_target_assisted,
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
    parser.add_argument("--min-face-area", type=float, default=0.075)
    parser.add_argument("--min-sharpness", type=float, default=44.0)
    parser.add_argument("--min-contrast", type=float, default=23.0)
    parser.add_argument("--min-colorfulness", type=float, default=4.5)
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
    return yaw / (math.pi / 2), max(-1.0, min(1.0, pitch * 1.4 / (math.pi / 2))), roll / (math.pi / 2)


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
    if span < .01:
        return None
    center = ((left[0] + right[0]) / 2, (left[1] + right[1]) / 2)
    cosine, sine = dx / span, dy / span
    output: list[float] = []
    for item in landmarks[:468]:
        rx, ry = float(item.x) - center[0], float(item.y) - center[1]
        output.extend(((rx * cosine + ry * sine) / span, (-rx * sine + ry * cosine) / span))
    return output


def difference_hash(image: Image.Image) -> str:
    pixels = np.asarray(image.convert("L").resize((9, 8), Image.Resampling.BILINEAR))
    bits = pixels[:, 1:] > pixels[:, :-1]
    return f"{sum(int(bit) << index for index, bit in enumerate(bits.reshape(-1))):016x}"


def hamming(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def image_quality(image: Image.Image) -> dict[str, float]:
    pixels = np.asarray(image.resize((128, 128), Image.Resampling.BILINEAR), dtype=np.float32)
    gray = pixels[:, :, 0] * .299 + pixels[:, :, 1] * .587 + pixels[:, :, 2] * .114
    laplacian = (-4 * gray + np.roll(gray, 1, 0) + np.roll(gray, -1, 0) + np.roll(gray, 1, 1) + np.roll(gray, -1, 1))[1:-1, 1:-1]
    red_green = pixels[:, :, 0] - pixels[:, :, 1]
    yellow_blue = (pixels[:, :, 0] + pixels[:, :, 1]) / 2 - pixels[:, :, 2]
    colorfulness = math.sqrt(float(red_green.var() + yellow_blue.var())) + .3 * math.sqrt(float(red_green.mean() ** 2 + yellow_blue.mean() ** 2))
    return {
        "sharpness": float(laplacian.var()), "brightness": float(gray.mean()),
        "contrast": float(gray.std()), "colorfulness": colorfulness,
        "clippedFraction": float(((gray < 8) | (gray > 247)).mean()),
    }


def title_rejection(row: dict[str, str], group: str) -> str | None:
    text = " ".join((row.get("title", ""), row.get("target_query", ""))).lower()
    if any(term in text for term in ARTWORK_TERMS):
        return "likely_artwork"
    if group == "mouth" and any(term in text for term in MOUTH_OCCLUSION_TERMS):
        return "mouth_occlusion_title"
    return None


def face_bounds(landmarks: list[Any]) -> tuple[float, float, float, float, float]:
    xs = [float(point.x) for point in landmarks]
    ys = [float(point.y) for point in landmarks]
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    return cx, cy, width, height, width * height


def choose_face(result: Any, min_face_area: float) -> int | None:
    choices = []
    for index, landmarks in enumerate(result.face_landmarks):
        cx, cy, width, height, area = face_bounds(landmarks)
        if area < min_face_area or width < .28 or height < .34:
            continue
        center_distance = math.hypot((cx - .5) / .32, (cy - .5) / .36)
        score = area * 2.4 - center_distance * .32
        choices.append((score, index))
    return max(choices)[1] if choices else None


def main() -> int:
    args = parse_args()
    staging, output = args.staging.resolve(), args.output.resolve()
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
        raise SystemExit("MediaPipe is missing. Install tools/requirements-catalog.txt") from exc

    rows = read_rows(staging)
    if args.max_files > 0:
        rows = rows[:args.max_files]
    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model.resolve())),
        running_mode=vision.RunningMode.IMAGE, num_faces=4,
        output_face_blendshapes=True, output_facial_transformation_matrixes=True,
        min_face_detection_confidence=.45, min_face_presence_confidence=.45,
        min_tracking_confidence=.45,
    )
    accepted_rows: list[dict[str, str]] = []
    hashes_by_prefix: dict[str, list[str]] = {}
    reasons: Counter[str] = Counter(); profiles: Counter[str] = Counter(); tiers: Counter[str] = Counter(); pose_cells: Counter[str] = Counter()

    with vision.FaceLandmarker.create_from_options(options) as detector:
        for index, row in enumerate(rows, start=1):
            source = staging / row["relative_path"]
            try:
                with Image.open(source) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                quality = image_quality(image)
                if quality["sharpness"] < args.min_sharpness: reasons["blur"] += 1; continue
                if not 34 <= quality["brightness"] <= 220: reasons["brightness"] += 1; continue
                if quality["contrast"] < args.min_contrast: reasons["low_contrast"] += 1; continue
                if quality["colorfulness"] < args.min_colorfulness: reasons["low_colorfulness"] += 1; continue
                if quality["clippedFraction"] > .42: reasons["clipping"] += 1; continue

                result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image)))
                face_index = choose_face(result, args.min_face_area)
                if face_index is None: reasons["no_usable_face"] += 1; continue
                if face_index >= len(result.facial_transformation_matrixes) or face_index >= len(result.face_blendshapes):
                    reasons["missing_features"] += 1; continue
                landmarks = result.face_landmarks[face_index]
                cx, cy, width, height, area = face_bounds(landmarks)
                if not .12 <= cx <= .88 or not .12 <= cy <= .88:
                    reasons["face_off_center"] += 1; continue

                pose = pose_from_matrix(result.facial_transformation_matrixes[face_index])
                scores = {category.category_name: float(category.score) for category in result.face_blendshapes[face_index]}
                feature = [pose[0], pose[1], pose[2], *(scores.get(key, 0.0) for key in BLEND_KEYS)]
                projection = canonical_projection(landmarks)
                trusted_annotation = (
                    row.get("annotation_verified", "").strip().lower() in {"1", "true", "yes"}
                    or "synthetic humans facs" in row.get("source_name", "").lower()
                )
                assisted = None
                if trusted_annotation and row.get("target_configuration"):
                    assisted = classify_target_assisted(row["target_configuration"], feature, projection)
                assignment = (assisted, "strict") if assisted is not None else classify_assignment(feature, projection)
                if assignment is None: reasons["mixed_or_unsupported_state"] += 1; continue
                profile, tier = assignment
                title_reason = title_rejection(row, "mouth" if "mouth" in profile.group else profile.group)
                if title_reason: reasons[title_reason] += 1; continue

                visual_hash = difference_hash(image); prefix = visual_hash[:4]
                nearby = hashes_by_prefix.setdefault(prefix, [])
                if any(hamming(visual_hash, previous) <= 3 for previous in nearby):
                    reasons["visual_duplicate"] += 1; continue
                nearby.append(visual_hash)

                digest = hashlib.sha256(source.read_bytes()).hexdigest()[:20]
                destination_name = f"{len(accepted_rows):07d}-{digest}{source.suffix.lower()}"
                shutil.copyfile(source, image_output / destination_name)
                output_row = dict(row)
                output_row.update({
                    "relative_path": f"images/{destination_name}",
                    "clean_profile": profile.name, "clean_group": profile.group, "clean_tier": tier,
                    "clean_purity": f"{profile.purity:.6f}", "clean_strength": f"{profile.strength:.6f}",
                    "clean_leakage": f"{profile.leakage:.6f}",
                    "measured_yaw": f"{profile.yaw:.4f}", "measured_pitch": f"{profile.pitch:.4f}",
                    "measured_roll": f"{profile.roll:.4f}",
                    "quality_sharpness": f"{quality['sharpness']:.4f}",
                    "quality_brightness": f"{quality['brightness']:.4f}",
                    "quality_contrast": f"{quality['contrast']:.4f}",
                    "quality_colorfulness": f"{quality['colorfulness']:.4f}",
                    "selected_face_index": str(face_index), "detected_faces": str(len(result.face_landmarks)),
                    "policy_version": POLICY_VERSION,
                })
                accepted_rows.append(output_row); profiles[profile.name] += 1; tiers[tier] += 1
                pose_cells[f"{round(profile.yaw / 3) * 3}:{round(profile.pitch / 3) * 3}"] += 1
            except Exception as exc:
                reasons["error"] += 1
                print(f"warning {source}: {exc}", file=sys.stderr)
            if index % 250 == 0 or index == len(rows):
                print(f"{index}/{len(rows)} checked | {len(accepted_rows)} clean | {sum(reasons.values())} rejected", flush=True)

    columns = list(rows[0].keys()) if rows else []
    extras = (
        "clean_profile", "clean_group", "clean_tier", "clean_purity", "clean_strength", "clean_leakage",
        "measured_yaw", "measured_pitch", "measured_roll", "quality_sharpness",
        "quality_brightness", "quality_contrast", "quality_colorfulness",
        "selected_face_index", "detected_faces", "policy_version",
    )
    for extra in extras:
        if extra not in columns: columns.append(extra)
    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns); writer.writeheader(); writer.writerows(accepted_rows)
    report: dict[str, Any] = {
        "policyVersion": POLICY_VERSION, "checked": len(rows), "accepted": len(accepted_rows),
        "rejected": sum(reasons.values()), "yield": len(accepted_rows) / max(1, len(rows)),
        "reasons": dict(reasons), "profiles": dict(sorted(profiles.items())), "tiers": dict(sorted(tiers.items())), "poseCells": len(pose_cells),
    }
    (output / "clean-curation-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if accepted_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
