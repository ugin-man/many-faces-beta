#!/usr/bin/env python3
"""CPU/IMAGE fallback extractor when this executor cannot launch Chromium.

This intentionally does not claim pixel or inference equivalence to the browser.
All valid detected frames are passed to the unchanged production JavaScript
feature/geometry conversion by prepare-queries-native.mjs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import time
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    source_assets = {
        name: {'bytes': source.stat().st_size, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}
        for name, source in [('video', args.video), ('model', args.model)]
    }
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise RuntimeError('Cannot decode the fixed sample')
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    assert (width, height, count) == (768, 768, 1061)
    assert abs(fps - 30.0) < 1e-9
    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.model), delegate=python.BaseOptions.Delegate.CPU),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.45,
        min_face_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )
    started = time.perf_counter()
    observed = 0
    face_frames = 0
    evidence = []
    pixel_digest = hashlib.sha256()
    with vision.FaceLandmarker.create_from_options(options) as landmarker, \
            (args.out / 'queries.native-landmarks.jsonl').open('w') as output:
        while True:
            ok, bgr = capture.read()
            if not ok:
                break
            if observed >= count:
                raise RuntimeError('Decoder produced more frames than the fixed sample')
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            assert rgb.shape == (height, width, 3)
            pixel_digest.update(rgb.tobytes())
            result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            present = bool(result.face_landmarks and result.face_blendshapes)
            row = {'sourceFrameIndex': observed, 'time': observed / fps,
                   'width': width, 'height': height, 'landmarks': [],
                   'matrixColumnMajor': [], 'categories': []}
            if present:
                face_frames += 1
                row['landmarks'] = [{'x': float(p.x), 'y': float(p.y), 'z': float(p.z)}
                                    for p in result.face_landmarks[0]]
                row['categories'] = [{'categoryName': p.category_name, 'score': float(p.score)}
                                     for p in result.face_blendshapes[0]]
                if result.facial_transformation_matrixes:
                    matrix = np.asarray(result.facial_transformation_matrixes[0])
                    assert matrix.shape == (4, 4)
                    row['matrixColumnMajor'] = [float(x) for x in matrix.ravel(order='F')]
            output.write(json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n')
            evidence.append({'sourceFrameIndex': observed, 'time': observed / fps,
                             'landmarksAndBlendshapes': present,
                             'decodedPositionMs': float(capture.get(cv2.CAP_PROP_POS_MSEC))})
            observed += 1
            if observed % 100 == 0 or observed == count:
                print('QUERY_PROGRESS ' + json.dumps({'frames': observed, 'total': count, 'detected': face_frames}), flush=True)
    capture.release()
    assert observed == count, f'Incomplete frame coverage: {observed}/{count}'
    report = {
        'schema': 'many-faces-native-query-extraction-v1',
        'python': platform.python_version(), 'mediapipe': mp.__version__,
        'opencv': cv2.__version__, 'numpy': np.__version__,
        'analyzer': {'mode': 'IMAGE', 'delegate': 'CPU', 'execution': 'python-native'},
        'decoder': 'OpenCV VideoCapture sequential native 30 fps, BGR converted to RGB; no resizing or frame selection',
        'width': width, 'height': height, 'fps': fps, 'duration': count / fps,
        'plannedFrames': count, 'decodedFrames': observed, 'faceFrames': face_frames,
        'elapsedMs': (time.perf_counter() - started) * 1000,
        'rgbFrameStreamSha256': pixel_digest.hexdigest(), 'evidence': evidence,
        'matrixConvention': 'Python row-major 4x4 values repacked column-major for unchanged catalogPoseFromWebMatrix',
        'sourceAssets': source_assets,
        'rawLandmarkStreamSha256': hashlib.sha256((args.out / 'queries.native-landmarks.jsonl').read_bytes()).hexdigest(),
        'limitation': 'Native MediaPipe and OpenCV are a fallback diagnostic input definition, not an assertion of browser pixel/inference equivalence.',
    }
    (args.out / 'queries.native-extraction.json').write_text(json.dumps(report, indent=2) + '\n')
    print('QUERY_NATIVE_COMPLETE ' + json.dumps({'decoded': observed, 'detected': face_frames}), flush=True)


if __name__ == '__main__':
    main()
