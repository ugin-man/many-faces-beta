#!/usr/bin/env python3
"""Clean Core v2 isolated-state policy and compatibility overlay.

The existing v1 builder/curator are intentionally reused.  This module patches
only their profile classifier and per-pose quotas before those programs are
loaded.  Quality, provenance, packing and catalog validation stay unchanged.
"""

from __future__ import annotations

import dataclasses
import inspect
from collections.abc import Mapping, Sequence
from typing import Any, Callable

POLICY_VERSION = "clean-single-factor-v2"

PROFILE_ORDER = [
    "neutral",
    "mouthSlightOpen",
    "mouthOpen",
    "smileClosed",
    "smileOpen",
    "mouthRound",
    "mouthPucker",
    "mouthWide",
    "mouthPress",
    "mouthRoll",
    "mouthLeft",
    "mouthRight",
    "mouthFrown",
    "winkLeft",
    "winkRight",
    "blink",
    "eyesWide",
    "gazeUp",
    "gazeDown",
    "gazeLeft",
    "gazeRight",
    "browsUp",
    "browsDown",
]

# These are maximums per 3-degree pose cell, not global targets.  Their sum is
# deliberately high enough for a 70k+ catalog while still preventing the
# frontal/closed-smile cluster from swallowing the entire set.
PROFILE_LIMITS = {
    "neutral": 70,
    "mouthSlightOpen": 18,
    "mouthOpen": 18,
    "smileClosed": 36,
    "smileOpen": 24,
    "mouthRound": 16,
    "mouthPucker": 20,
    "mouthWide": 16,
    "mouthPress": 16,
    "mouthRoll": 14,
    "mouthLeft": 10,
    "mouthRight": 10,
    "mouthFrown": 14,
    "winkLeft": 10,
    "winkRight": 10,
    "blink": 12,
    "eyesWide": 12,
    "gazeUp": 10,
    "gazeDown": 10,
    "gazeLeft": 10,
    "gazeRight": 10,
    "browsUp": 12,
    "browsDown": 12,
}

REQUIRED_PROFILE_MINIMUMS = {
    "neutral": 12000,
    "mouthSlightOpen": 700,
    "mouthOpen": 350,
    "smileClosed": 2500,
    "smileOpen": 1000,
    "mouthRound": 80,
    "mouthPucker": 700,
    "mouthWide": 300,
    "mouthPress": 500,
    "mouthRoll": 200,
    "mouthLeft": 50,
    "mouthRight": 50,
    "mouthFrown": 75,
    "winkLeft": 8,
    "winkRight": 8,
    "blink": 150,
    "eyesWide": 120,
    "gazeUp": 80,
    "gazeDown": 80,
    "gazeLeft": 80,
    "gazeRight": 80,
    "browsUp": 80,
    "browsDown": 80,
}

# MediaPipe feature indexes.  0..2 are yaw, pitch and roll.
IDX = {
    "jawOpen": 3,
    "mouthClose": 4,
    "mouthFunnel": 5,
    "mouthPucker": 6,
    "mouthSmileLeft": 7,
    "mouthSmileRight": 8,
    "mouthFrownLeft": 9,
    "mouthFrownRight": 10,
    "mouthStretchLeft": 11,
    "mouthStretchRight": 12,
    "eyeBlinkLeft": 13,
    "eyeBlinkRight": 14,
    "eyeSquintLeft": 15,
    "eyeSquintRight": 16,
    "browInnerUp": 17,
    "browDownLeft": 18,
    "browDownRight": 19,
    "browOuterUpLeft": 20,
    "browOuterUpRight": 21,
    "eyeLookDownLeft": 25,
    "eyeLookDownRight": 26,
    "eyeLookInLeft": 27,
    "eyeLookInRight": 28,
    "eyeLookOutLeft": 29,
    "eyeLookOutRight": 30,
    "eyeLookUpLeft": 31,
    "eyeLookUpRight": 32,
    "eyeWideLeft": 33,
    "eyeWideRight": 34,
    "jawForward": 35,
    "jawLeft": 36,
    "jawRight": 37,
    "mouthDimpleLeft": 38,
    "mouthDimpleRight": 39,
    "mouthLeft": 40,
    "mouthLowerDownLeft": 41,
    "mouthLowerDownRight": 42,
    "mouthPressLeft": 43,
    "mouthPressRight": 44,
    "mouthRight": 45,
    "mouthRollLower": 46,
    "mouthRollUpper": 47,
    "mouthShrugLower": 48,
    "mouthShrugUpper": 49,
    "mouthUpperUpLeft": 50,
    "mouthUpperUpRight": 51,
    "noseSneerLeft": 52,
    "noseSneerRight": 53,
}


