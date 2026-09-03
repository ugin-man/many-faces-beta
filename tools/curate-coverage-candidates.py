#!/usr/bin/env python3
"""Measure staged faces and keep only images that fill catalog coverage gaps.

Two modes are supported:
- strict target mode: search hints specify the expected pose/configuration;
- route-any-gap mode: broad face crops are measured first, then assigned to the
  highest-pressure compatible gap in a coverage plan.
"""

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

from coverage_router import CoverageRouter

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)

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
    parser.add_argument("staging", type=Path, help="Directory containing images and metadata.csv")
    parser.add_argument("output", type=Path, help="Accepted image directory")
    parser.add_argument("--model", type=Path, default=Path(".models/face_landmarker.task"))
    parser.add_argument("--yaw-tolerance", type=float, default=12.0)
    parser.add_argument("--pitch-tolerance", type=float, default=15.0)
    parser.add_argument("--min-face-area", type=float, default=0.08)
    parser.add_argument("--max-files", type=int, default=0)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--coverage-plan", type=Path)
    parser.add_argument("--route-any-gap", action="store_true")
    parser.add_argument("--route-yaw-tolerance", type=float, default=9.0)
    parser.add_argument("--route-pitch-tolerance", type=float, default=9.0)
    args = parser.parse_args()
    if args.route_any_gap and not args.coverage_plan:
        parser.error("--route-any-gap requires --coverage-plan")
    if args.coverage_plan and not args.route_any_gap:
        parser.error("--coverage-plan currently requires --route-any-gap")
    return args


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
        yaw / (math.pi / 2) * 90,
        pitch * 1.4 / (math.pi / 2) * 90,
        roll / (math.pi / 2) * 90,
    )


def difference_hash(image: Image.Image) -> str:
    pixels = np.asarray(image.convert("L").resize((9, 8), Image.Resampling.BILINEAR))
    bits = pixels[:, 1:] > pixels[:, :-1]
    value = sum(int(bit) << index for index, bit in enumerate(bits.reshape(-1)))
    return f"{value:016x}"


