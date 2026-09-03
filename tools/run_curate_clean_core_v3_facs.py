#!/usr/bin/env python3
"""Run the Clean Core v3 curator in verified Synthetic Humans FACS mode.

The natural-image curator is deliberately conservative. Synthetic Humans FACS
is different: every render is paired with a CC BY 4.0 annotation that names the
single Action Unit applied to the otherwise neutral face. In this wrapper the
annotation is the class ground truth, while MediaPipe remains responsible for
face detection, pose, geometry and the runtime feature measurement.

Synthetic-only adjustments:

- ignore whole-frame brightness/clipping caused by the studio background;
- choose a detected face without natural-portrait size assumptions;
- trust the verified single-AU target instead of requiring MediaPipe's
  blendshape classifier to rediscover the annotation;
- use an exact-image-style cryptographic visual hash, so the same identity and
  pose with a different Action Unit is not discarded as a near duplicate.

The generic Open Images curator is not modified.
"""

from __future__ import annotations

import hashlib
import importlib.util
import math
import sys
from pathlib import Path
from typing import Mapping

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import clean_core_policy_v3 as policy

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
        if area < 0.0015 or width < 0.045 or height < 0.055:
            continue
        center_distance = math.hypot((cx - 0.5) / 0.50, (cy - 0.5) / 0.50)
        choices.append((area * 5.0 - center_distance * 0.08, index))
    return max(choices)[1] if choices else None


def exact_visual_hash(image) -> str:
    """Deduplicate identical renders, not the same person making another face."""
    canonical = image.convert("RGB").resize((256, 256))
    return hashlib.sha256(canonical.tobytes()).hexdigest()[:16]


def _value(metrics: Mapping[str, float | None], name: str) -> float:
    value = metrics.get(name)
    return float(value) if value is not None else 0.0


def _verified_profile(name: str, strength: float, leakage: float, metrics) -> policy.CleanProfile:
    # The annotation is the class truth. Purity records MediaPipe disagreement
    # instead of silently re-labelling the controlled frame as another class.
    purity = max(0.55, min(1.0, 0.97 - max(0.0, leakage - 0.35) * 0.18))
    return policy.CleanProfile(
        name=name,
        group=policy.PROFILE_GROUPS[name],
        strength=max(0.55, min(1.25, strength)),
        leakage=max(0.0, leakage),
        purity=purity,
        yaw=_value(metrics, "yaw"),
        pitch=_value(metrics, "pitch"),
        roll=_value(metrics, "rollPose"),
    )


def verified_target_assisted(target, feature, projection=None):
    """Classify a source-verified single AU without inventing combinations."""
    target = str(target or "").strip()
    metrics = policy.metrics_from_feature(feature, projection)

    mouth_activity = max(
        _value(metrics, "jawOpen"), _value(metrics, "smile"),
        _value(metrics, "frown"), _value(metrics, "funnel"),
        _value(metrics, "pucker"), _value(metrics, "stretch"),
        _value(metrics, "press"), _value(metrics, "roll"),
        _value(metrics, "shrug"), _value(metrics, "upperUp"),
        _value(metrics, "lowerDown"),
    )
    eye_activity = max(
        _value(metrics, "blinkLeft"), _value(metrics, "blinkRight"),
        _value(metrics, "eyeWide"), _value(metrics, "squint"),
        _value(metrics, "gazeUp"), _value(metrics, "gazeDown"),
        _value(metrics, "gazeLeft"), _value(metrics, "gazeRight"),
    )
    brow_activity = max(_value(metrics, "browUp"), _value(metrics, "browDown"))
    nose_activity = _value(metrics, "sneer")
    family_activity = {
        "mouth": mouth_activity,
        "eyes": eye_activity,
        "brows": brow_activity,
        "nose": nose_activity,
    }

    if target == "wink":
        left = _value(metrics, "blinkLeft")
        right = _value(metrics, "blinkRight")
        if abs(left - right) < 0.015:
            # MediaPipe blendshapes can tie on synthetic eyes. The projection
            # aperture resolves the side while keeping the policy convention.
            left_ap = metrics.get("leftAperture")
            right_ap = metrics.get("rightAperture")
            if left_ap is not None and right_ap is not None:
                name = "winkLeft" if float(right_ap) < float(left_ap) else "winkRight"
            else:
                name = "winkLeft"
        else:
            name = "winkLeft" if left > right else "winkRight"
        leakage = max(mouth_activity, brow_activity, nose_activity)
        return _verified_profile(name, max(left, right, 0.72), leakage, metrics)

    if target not in policy.PROFILE_GROUPS or target not in policy.PROFILE_MINIMUMS:
        return None

    evidence = {
        "blink": min(_value(metrics, "blinkLeft"), _value(metrics, "blinkRight")),
        "eyesWide": _value(metrics, "eyeWide"),
        "browsUp": _value(metrics, "browUp"),
        "browsDown": _value(metrics, "browDown"),
        "noseSneer": _value(metrics, "sneer"),
        "mouthSlightOpen": _value(metrics, "jawOpen"),
        "mouthOpen": _value(metrics, "jawOpen"),
        "smileClosed": _value(metrics, "smile"),
        "smileOpen": min(_value(metrics, "smile"), _value(metrics, "jawOpen")),
        "mouthRound": max(_value(metrics, "funnel"), _value(metrics, "pucker") * 0.70),
        "mouthPucker": max(_value(metrics, "pucker"), _value(metrics, "funnel") * 0.55),
        "mouthWide": _value(metrics, "stretch"),
        "mouthPress": _value(metrics, "press"),
        "mouthRoll": _value(metrics, "roll"),
        "mouthLeft": _value(metrics, "mouthLeft"),
        "mouthRight": _value(metrics, "mouthRight"),
        "mouthFrown": _value(metrics, "frown"),
        "mouthShrug": _value(metrics, "shrug"),
        "mouthUpperUp": _value(metrics, "upperUp"),
        "mouthLowerDown": _value(metrics, "lowerDown"),
        "neutral": 1.0,
    }
    group = policy.PROFILE_GROUPS[target]
    leakage = max(
        (activity for family, activity in family_activity.items() if family != group),
        default=0.0,
    )
    return _verified_profile(target, max(evidence.get(target, 0.0), 0.72), leakage, metrics)


module.image_quality = synthetic_quality
module.choose_face = synthetic_choose_face
module.difference_hash = exact_visual_hash
module.classify_target_assisted = verified_target_assisted
raise SystemExit(module.main())