def _feature_from(value: Any) -> list[float] | None:
    if isinstance(value, Mapping):
        candidate = value.get("feature") or value.get("features")
        if isinstance(candidate, Sequence) and not isinstance(candidate, (str, bytes)):
            return [float(v or 0) for v in candidate]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        if len(value) >= 50 and all(isinstance(v, (int, float)) for v in value[:3]):
            return [float(v or 0) for v in value]
    candidate = getattr(value, "feature", None)
    if isinstance(candidate, Sequence) and not isinstance(candidate, (str, bytes)):
        return [float(v or 0) for v in candidate]
    return None


def _extract_feature(args: tuple[Any, ...], kwargs: dict[str, Any]) -> list[float]:
    for value in args:
        found = _feature_from(value)
        if found is not None:
            return found
    for value in kwargs.values():
        found = _feature_from(value)
        if found is not None:
            return found
    raise TypeError("Clean Core v2 classifier could not find a feature vector")


def _score(feature: Sequence[float], name: str) -> float:
    index = IDX[name]
    try:
        value = float(feature[index])
    except (IndexError, TypeError, ValueError):
        return 0.0
    return min(1.0, max(0.0, value))


def _mean(feature: Sequence[float], *names: str) -> float:
    return sum(_score(feature, name) for name in names) / max(1, len(names))


def _max(feature: Sequence[float], *names: str) -> float:
    return max((_score(feature, name) for name in names), default=0.0)


def _signatures(feature: Sequence[float]) -> dict[str, float]:
    return {
        "jaw": _score(feature, "jawOpen"),
        "funnel": _score(feature, "mouthFunnel"),
        "pucker": _score(feature, "mouthPucker"),
        "smile_left": _score(feature, "mouthSmileLeft"),
        "smile_right": _score(feature, "mouthSmileRight"),
        "smile": _mean(feature, "mouthSmileLeft", "mouthSmileRight"),
        "frown": _mean(feature, "mouthFrownLeft", "mouthFrownRight"),
        "stretch": _mean(feature, "mouthStretchLeft", "mouthStretchRight"),
        "press": _mean(feature, "mouthPressLeft", "mouthPressRight"),
        "roll": _max(feature, "mouthRollLower", "mouthRollUpper"),
        "shrug": _max(feature, "mouthShrugLower", "mouthShrugUpper"),
        "mouth_left": _score(feature, "mouthLeft"),
        "mouth_right": _score(feature, "mouthRight"),
        "blink_left": _score(feature, "eyeBlinkLeft"),
        "blink_right": _score(feature, "eyeBlinkRight"),
        "squint": _mean(feature, "eyeSquintLeft", "eyeSquintRight"),
        "wide": _mean(feature, "eyeWideLeft", "eyeWideRight"),
        "gaze_up": _mean(feature, "eyeLookUpLeft", "eyeLookUpRight"),
        "gaze_down": _mean(feature, "eyeLookDownLeft", "eyeLookDownRight"),
        "gaze_left": _mean(feature, "eyeLookOutLeft", "eyeLookInRight"),
        "gaze_right": _mean(feature, "eyeLookInLeft", "eyeLookOutRight"),
        "brow_up": _max(feature, "browInnerUp", "browOuterUpLeft", "browOuterUpRight"),
        "brow_down": _mean(feature, "browDownLeft", "browDownRight"),
        "jaw_left": _score(feature, "jawLeft"),
        "jaw_right": _score(feature, "jawRight"),
        "jaw_forward": _score(feature, "jawForward"),
        "sneer": _mean(feature, "noseSneerLeft", "noseSneerRight"),
    }


def _mouth_neutral(s: Mapping[str, float], strict: bool = True) -> bool:
    limit = 0.20 if strict else 0.28
    return (
        s["jaw"] < (0.19 if strict else 0.26)
        and s["smile"] < limit
        and s["frown"] < limit
        and s["funnel"] < limit
        and s["pucker"] < limit
        and s["stretch"] < limit
        and s["press"] < limit
        and s["roll"] < limit
        and s["shrug"] < limit
        and s["mouth_left"] < limit
        and s["mouth_right"] < limit
        and s["jaw_left"] < limit
        and s["jaw_right"] < limit
        and s["jaw_forward"] < limit
        and s["sneer"] < limit
    )