def hamming(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def classify(scores: dict[str, float], landmarks: list[Any], yaw: float) -> set[str]:
    def value(key: str) -> float:
        return max(0.0, min(1.0, float(scores.get(key, 0.0))))

    result: set[str] = set()
    left_blink = value("eyeBlinkLeft")
    right_blink = value("eyeBlinkRight")
    left_aperture = abs(float(landmarks[159].y) - float(landmarks[145].y))
    right_aperture = abs(float(landmarks[386].y) - float(landmarks[374].y))
    absolute_yaw = abs(yaw)

    def wink_pass(delta: float, closed: float, opened: float) -> bool:
        if opened <= 1e-5:
            return False
        ratio = closed / opened
        if absolute_yaw <= 18:
            return delta >= 0.28 and ratio <= 0.76
        if absolute_yaw <= 30:
            return delta >= 0.34 and ratio <= 0.62
        if absolute_yaw <= 45:
            return delta >= 0.42 and ratio <= 0.50
        return False

    # MediaPipe names anatomical sides; image-space landmark groups are mirrored.
    if wink_pass(left_blink - right_blink, right_aperture, left_aperture):
        result.add("winkLeft")
    if wink_pass(right_blink - left_blink, left_aperture, right_aperture):
        result.add("winkRight")
    if min(left_blink, right_blink) >= 0.42:
        result.add("blink")
    if (value("eyeWideLeft") + value("eyeWideRight")) / 2 >= 0.22:
        result.add("eyesWide")
    if (value("eyeLookUpLeft") + value("eyeLookUpRight")) / 2 >= 0.20:
        result.add("gazeUp")
    if (value("eyeLookDownLeft") + value("eyeLookDownRight")) / 2 >= 0.20:
        result.add("gazeDown")
    if (value("eyeLookOutLeft") + value("eyeLookInRight")) / 2 >= 0.20:
        result.add("gazeLeft")
    if (value("eyeLookInLeft") + value("eyeLookOutRight")) / 2 >= 0.20:
        result.add("gazeRight")
    if max(value("browInnerUp"), value("browOuterUpLeft"), value("browOuterUpRight")) >= 0.24:
        result.add("browsUp")
    if (value("browDownLeft") + value("browDownRight")) / 2 >= 0.22:
        result.add("browsDown")

    smile_left = value("mouthSmileLeft")
    smile_right = value("mouthSmileRight")
    smile = (smile_left + smile_right) / 2
    jaw_open = value("jawOpen")
    funnel = value("mouthFunnel")
    pucker = value("mouthPucker")
    stretch = (value("mouthStretchLeft") + value("mouthStretchRight")) / 2
    frown = max(
        (value("mouthFrownLeft") + value("mouthFrownRight")) / 2,
        (value("browDownLeft") + value("browDownRight")) / 2,
    )
    if smile >= 0.27 and jaw_open < 0.25:
        result.add("smileClosed")
    if smile >= 0.25 and jaw_open >= 0.25:
        result.add("smileOpen")
    if abs(smile_left - smile_right) >= 0.20 and max(smile_left, smile_right) >= 0.25:
        result.add("smileAsymmetric")
    if frown >= 0.22:
        result.add("frown")
    if jaw_open >= 0.31:
        result.add("mouthOpen")
    if max(funnel, pucker) >= 0.25 and stretch < 0.25:
        result.add("mouthRound")
    if stretch >= 0.28:
        result.add("mouthWide")
    if max(pucker, funnel * 0.8) >= 0.28:
        result.add("pucker")
    if value("mouthLeft") >= 0.22:
        result.add("mouthLeft")
    if value("mouthRight") >= 0.22:
        result.add("mouthRight")
    if (value("mouthPressLeft") + value("mouthPressRight")) / 2 >= 0.22:
        result.add("mouthPress")
    if max(value("mouthRollLower"), value("mouthRollUpper")) >= 0.22:
        result.add("mouthRoll")
    if max(value("mouthShrugLower"), value("mouthShrugUpper")) >= 0.22:
        result.add("mouthShrug")
    if (value("noseSneerLeft") + value("noseSneerRight")) / 2 >= 0.19:
        result.add("sneer")
    if value("jawLeft") >= 0.20:
        result.add("jawLeft")
    if value("jawRight") >= 0.20:
        result.add("jawRight")
    if value("jawForward") >= 0.20:
        result.add("jawForward")
    if not result:
        result.add("neutral")
    return result


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
    router = (
        CoverageRouter(
            args.coverage_plan.resolve(),
            yaw_tolerance=args.route_yaw_tolerance,
            pitch_tolerance=args.route_pitch_tolerance,
        )
        if args.route_any_gap
        else None
    )
    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model.resolve())),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=2,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.45,
        min_face_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )

    accepted_rows: list[dict[str, str]] = []
    hashes: list[str] = []
    reasons: Counter[str] = Counter()
    with vision.FaceLandmarker.create_from_options(options) as detector:
        for index, row in enumerate(rows, start=1):
            source = staging / row["relative_path"]
            try:
                with Image.open(source) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image)))
                if len(result.face_landmarks) != 1:
                    reasons["face_count"] += 1
                    continue
                landmarks = result.face_landmarks[0]
                xs = [float(point.x) for point in landmarks]
                ys = [float(point.y) for point in landmarks]
                face_area = (max(xs) - min(xs)) * (max(ys) - min(ys))
                if face_area < args.min_face_area:
                    reasons["face_too_small"] += 1
                    continue
                if not result.facial_transformation_matrixes or not result.face_blendshapes:
                    reasons["missing_features"] += 1
                    continue
                yaw, pitch, roll = pose_from_matrix(result.facial_transformation_matrixes[0])
                scores = {category.category_name: float(category.score) for category in result.face_blendshapes[0]}
                configurations = classify(scores, landmarks, yaw)

                if router is not None:
                    assignment = router.assign(yaw, pitch, configurations)
                    if assignment is None:
                        reasons["no_coverage_gap"] += 1
                        continue
                    target_pose = assignment.pose
                    target_configuration = assignment.configuration
                    target_pressure = f"{assignment.pressure:.6f}"
                else:
                    try:
                        target_yaw, target_pitch = (
                            float(value) for value in row["target_pose"].split(":")
                        )
                    except (KeyError, ValueError):
                        reasons["missing_target"] += 1
                        continue
                    if (
                        abs(yaw - target_yaw) > args.yaw_tolerance
                        or abs(pitch - target_pitch) > args.pitch_tolerance
                    ):
                        reasons["pose_mismatch"] += 1
                        continue
                    target_configuration = row.get("target_configuration", "")
                    if target_configuration not in configurations:
                        reasons["configuration_mismatch"] += 1
                        continue
                    target_pose = row["target_pose"]
                    target_pressure = row.get("target_pressure", "")

                visual_hash = difference_hash(image)
                if any(hamming(visual_hash, previous) <= 4 for previous in hashes):
                    reasons["visual_duplicate"] += 1
                    continue
                hashes.append(visual_hash)

                digest = hashlib.sha256(source.read_bytes()).hexdigest()[:20]
                destination_name = f"{len(accepted_rows):07d}-{digest}{source.suffix.lower()}"
                destination = image_output / destination_name
                shutil.copyfile(source, destination)
                output_row = dict(row)
                output_row["relative_path"] = f"images/{destination_name}"
                output_row["target_pose"] = target_pose
                output_row["target_configuration"] = target_configuration
                output_row["target_pressure"] = target_pressure
                output_row["measured_yaw"] = f"{yaw:.4f}"
                output_row["measured_pitch"] = f"{pitch:.4f}"
                output_row["measured_roll"] = f"{roll:.4f}"
                output_row["measured_configurations"] = "|".join(sorted(configurations))
                accepted_rows.append(output_row)
            except Exception as exc:
                reasons["error"] += 1
                print(f"warning {source}: {exc}", file=sys.stderr)
            if index % 25 == 0 or index == len(rows):
                print(
                    f"\r{index}/{len(rows)} checked | {len(accepted_rows)} accepted | "
                    f"{sum(reasons.values())} rejected",
                    end="",
                    flush=True,
                )
    print()

    columns = list(rows[0].keys()) if rows else []
    for extra in (
        "target_pose",
        "target_configuration",
        "target_pressure",
        "measured_yaw",
        "measured_pitch",
        "measured_roll",
        "measured_configurations",
    ):
        if extra not in columns:
            columns.append(extra)
    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(accepted_rows)
    report: dict[str, Any] = {
        "mode": "route-any-gap" if router is not None else "strict-target",
        "checked": len(rows),
        "accepted": len(accepted_rows),
        "rejected": sum(reasons.values()),
        "reasons": dict(reasons),
    }
    if router is not None:
        report["coverageRouting"] = router.report()
    (output / "curation-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if accepted_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
