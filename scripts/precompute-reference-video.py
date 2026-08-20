#!/usr/bin/env python3
"""Precompute Face Landmarker frames for the bundled verification video."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import struct
import sys
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


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


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def quantize_pose(value: float) -> float:
    degrees = clamp(value * 90.0, -45.0, 45.0)
    return round(degrees / 3.0) * 3.0 / 90.0


def encoded_vector(values: list[float]) -> str:
    quantized = [round(clamp(value * 4096.0, -32768.0, 32767.0)) for value in values]
    return base64.b64encode(struct.pack(f"<{len(quantized)}h", *quantized)).decode("ascii")


def midpoint(points: list[tuple[float, float, float]], left: int, right: int) -> tuple[float, float]:
    return (
        (points[left][0] + points[right][0]) / 2.0,
        (points[left][1] + points[right][1]) / 2.0,
    )


def distance_2d(left: tuple[float, float], right: tuple[float, float]) -> float:
    return math.hypot(left[0] - right[0], left[1] - right[1])


def face_geometry(landmarks, aspect: float) -> dict[str, object] | None:
    if len(landmarks) <= 454:
        return None
    original = [(float(point.x), float(point.y), float(point.z)) for point in landmarks]
    points = [(x * aspect, y, z) for x, y, z in original]
    left_eye = midpoint(points, 33, 133)
    right_eye = midpoint(points, 362, 263)
    eye_span = distance_2d(left_eye, right_eye)
    if eye_span < 0.01:
        return None
    eyes_center = (
        (left_eye[0] + right_eye[0]) / 2.0,
        (left_eye[1] + right_eye[1]) / 2.0,
    )
    eye_dx = right_eye[0] - left_eye[0]
    eye_dy = right_eye[1] - left_eye[1]
    cosine = eye_dx / eye_span
    sine = eye_dy / eye_span

    def landmark_distance(left: int, right: int) -> float:
        return distance_2d(points[left][:2], points[right][:2])

    def ratio(value: float) -> float:
        return value / eye_span

    def canonical(index: int) -> list[float]:
        x, y, z = points[index]
        relative_x = x - eyes_center[0]
        relative_y = y - eyes_center[1]
        return [
            (relative_x * cosine + relative_y * sine) / eye_span,
            (-relative_x * sine + relative_y * cosine) / eye_span,
            z / eye_span,
        ]

    structure = [
        ratio(landmark_distance(234, 454)),
        ratio(landmark_distance(10, 152)),
        ratio(landmark_distance(172, 397)),
        ratio(landmark_distance(127, 356)),
        ratio(landmark_distance(98, 327)),
        ratio(distance_2d(eyes_center, points[2][:2])),
        ratio(landmark_distance(33, 133)),
        ratio(landmark_distance(362, 263)),
        ratio(landmark_distance(2, 152)),
    ]
    for index in STABLE_LANDMARKS:
        structure.extend(canonical(index))
    surface: list[float] = []
    for index in DETAIL_LANDMARKS:
        surface.extend(canonical(index))
    projection: list[float] = []
    for index in range(min(468, len(points))):
        x, y, _ = canonical(index)
        projection.extend((x, y))

    xs = [point[0] for point in original]
    ys = [point[1] for point in original]
    return {
        "shape": encoded_vector(structure),
        "mesh": encoded_vector(surface),
        "projection": encoded_vector(projection),
        "layout": [
            (min(xs) + max(xs)) / 2.0,
            (min(ys) + max(ys)) / 2.0,
            max(xs) - min(xs),
            max(ys) - min(ys),
        ],
    }


def pose_feature(matrix, blendshapes) -> list[float]:
    flat = list(matrix.reshape(-1)) if matrix is not None else []
    pose = [0.0, 0.0, 0.0]
    if len(flat) >= 11:
        pitch = math.atan2(float(flat[9]), float(flat[10]))
        yaw = math.atan2(-float(flat[8]), math.hypot(float(flat[9]), float(flat[10])))
        roll = math.atan2(float(flat[4]), float(flat[0]))
        pose = [
            quantize_pose(yaw / (math.pi / 2.0)),
            quantize_pose(pitch * 1.4 / (math.pi / 2.0)),
            quantize_pose(roll / (math.pi / 2.0)),
        ]
    scores = {category.category_name: float(category.score) for category in blendshapes}
    return [*pose, *(scores.get(key, 0.0) for key in BLEND_KEYS)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise SystemExit(f"Could not open {args.video}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps

    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(
            model_asset_path=str(args.model),
            delegate=python.BaseOptions.Delegate.CPU,
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.45,
        min_face_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )
    frames: list[dict[str, object]] = []
    # Keep the native task alive until the payload has been written. Some
    # sandboxed Linux hosts cannot tear down MediaPipe's EGL sidecar cleanly.
    landmarker = vision.FaceLandmarker.create_from_options(options)
    if landmarker:
        index = 0
        while True:
            ok, image = capture.read()
            if not ok:
                break
            timestamp_ms = round(index * 1000.0 / fps)
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb),
                timestamp_ms,
            )
            if result.face_landmarks and result.face_blendshapes:
                geometry = face_geometry(result.face_landmarks[0], width / max(1, height))
                if geometry:
                    matrix = result.facial_transformation_matrixes[0] \
                        if result.facial_transformation_matrixes else None
                    frames.append({
                        "time": index / fps,
                        "feature": pose_feature(matrix, result.face_blendshapes[0]),
                        **geometry,
                    })
            index += 1
            if index % 60 == 0:
                print(f"{index}/{frame_count} frames", flush=True)
    capture.release()

    if len(frames) < 2:
        raise SystemExit("Face Landmarker did not produce enough frames")
    payload = {
        "schemaVersion": 1,
        "videoUrl": "/test-fixtures/reference-face-motion.mp4",
        "videoName": "FIXTURE / IMG_3665.mp4",
        "duration": duration,
        "sampleRate": fps,
        "sourceWidth": width,
        "sourceHeight": height,
        "frames": frames,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    pitches = [float(frame["feature"][1]) * 90.0 for frame in frames]
    wink_deltas = [abs(float(frame["feature"][13]) - float(frame["feature"][14])) for frame in frames]
    print(
        f"wrote {len(frames)}/{frame_count} frames, "
        f"pitch {min(pitches):.1f}..{max(pitches):.1f} deg, "
        f"max blink asymmetry {max(wink_deltas):.3f}: {args.output}",
        flush=True,
    )
    # Exit while the task is still referenced; see the EGL teardown note above.
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