def _eyes_neutral(s: Mapping[str, float], strict: bool = True) -> bool:
    limit = 0.22 if strict else 0.31
    return (
        s["blink_left"] < limit
        and s["blink_right"] < limit
        and s["wide"] < limit
        and s["gaze_up"] < limit
        and s["gaze_down"] < limit
        and s["gaze_left"] < limit
        and s["gaze_right"] < limit
    )


def _brows_neutral(s: Mapping[str, float], strict: bool = True) -> bool:
    limit = 0.22 if strict else 0.31
    return s["brow_up"] < limit and s["brow_down"] < limit


def classify_clean_profile(feature: Sequence[float] | Mapping[str, Any], *_: Any, **__: Any) -> str | None:
    vector = _feature_from(feature)
    if vector is None:
        return None
    s = _signatures(vector)

    # Eye-only states: the mouth and brows must stay neutral.  This is the
    # explicit protection against wink + open-mouth/smile contamination.
    if _mouth_neutral(s, strict=True) and _brows_neutral(s, strict=True):
        left_delta = s["blink_left"] - s["blink_right"]
        right_delta = s["blink_right"] - s["blink_left"]
        if s["blink_left"] >= 0.46 and s["blink_right"] <= 0.22 and left_delta >= 0.27:
            return "winkLeft"
        if s["blink_right"] >= 0.46 and s["blink_left"] <= 0.22 and right_delta >= 0.27:
            return "winkRight"
        if min(s["blink_left"], s["blink_right"]) >= 0.42:
            return "blink"
        if s["wide"] >= 0.27 and max(s["blink_left"], s["blink_right"]) < 0.20:
            return "eyesWide"
        gazes = {
            "gazeUp": s["gaze_up"],
            "gazeDown": s["gaze_down"],
            "gazeLeft": s["gaze_left"],
            "gazeRight": s["gaze_right"],
        }
        gaze_name, gaze_value = max(gazes.items(), key=lambda item: item[1])
        second = sorted(gazes.values(), reverse=True)[1]
        if gaze_value >= 0.26 and gaze_value - second >= 0.07 and max(s["blink_left"], s["blink_right"]) < 0.25:
            return gaze_name

    # Brow-only states: eyes and mouth must be neutral.
    if _mouth_neutral(s, strict=True) and _eyes_neutral(s, strict=True):
        if s["brow_up"] >= 0.28 and s["brow_down"] <= 0.20:
            return "browsUp"
        if s["brow_down"] >= 0.27 and s["brow_up"] <= 0.22:
            return "browsDown"

    # Mouth-only states.  Multiple blendshapes inside the mouth family are
    # resolved hierarchically into one visible mouth shape; eye/brow movement
    # is not allowed to leak into the class.
    if _eyes_neutral(s, strict=True) and _brows_neutral(s, strict=True):
        if s["smile"] >= 0.27 and s["jaw"] >= 0.22:
            return "smileOpen"
        if s["smile"] >= 0.27 and s["jaw"] < 0.22:
            return "smileClosed"
        if s["pucker"] >= 0.30 and s["stretch"] < 0.27:
            return "mouthPucker"
        if s["funnel"] >= 0.28 and s["stretch"] < 0.25 and s["smile"] < 0.20:
            return "mouthRound"
        if s["stretch"] >= 0.30 and s["smile"] < 0.24:
            return "mouthWide"
        if s["press"] >= 0.25 and s["jaw"] < 0.18:
            return "mouthPress"
        if s["roll"] >= 0.25 and s["jaw"] < 0.24:
            return "mouthRoll"
        if s["mouth_left"] >= 0.24 and s["mouth_right"] < 0.18:
            return "mouthLeft"
        if s["mouth_right"] >= 0.24 and s["mouth_left"] < 0.18:
            return "mouthRight"
        if s["frown"] >= 0.25 and s["smile"] < 0.18:
            return "mouthFrown"
        if s["jaw"] >= 0.38 and max(s["smile"], s["funnel"], s["pucker"], s["stretch"]) < 0.25:
            return "mouthOpen"
        if 0.13 <= s["jaw"] < 0.38 and max(s["smile"], s["funnel"], s["pucker"], s["stretch"]) < 0.23:
            return "mouthSlightOpen"

    # Neutral is intentionally less brittle than the isolated special states;
    # otherwise normal MediaPipe noise would discard most of the useful base.
    if _mouth_neutral(s, strict=False) and _eyes_neutral(s, strict=False) and _brows_neutral(s, strict=False):
        return "neutral"
    return None


