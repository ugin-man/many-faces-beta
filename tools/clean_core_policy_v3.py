#!/usr/bin/env python3
"""Isolated profiles plus explicit observed expression evidence for Clean Core.

Strict profiles retain the isolated v2 criteria. A separately labelled observed
wink may include natural mouth/brow coexpression, but requires exact-image
visual confirmation and the same raw blink and normalized eyelid evidence as
the live wink-support classifier. Strict winks require that confirmation too.
Observed mouth stretch/frown retains direct mouth constraints while allowing
natural eye, gaze and brow coexpression. These observations never claim purity.
Background profiles supply identity and pose density; they do not establish
the required expression coverage. Image admission is a separate mandatory gate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from clean_core_policy_v2 import (
    FEATURE_INDEX,
    FEATURE_LENGTH,
    BLEND_KEYS,
    CleanProfile,
    metrics_from_feature,
    decode_projection,
    nose_neutral,
    jaw_translation_neutral,
    classify_clean_profile as classify_strict_profile_v2,
    quantized_pose_cell,
)

POLICY_VERSION = "clean-isolated-observed-mouth-reviewed-winks-v5"

STRICT_PROFILE_PRIORITY = (
    "winkLeft", "winkRight", "blink", "eyesWide",
    "gazeUp", "gazeDown", "gazeLeft", "gazeRight",
    "browsUp", "browsDown", "noseSneer",
    "mouthRound", "mouthPucker", "mouthSlightOpen", "mouthOpen",
    "smileClosed", "smileOpen", "mouthWide", "mouthPress", "mouthRoll",
    "mouthLeft", "mouthRight", "mouthFrown", "mouthShrug",
    "mouthUpperUp", "mouthLowerDown",
    "neutral",
)

PROFILE_GROUPS = {
    "neutral": "neutral",
    "winkLeft": "eyes", "winkRight": "eyes", "blink": "eyes",
    "eyesWide": "eyes", "gazeUp": "eyes", "gazeDown": "eyes",
    "gazeLeft": "eyes", "gazeRight": "eyes",
    "browsUp": "brows", "browsDown": "brows",
    "noseSneer": "nose",
    "mouthSlightOpen": "mouth", "mouthOpen": "mouth",
    "smileClosed": "mouth", "smileOpen": "mouth",
    "mouthRound": "mouth", "mouthPucker": "mouth", "mouthWide": "mouth",
    "mouthPress": "mouth", "mouthRoll": "mouth",
    "mouthLeft": "mouth", "mouthRight": "mouth", "mouthFrown": "mouth",
    "mouthShrug": "mouth", "mouthUpperUp": "mouth", "mouthLowerDown": "mouth",
    "backgroundNeutral": "background-neutral",
    "backgroundEyes": "background-eyes",
    "backgroundBrows": "background-brows",
    "backgroundNose": "background-nose",
    "backgroundMouth": "background-mouth",
}

# High caps preserve a 70k physical catalog while still balancing the 3-degree
# cells. Strict minima are selected first; these caps only affect extra diversity.
PROFILE_CELL_LIMITS = {
    "neutral": 86,
    "winkLeft": 14, "winkRight": 14, "blink": 18, "eyesWide": 20,
    "gazeUp": 18, "gazeDown": 18, "gazeLeft": 18, "gazeRight": 18,
    "browsUp": 20, "browsDown": 20, "noseSneer": 16,
    "mouthSlightOpen": 30, "mouthOpen": 26,
    "smileClosed": 48, "smileOpen": 30,
    "mouthRound": 24, "mouthPucker": 28, "mouthWide": 24,
    "mouthPress": 24, "mouthRoll": 22,
    "mouthLeft": 18, "mouthRight": 18, "mouthFrown": 22,
    "mouthShrug": 20, "mouthUpperUp": 18, "mouthLowerDown": 18,
    "backgroundNeutral": 120,
    "backgroundEyes": 38,
    "backgroundBrows": 30,
    "backgroundNose": 24,
    "backgroundMouth": 54,
}

# These are completion gates, not aspirational labels. Every listed state must
# materially exist, but v3 remains a first isolated-factor release rather than
# an exhaustive combinatorial atlas.
PROFILE_MINIMUMS = {
    "neutral": 0,
    "winkLeft": 80, "winkRight": 80, "blink": 250, "eyesWide": 150,
    "gazeUp": 150, "gazeDown": 150, "gazeLeft": 150, "gazeRight": 150,
    "browsUp": 150, "browsDown": 150, "noseSneer": 100,
    "mouthSlightOpen": 300, "mouthOpen": 250,
    "smileClosed": 500, "smileOpen": 250,
    "mouthRound": 120, "mouthPucker": 250, "mouthWide": 180,
    "mouthPress": 250, "mouthRoll": 100,
    "mouthLeft": 20, "mouthRight": 20, "mouthFrown": 120,
    "mouthShrug": 100, "mouthUpperUp": 100, "mouthLowerDown": 100,
}

PROFILE_POSE_CELL_MINIMUMS = {
    "neutral": 0,
    "winkLeft": 4, "winkRight": 4, "blink": 25, "eyesWide": 12,
    "gazeUp": 30, "gazeDown": 30, "gazeLeft": 30, "gazeRight": 30,
    "browsUp": 20, "browsDown": 20, "noseSneer": 8,
    "mouthSlightOpen": 60, "mouthOpen": 45,
    "smileClosed": 80, "smileOpen": 45,
    "mouthRound": 12, "mouthPucker": 35, "mouthWide": 28,
    "mouthPress": 35, "mouthRoll": 18,
    "mouthLeft": 6, "mouthRight": 6, "mouthFrown": 18,
    "mouthShrug": 18, "mouthUpperUp": 8, "mouthLowerDown": 8,
}

BACKGROUND_PRIORITY = (
    "backgroundNeutral", "backgroundMouth", "backgroundEyes",
    "backgroundBrows", "backgroundNose",
)

BACKGROUND_MINIMUMS = {"backgroundNeutral": 15_000}
BACKGROUND_POSE_CELL_MINIMUMS = {"backgroundNeutral": 650}

OBSERVED_PROFILE_PRIORITY = ("winkLeft", "winkRight", "mouthWide", "mouthFrown")
# These declarations state which evidence can satisfy each profile's existing
# count/pose minimum. Observed coexpressions never enter isolated-only totals.
PROFILE_EVIDENCE_TIERS = {
    **{name: ("strict", "observed") if name in OBSERVED_PROFILE_PRIORITY else ("strict",)
       for name in STRICT_PROFILE_PRIORITY},
    **{name: ("background",) for name in BACKGROUND_PRIORITY},
}


def observed_wink_evidence(feature: Sequence[float], projection: str | Sequence[float] | None) -> dict[str, Any] | None:
    """Match app/live/wink-evidence.ts without changing any measured value.

    Sides are anatomical. The distance/eye-width ratios remain valid under
    image roll and are not the old image-axis vertical aperture measurement.
    These automatic measurements provide corroboration, not proof of a true
    wink or face visibility. Exact-image visual confirmation and completed
    pixel admission remain mandatory for final wink coverage.
    """
    if len(feature) < FEATURE_LENGTH:
        return None
    try:
        if not all(math.isfinite(float(value)) for value in feature):
            return None
        points = decode_projection(projection)
        if points is None or len(points) < 936 or not all(math.isfinite(value) for value in points):
            return None
        left = float(feature[FEATURE_INDEX["eyeBlinkLeft"]])
        right = float(feature[FEATURE_INDEX["eyeBlinkRight"]])
        if abs(float(feature[0]) * 90) > 30 or abs(float(feature[1]) * 90) > 30:
            return None
        if max(left, right) < .35 or min(left, right) > .40 or abs(left - right) < .18:
            return None

        def distance(first: int, second: int) -> float:
            return math.hypot(points[first * 2] - points[second * 2],
                              points[first * 2 + 1] - points[second * 2 + 1])

        left_width, right_width = distance(362, 263), distance(33, 133)
        if min(left_width, right_width) < .04:
            return None
        left_aperture = distance(386, 374) / left_width
        right_aperture = distance(159, 145) / right_width
        side = "left" if left > right else "right"
        closed, opened = (left_aperture, right_aperture) if side == "left" else (right_aperture, left_aperture)
        if closed > .15 or opened < .18 or closed > opened * .65:
            return None
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    return {"side": side, "leftBlink": left, "rightBlink": right,
            "leftAperture": left_aperture, "rightAperture": right_aperture}


def classify_observed_wink_profile(feature: Sequence[float], projection: str | Sequence[float] | None = None) -> CleanProfile | None:
    evidence = observed_wink_evidence(feature, projection)
    if evidence is None:
        return None
    metrics = metrics_from_feature(feature, projection)
    coactivation = max(float(metrics[name]) for name in (
        "jawOpen", "smile", "frown", "funnel", "pucker", "stretch", "press", "roll", "shrug",
        "mouthLeft", "mouthRight", "upperUp", "lowerDown", "cheekPuff", "browUp", "browDown",
        "sneer", "gazeUp", "gazeDown", "gazeLeft", "gazeRight"))
    return CleanProfile(
        name="winkLeft" if evidence["side"] == "left" else "winkRight", group="eyes",
        strength=abs(evidence["leftBlink"] - evidence["rightBlink"]),
        leakage=coactivation, purity=0.0,
        yaw=float(metrics["yaw"]), pitch=float(metrics["pitch"]), roll=float(metrics["rollPose"]),
    )


def classify_observed_mouth_profile(feature: Sequence[float], projection: str | Sequence[float] | None = None) -> CleanProfile | None:
    """Observe mouth stretch or lowered corners without inventing isolation.

    Fresh real-photo measurements and inspected original pixels establish that
    natural brow/gaze/squint activity can accompany these mouth shapes. Keep the
    v2 direct mouth conditions and effective target-strength floors, plus its
    nose and jaw-translation constraints. All original pixel admission and
    additional reviewed exclusions remain independent mandatory gates.
    """
    try:
        if len(feature) != FEATURE_LENGTH or not all(math.isfinite(float(value)) for value in feature):
            return None
        points = decode_projection(projection)
        if points is None or len(points) < 936 or not all(math.isfinite(value) for value in points):
            return None
        m = metrics_from_feature(feature, projection)
        if not (nose_neutral(m) and jaw_translation_neutral(m)):
            return None
        stretch, smile, frown = float(m["stretch"]), float(m["smile"]), float(m["frown"])
        funnel, pucker, jaw_open = float(m["funnel"]), float(m["pucker"]), float(m["jawOpen"])
        if stretch >= .23 and smile <= .27 and max(funnel, pucker) <= .23 and frown <= .19:
            name, strength = "mouthWide", stretch
        elif frown >= .20 and jaw_open <= .24 and smile <= .21 and pucker <= .23 and stretch <= .23:
            name, strength = "mouthFrown", frown
        else:
            return None
        coactivation = max(float(m[key]) for key in (
            "blinkLeft", "blinkRight", "squint", "eyeWide", "gazeUp", "gazeDown",
            "gazeLeft", "gazeRight", "browUp", "browDown", "press", "roll", "shrug"))
        return CleanProfile(name=name, group="mouth", strength=strength, leakage=coactivation,
                            purity=0.0, yaw=float(m["yaw"]), pitch=float(m["pitch"]), roll=float(m["rollPose"]))
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def _profile(name: str, strength: float, leakage: float, m: Mapping[str, float | None]) -> CleanProfile:
    purity = max(0.0, min(1.0, 1.0 - leakage * .28 + min(strength, 1.0) * .08))
    return CleanProfile(
        name=name,
        group=PROFILE_GROUPS[name],
        strength=max(0.0, min(1.5, strength)),
        leakage=max(0.0, leakage),
        purity=purity,
        yaw=float(m["yaw"]),
        pitch=float(m["pitch"]),
        roll=float(m["rollPose"]),
    )


def classify_strict_profile(feature: Sequence[float], projection: str | Sequence[float] | None = None) -> CleanProfile | None:
    profile = classify_strict_profile_v2(feature, projection)
    if profile is None or profile.name not in PROFILE_MINIMUMS:
        return None
    return CleanProfile(
        name=profile.name,
        group=PROFILE_GROUPS[profile.name],
        strength=profile.strength,
        leakage=profile.leakage,
        purity=profile.purity,
        yaw=profile.yaw,
        pitch=profile.pitch,
        roll=profile.roll,
    )


def classify_background_profile(feature: Sequence[float], projection: str | Sequence[float] | None = None) -> CleanProfile | None:
    """Return a clearly labelled one-family fallback profile.

    The thresholds are intentionally looser than strict profile classification,
    but strong activity in two anatomical families is never accepted.
    """
    m = metrics_from_feature(feature, projection)
    mouth = max(
        float(m["jawOpen"]), float(m["smile"]), float(m["frown"]),
        float(m["funnel"]), float(m["pucker"]), float(m["stretch"]),
        float(m["press"]), float(m["roll"]), float(m["shrug"]),
        float(m["mouthLeft"]), float(m["mouthRight"]), float(m["upperUp"]),
        float(m["lowerDown"]), float(m["cheekPuff"]),
    )
    eyes = max(
        float(m["blinkLeft"]), float(m["blinkRight"]), float(m["squint"]),
        float(m["eyeWide"]), float(m["gazeUp"]), float(m["gazeDown"]),
        float(m["gazeLeft"]), float(m["gazeRight"]),
    )
    brows = max(float(m["browUp"]), float(m["browDown"]))
    nose = float(m["sneer"])
    jaw_shift = max(float(m["jawForward"]), float(m["jawLeft"]), float(m["jawRight"]))
    mouth = max(mouth, jaw_shift)

    values = {"mouth": mouth, "eyes": eyes, "brows": brows, "nose": nose}

    # MediaPipe produces moderate co-activation even on visually simple faces.
    # Only clearly dominant activity creates a background family; two clearly
    # dominant families are rejected. This keeps most useful pose/identity
    # density without pretending those faces satisfy a strict profile.
    active_thresholds = {"mouth": .55, "eyes": .65, "brows": .55, "nose": .45}
    active = [name for name, value in values.items() if value >= active_thresholds[name]]

    # User-critical exclusion: a real wink may not coexist with a visibly open,
    # smiling, rounded or stretched mouth in this first isolated-factor release.
    wink_like = (
        max(float(m["blinkLeft"]), float(m["blinkRight"])) >= .45
        and abs(float(m["blinkLeft"]) - float(m["blinkRight"])) >= .30
    )
    mouth_conflict = (
        float(m["jawOpen"]) >= .22
        or float(m["smile"]) >= .28
        or max(float(m["funnel"]), float(m["pucker"])) >= .28
        or float(m["stretch"]) >= .30
    )
    if wink_like and mouth_conflict:
        return None
    if len(active) > 1:
        return None

    if not active:
        normalized = max(
            mouth / active_thresholds["mouth"],
            eyes / active_thresholds["eyes"],
            brows / active_thresholds["brows"],
            nose / active_thresholds["nose"],
        )
        return _profile("backgroundNeutral", 1.0 - normalized * .20, normalized, m)

    family = active[0]
    leakage = max(
        (value / active_thresholds[name] for name, value in values.items() if name != family),
        default=0.0,
    )
    return _profile({
        "mouth": "backgroundMouth",
        "eyes": "backgroundEyes",
        "brows": "backgroundBrows",
        "nose": "backgroundNose",
    }[family], values[family], leakage, m)

def classify_assignment(feature: Sequence[float], projection: str | Sequence[float] | None = None,
                        *, allow_observed_wink: str | None = None) -> tuple[CleanProfile, str] | None:
    """Assign wink coverage only with reviewed same-side pixel evidence.

    The caller resolves the exact image digest against its bound review. The
    unchanged automatic helpers remain separately available for diagnostics.
    Missing, uncertain or opposite-side confirmation never authorizes a wink.
    """
    strict = classify_strict_profile(feature, projection)
    wink_names = {"winkLeft": "left", "winkRight": "right"}
    if strict is not None and strict.name not in wink_names:
        return strict, "strict"
    observed = classify_observed_wink_profile(feature, projection)
    if observed is not None and allow_observed_wink == wink_names[observed.name]:
        if strict is not None and strict.name == observed.name:
            return strict, "strict"
        return observed, "observed"
    observed_mouth = classify_observed_mouth_profile(feature, projection)
    if observed_mouth is not None:
        return observed_mouth, "observed"
    background = classify_background_profile(feature, projection)
    if background is not None:
        return background, "background"
    return None


def classify_target_assisted(
    target: str,
    feature: Sequence[float],
    projection: str | Sequence[float] | None = None,
) -> CleanProfile | None:
    """Verify a controlled single-AU source with relaxed MediaPipe thresholds.

    This is only for datasets whose annotation explicitly says one FACS action
    unit was rendered. It never applies to web-scraped natural images.
    """
    target = str(target or "").strip()
    m = metrics_from_feature(feature, projection)
    mouth_quiet = max(
        float(m["jawOpen"]), float(m["smile"]), float(m["frown"]),
        float(m["funnel"]), float(m["pucker"]), float(m["stretch"]),
        float(m["press"]), float(m["roll"]), float(m["shrug"]),
    ) <= .42
    eyes_quiet = max(
        float(m["blinkLeft"]), float(m["blinkRight"]), float(m["eyeWide"]),
        float(m["gazeUp"]), float(m["gazeDown"]), float(m["gazeLeft"]),
        float(m["gazeRight"]),
    ) <= .52
    brows_quiet = max(float(m["browUp"]), float(m["browDown"])) <= .38
    nose_quiet = float(m["sneer"]) <= .30

    if target == "wink":
        explicit_mouth = (
            float(m["jawOpen"]) >= .22
            or float(m["smile"]) >= .28
            or max(float(m["funnel"]), float(m["pucker"])) >= .28
            or float(m["stretch"]) >= .30
        )
        if explicit_mouth or not (brows_quiet and nose_quiet):
            return None
        left, right = float(m["blinkLeft"]), float(m["blinkRight"])
        if max(left, right) < .22 or abs(left - right) < .08:
            return None
        # Keep the same side convention as the strict classifier.
        name = "winkLeft" if left > right else "winkRight"
        return _profile(name, max(left, right), min(left, right) / .36, m)

    evidence = {
        "blink": min(float(m["blinkLeft"]), float(m["blinkRight"])),
        "eyesWide": float(m["eyeWide"]),
        "browsUp": float(m["browUp"]),
        "browsDown": float(m["browDown"]),
        "noseSneer": float(m["sneer"]),
        "mouthSlightOpen": float(m["jawOpen"]),
        "mouthOpen": float(m["jawOpen"]),
        "smileClosed": float(m["smile"]),
        "smileOpen": min(float(m["smile"]), float(m["jawOpen"])),
        "mouthRound": max(float(m["funnel"]), float(m["pucker"]) * .75),
        "mouthPucker": max(float(m["pucker"]), float(m["funnel"]) * .65),
        "mouthWide": float(m["stretch"]),
        "mouthPress": float(m["press"]),
        "mouthRoll": float(m["roll"]),
        "mouthFrown": float(m["frown"]),
        "mouthShrug": float(m["shrug"]),
        "mouthUpperUp": float(m["upperUp"]),
        "mouthLowerDown": float(m["lowerDown"]),
    }
    thresholds = {
        "blink": .20, "eyesWide": .10, "browsUp": .11, "browsDown": .11,
        "noseSneer": .08, "mouthSlightOpen": .10, "mouthOpen": .22,
        "smileClosed": .14, "smileOpen": .13, "mouthRound": .12,
        "mouthPucker": .12, "mouthWide": .13, "mouthPress": .12,
        "mouthRoll": .10, "mouthFrown": .10, "mouthShrug": .10,
        "mouthUpperUp": .09, "mouthLowerDown": .09,
    }
    if target not in evidence or evidence[target] < thresholds[target]:
        return None

    group = PROFILE_GROUPS[target]
    if group == "eyes" and not (mouth_quiet and brows_quiet and nose_quiet):
        return None
    if group == "brows" and not (mouth_quiet and eyes_quiet and nose_quiet):
        return None
    if group == "nose" and not (mouth_quiet and eyes_quiet and brows_quiet):
        return None
    if group == "mouth" and not (eyes_quiet and brows_quiet and nose_quiet):
        return None

    if target == "mouthSlightOpen" and float(m["jawOpen"]) > .42:
        return None
    if target == "smileClosed" and float(m["jawOpen"]) > .32:
        return None
    if target == "smileOpen" and float(m["jawOpen"]) < .12:
        return None

    leakage = max(
        0.0 if group == "mouth" else max(float(m["jawOpen"]), float(m["smile"]), float(m["pucker"])),
        0.0 if group == "eyes" else max(float(m["blinkLeft"]), float(m["blinkRight"]), float(m["eyeWide"])),
        0.0 if group == "brows" else max(float(m["browUp"]), float(m["browDown"])),
        0.0 if group == "nose" else float(m["sneer"]),
    )
    return _profile(target, evidence[target], leakage, m)
