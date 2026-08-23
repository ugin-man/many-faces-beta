#!/usr/bin/env python3
"""Run the Clean Core v3 curator with synthetic-only framing handling.

Synthetic Humans FACS uses controlled renders whose backgrounds and framing do
not resemble the natural portrait sources. The generic curator previously
rejected every one of the 4,055 single-AU frames before profile verification:
first on whole-frame exposure and, after that was corrected, on portrait-size
thresholds. For this controlled CC BY 4.0 source only we therefore:

- ignore whole-frame brightness/clipping caused by the render background;
- choose the largest plausible detected face even when it occupies much less
  of the canvas than an Open Images portrait.

MediaPipe detection/features, target-assisted FACS verification, cross-family
leakage rejection, duplicate checks, sharpness, contrast and colorfulness are
still enforced. The generic natural-image curator is not modified.
"""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET = HERE / "curate-clean-core-v3.py"
spec = importlib.util.spec_from_file_location("many_faces_curate_clean_core_v3_facs", TARGET)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load {TARGET}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

_base_quality = module.image_quality


def synthetic_quality(image):
    metrics = dict(_base_quality(image))
    # Render backgrounds are intentionally near-white/near-black and should not
    # reject an otherwise sharp, measurable face.
    metrics["brightness"] = min(220.0, max(34.0, float(metrics["brightness"])))
    metrics["clippedFraction"] = min(0.41, float(metrics["clippedFraction"]))
    return metrics


def synthetic_choose_face(result, _min_face_area):
    """Choose the best detected MetaHuman face without portrait-size assumptions."""
    choices = []
    for index, landmarks in enumerate(result.face_landmarks):
        cx, cy, width, height, area = module.face_bounds(landmarks)
        # Natural portraits require roughly 28x34% of the frame. Synthetic FACS
        # renders may leave much more canvas around the head; a 5x6% face is
        # still plenty for MediaPipe because detection has already succeeded.
        if area < 0.0015 or width < 0.045 or height < 0.055:
            continue
        center_distance = math.hypot((cx - 0.5) / 0.50, (cy - 0.5) / 0.50)
        choices.append((area * 5.0 - center_distance * 0.08, index))
    return max(choices)[1] if choices else None


module.image_quality = synthetic_quality
module.choose_face = synthetic_choose_face
raise SystemExit(module.main())