# Common aliases used by the existing v1 tools and tests.
classify_profile = classify_clean_profile
classify_single_factor = classify_clean_profile


def _adapt_result(template: Any, profile: str | None) -> Any:
    if template is None or isinstance(template, str):
        return profile
    if isinstance(template, Mapping):
        output = dict(template)
        key = next((name for name in ("profile", "label", "name", "className", "class") if name in output), "profile")
        output[key] = profile
        return output
    if dataclasses.is_dataclass(template):
        for key in ("profile", "label", "name"):
            if hasattr(template, key):
                return dataclasses.replace(template, **{key: profile})
    if isinstance(template, tuple):
        return (profile, *template[1:])
    if isinstance(template, list):
        return [] if profile is None else [profile]
    if isinstance(template, set):
        return set() if profile is None else {profile}
    return profile


def _classifier_adapter(original: Callable[..., Any]) -> Callable[..., Any]:
    def adapter(*args: Any, **kwargs: Any) -> Any:
        vector = _extract_feature(args, kwargs)
        profile = classify_clean_profile(vector)
        try:
            template = original(*args, **kwargs)
        except Exception:
            template = None
        return _adapt_result(template, profile)

    adapter.__name__ = getattr(original, "__name__", "classify_clean_profile")
    adapter.__doc__ = "Clean Core v2 compatibility classifier"
    return adapter


def patch_legacy_policy(module: Any | None = None) -> Any:
    """Patch the imported v1 policy before its curator/builder is imported."""
    if module is None:
        import clean_core_policy as module  # type: ignore

    known = {
        "neutral", "mouthSlightOpen", "mouthOpen", "smileClosed", "smileOpen",
        "mouthRound", "mouthPucker", "mouthWide", "mouthPress", "mouthRoll",
        "mouthLeft", "mouthRight", "mouthFrown", "winkLeft", "winkRight", "blink",
    }

    exact_names = {
        "classify_clean_profile", "classify_profile", "classify_single_factor",
        "classify_state", "classify_candidate_profile",
    }
    for name in exact_names:
        original = getattr(module, name, None)
        if callable(original):
            setattr(module, name, _classifier_adapter(original))

    # Catch a differently named profile classifier without touching quality or
    # image-type classifiers.  A name must explicitly contain profile/state.
    for name, original in list(vars(module).items()):
        lower = name.lower()
        if not callable(original) or name in exact_names:
            continue
        if "classif" in lower and ("profile" in lower or "state" in lower):
            setattr(module, name, _classifier_adapter(original))

    for name, value in list(vars(module).items()):
        if isinstance(value, dict):
            overlapping = known.intersection(value.keys())
            if len(overlapping) >= 3 and all(isinstance(v, (int, float)) for v in value.values()):
                value.clear()
                value.update(PROFILE_LIMITS)
        elif isinstance(value, list) and len(known.intersection(value)) >= 3:
            value[:] = PROFILE_ORDER

    for name in (
        "PROFILE_LIMITS", "CLASS_LIMITS", "PER_CELL_LIMITS", "PER_POSE_LIMITS",
        "CLEAN_PROFILE_LIMITS",
    ):
        setattr(module, name, dict(PROFILE_LIMITS))
    for name in ("PROFILE_ORDER", "CLASS_ORDER", "SUPPORTED_PROFILES", "CLEAN_PROFILES"):
        setattr(module, name, list(PROFILE_ORDER))
    setattr(module, "POLICY_VERSION", POLICY_VERSION)
    setattr(module, "REQUIRED_PROFILE_MINIMUMS", dict(REQUIRED_PROFILE_MINIMUMS))
    return module


__all__ = [
    "POLICY_VERSION",
    "PROFILE_ORDER",
    "PROFILE_LIMITS",
    "REQUIRED_PROFILE_MINIMUMS",
    "classify_clean_profile",
    "classify_profile",
    "classify_single_factor",
    "patch_legacy_policy",
]
