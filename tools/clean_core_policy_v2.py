#!/usr/bin/env python3
"""Clean single-factor face-state policy for Many Faces Clean Core v2.

V2 keeps one anatomical action family active at a time. It is deliberately not
an exhaustive combinatorial expression atlas. A left wink, for example, is
accepted only when the mouth, brows, gaze, nose, and jaw translation remain
near neutral. Mouth states receive the finest-grained vocabulary because mouth
mismatch is the most visible failure mode in the current catalog.
"""

from __future__ import annotations

import base64
import math
import struct
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

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
FEATURE_INDEX = {key: index + 3 for index, key in enumerate(BLEND_KEYS)}
FEATURE_LENGTH = 3 + len(BLEND_KEYS)
POLICY_VERSION = "clean-single-factor-v2"

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
    "cheekPuff": "mouth",
}

PROFILE_PRIORITY = (
    "winkLeft", "winkRight", "blink", "eyesWide",
    "gazeUp", "gazeDown", "gazeLeft", "gazeRight",
    "browsUp", "browsDown", "noseSneer",
    "mouthRound", "mouthPucker", "mouthSlightOpen", "mouthOpen",
    "smileClosed", "smileOpen", "mouthWide", "mouthPress", "mouthRoll",
    "mouthLeft", "mouthRight", "mouthFrown", "mouthShrug",
    "mouthUpperUp", "mouthLowerDown", "cheekPuff",
    "neutral",
)

# These caps are deliberately generous. Coverage and profile minimums are
# satisfied first; the builder then fills the remaining 70k target with diverse
# identities rather than stopping at a tiny prototype.
PROFILE_CELL_LIMITS = {
    "neutral": 72,
    "winkLeft": 10, "winkRight": 10, "blink": 12, "eyesWide": 14,
    "gazeUp": 12, "gazeDown": 12, "gazeLeft": 12, "gazeRight": 12,
    "browsUp": 14, "browsDown": 14, "noseSneer": 10,
    "mouthSlightOpen": 24, "mouthOpen": 20,
    "smileClosed": 36, "smileOpen": 24,
    "mouthRound": 18, "mouthPucker": 22, "mouthWide": 18,
    "mouthPress": 18, "mouthRoll": 16,
    "mouthLeft": 12, "mouthRight": 12, "mouthFrown": 16,
    "mouthShrug": 14, "mouthUpperUp": 12, "mouthLowerDown": 12,
    "cheekPuff": 10,
}

# A build is not reviewable unless every advertised class is materially present.
# Pose-cell minima are intentionally lower for winks because one-eye closure is
# not reliably distinguishable at extreme profile angles.
PROFILE_MINIMUMS = {
    "neutral": 18000,
    "winkLeft": 80, "winkRight": 80, "blink": 300, "eyesWide": 350,
    "gazeUp": 250, "gazeDown": 250, "gazeLeft": 250, "gazeRight": 250,
    "browsUp": 350, "browsDown": 350, "noseSneer": 150,
    "mouthSlightOpen": 1100, "mouthOpen": 750,
    "smileClosed": 5500, "smileOpen": 1800,
    "mouthRound": 350, "mouthPucker": 1000, "mouthWide": 650,
    "mouthPress": 900, "mouthRoll": 450,
    "mouthLeft": 180, "mouthRight": 180, "mouthFrown": 350,
    "mouthShrug": 250, "mouthUpperUp": 160, "mouthLowerDown": 160,
    "cheekPuff": 120,
}
PROFILE_POSE_CELL_MINIMUMS = {
    "neutral": 680,
    "winkLeft": 18, "winkRight": 18, "blink": 55, "eyesWide": 70,
    "gazeUp": 65, "gazeDown": 65, "gazeLeft": 65, "gazeRight": 65,
    "browsUp": 70, "browsDown": 70, "noseSneer": 35,
    "mouthSlightOpen": 180, "mouthOpen": 130,
    "smileClosed": 360, "smileOpen": 190,
    "mouthRound": 80, "mouthPucker": 180, "mouthWide": 120,
    "mouthPress": 160, "mouthRoll": 100,
    "mouthLeft": 45, "mouthRight": 45, "mouthFrown": 80,
    "mouthShrug": 60, "mouthUpperUp": 40, "mouthLowerDown": 40,
    "cheekPuff": 30,
}


@dataclass(frozen=True)
class CleanProfile:
    name: str
    group: str
    strength: float
    leakage: float
    purity: float
    yaw: float
    pitch: float
    roll: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "group": self.group,
            "strength": round(self.strength, 6),
            "leakage": round(self.leakage, 6),
            "purity": round(self.purity, 6),
            "yaw": round(self.yaw, 4),
            "pitch": round(self.pitch, 4),
            "roll": round(self.roll, 4),
            "policyVersion": POLICY_VERSION,
        }


def clamp01(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, number)) if math.isfinite(number) else 0.0


def decode_projection(encoded: str | Sequence[float] | None) -> list[float] | None:
    if encoded is None:
        return None
    if not isinstance(encoded, str):
        values = [float(value) for value in encoded]
        return values if values else None
    try:
        payload = base64.b64decode(encoded)
        if len(payload) % 2:
            return None
        return [value / 4096.0 for value in struct.unpack(f"<{len(payload) // 2}h", payload)]
    except (ValueError, struct.error):
        return None


def aperture(projection: Sequence[float] | None, top: int, bottom: int) -> float | None:
    if projection is None or bottom * 2 + 1 >= len(projection):
        return None
    return abs(float(projection[top * 2 + 1]) - float(projection[bottom * 2 + 1]))


def metrics_from_feature(feature: Sequence[float], projection: str | Sequence[float] | None = None) -> dict[str, float | None]:
    if len(feature) < FEATURE_LENGTH:
        raise ValueError(f"feature must contain {FEATURE_LENGTH} values")

    def score(key: str) -> float:
        return clamp01(feature[FEATURE_INDEX[key]])

    p = decode_projection(projection)
    m: dict[str, float | None] = {
        "yaw": float(feature[0]) * 90, "pitch": float(feature[1]) * 90,
        "rollPose": float(feature[2]) * 90,
        "jawOpen": score("jawOpen"), "mouthClose": score("mouthClose"),
        "funnel": score("mouthFunnel"), "pucker": score("mouthPucker"),
        "smileLeft": score("mouthSmileLeft"), "smileRight": score("mouthSmileRight"),
        "frownLeft": score("mouthFrownLeft"), "frownRight": score("mouthFrownRight"),
        "stretchLeft": score("mouthStretchLeft"), "stretchRight": score("mouthStretchRight"),
        "blinkLeft": score("eyeBlinkLeft"), "blinkRight": score("eyeBlinkRight"),
        "squintLeft": score("eyeSquintLeft"), "squintRight": score("eyeSquintRight"),
        "browInnerUp": score("browInnerUp"), "browDownLeft": score("browDownLeft"),
        "browDownRight": score("browDownRight"),
        "browOuterUpLeft": score("browOuterUpLeft"), "browOuterUpRight": score("browOuterUpRight"),
        "cheekPuff": score("cheekPuff"),
        "lookDownLeft": score("eyeLookDownLeft"), "lookDownRight": score("eyeLookDownRight"),
        "lookInLeft": score("eyeLookInLeft"), "lookInRight": score("eyeLookInRight"),
        "lookOutLeft": score("eyeLookOutLeft"), "lookOutRight": score("eyeLookOutRight"),
        "lookUpLeft": score("eyeLookUpLeft"), "lookUpRight": score("eyeLookUpRight"),
        "eyeWideLeft": score("eyeWideLeft"), "eyeWideRight": score("eyeWideRight"),
        "jawForward": score("jawForward"), "jawLeft": score("jawLeft"), "jawRight": score("jawRight"),
        "mouthLeft": score("mouthLeft"), "mouthRight": score("mouthRight"),
        "lowerDownLeft": score("mouthLowerDownLeft"), "lowerDownRight": score("mouthLowerDownRight"),
        "pressLeft": score("mouthPressLeft"), "pressRight": score("mouthPressRight"),
        "rollLower": score("mouthRollLower"), "rollUpper": score("mouthRollUpper"),
        "shrugLower": score("mouthShrugLower"), "shrugUpper": score("mouthShrugUpper"),
        "upperUpLeft": score("mouthUpperUpLeft"), "upperUpRight": score("mouthUpperUpRight"),
        "sneerLeft": score("noseSneerLeft"), "sneerRight": score("noseSneerRight"),
        "leftAperture": aperture(p, 159, 145), "rightAperture": aperture(p, 386, 374),
    }
    m.update({
        "smile": (float(m["smileLeft"]) + float(m["smileRight"])) / 2,
        "smileDifference": abs(float(m["smileLeft"]) - float(m["smileRight"])),
        "frown": (float(m["frownLeft"]) + float(m["frownRight"])) / 2,
        "stretch": (float(m["stretchLeft"]) + float(m["stretchRight"])) / 2,
        "press": (float(m["pressLeft"]) + float(m["pressRight"])) / 2,
        "roll": max(float(m["rollLower"]), float(m["rollUpper"])),
        "shrug": max(float(m["shrugLower"]), float(m["shrugUpper"])),
        "upperUp": (float(m["upperUpLeft"]) + float(m["upperUpRight"])) / 2,
        "lowerDown": (float(m["lowerDownLeft"]) + float(m["lowerDownRight"])) / 2,
        "browUp": max(float(m["browInnerUp"]), float(m["browOuterUpLeft"]), float(m["browOuterUpRight"])),
        "browDown": (float(m["browDownLeft"]) + float(m["browDownRight"])) / 2,
        "sneer": (float(m["sneerLeft"]) + float(m["sneerRight"])) / 2,
        "eyeWide": (float(m["eyeWideLeft"]) + float(m["eyeWideRight"])) / 2,
        "squint": (float(m["squintLeft"]) + float(m["squintRight"])) / 2,
        "gazeUp": (float(m["lookUpLeft"]) + float(m["lookUpRight"])) / 2,
        "gazeDown": (float(m["lookDownLeft"]) + float(m["lookDownRight"])) / 2,
        "gazeLeft": (float(m["lookOutLeft"]) + float(m["lookInRight"])) / 2,
        "gazeRight": (float(m["lookInLeft"]) + float(m["lookOutRight"])) / 2,
    })
    return m


def mouth_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    return (
        float(m["jawOpen"]) <= .16 * factor and float(m["smile"]) <= .21 * factor
        and float(m["frown"]) <= .14 * factor and float(m["funnel"]) <= .14 * factor
        and float(m["pucker"]) <= .20 * factor and float(m["stretch"]) <= .19 * factor
        and float(m["press"]) <= .22 * factor and float(m["roll"]) <= .19 * factor
        and float(m["shrug"]) <= .21 * factor and float(m["mouthLeft"]) <= .16 * factor
        and float(m["mouthRight"]) <= .16 * factor and float(m["upperUp"]) <= .18 * factor
        and float(m["lowerDown"]) <= .18 * factor and float(m["cheekPuff"]) <= .16 * factor
    )


def brows_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    return float(m["browUp"]) <= .20 * factor and float(m["browDown"]) <= .19 * factor


def nose_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    return float(m["sneer"]) <= .15 * factor


def jaw_translation_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    return (
        float(m["jawLeft"]) <= .18 * factor and float(m["jawRight"]) <= .18 * factor
        and float(m["jawForward"]) <= .14 * factor
    )


def gaze_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    return max(float(m[name]) for name in ("gazeUp", "gazeDown", "gazeLeft", "gazeRight")) <= .18 * factor


def basic_eyes_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    left, right = float(m["blinkLeft"]), float(m["blinkRight"])
    return (
        left <= .29 * factor and right <= .29 * factor
        and abs(left - right) <= .24 * factor
        and float(m["eyeWide"]) <= .19 * factor
        and float(m["squint"]) <= .28 * factor
    )


def all_eyes_neutral(m: Mapping[str, float | None], factor: float = 1.0) -> bool:
    return basic_eyes_neutral(m, factor) and gaze_neutral(m, factor)


def _profile(name: str, strength: float, leakage: float, m: Mapping[str, float | None]) -> CleanProfile:
    purity = max(0.0, min(1.0, strength - max(0.0, leakage - 1.0) * .26))
    return CleanProfile(
        name=name, group=PROFILE_GROUPS[name], strength=max(0.0, min(1.5, strength)),
        leakage=max(0.0, leakage), purity=purity,
        yaw=float(m["yaw"]), pitch=float(m["pitch"]), roll=float(m["rollPose"]),
    )


def max_ratio(values: Sequence[tuple[float, float]]) -> float:
    return max((value / limit for value, limit in values), default=0.0)


def wink_flags(m: Mapping[str, float | None]) -> tuple[bool, bool]:
    yaw = abs(float(m["yaw"]))
    if yaw > 36:
        return False, False
    left, right = float(m["blinkLeft"]), float(m["blinkRight"])
    left_ap, right_ap = m["leftAperture"], m["rightAperture"]

    def pass_one(target: float, other: float, closed_ap: float | None, open_ap: float | None) -> bool:
        if target < .35 or other > .32 or target - other < .17:
            return False
        if closed_ap is None or open_ap is None:
            return yaw <= 24 and target >= .43 and target - other >= .24
        opened, closed = float(open_ap), float(closed_ap)
        if opened < .035:
            return False
        ratio_limit = .64 if yaw <= 15 else .56 if yaw <= 27 else .48
        return closed / opened <= ratio_limit

    # MediaPipe names anatomical sides; image-space landmark groups are mirrored.
    return (
        pass_one(left, right, right_ap, left_ap),
        pass_one(right, left, left_ap, right_ap),
    )


def classify_clean_profile(feature: Sequence[float], projection: str | Sequence[float] | None = None) -> CleanProfile | None:
    m = metrics_from_feature(feature, projection)
    wink_left, wink_right = wink_flags(m)
    quiet_mouth = mouth_neutral(m)
    quiet_brows = brows_neutral(m)
    quiet_nose = nose_neutral(m)
    quiet_jaw = jaw_translation_neutral(m)

    # Eye-only states. Mouth, brows, nose, and jaw translation must be quiet.
    if quiet_mouth and quiet_brows and quiet_nose and quiet_jaw:
        other_eye_leak = max_ratio([
            (float(m["eyeWide"]), .20), (float(m["squint"]), .30),
            (max(float(m[n]) for n in ("gazeUp", "gazeDown", "gazeLeft", "gazeRight")), .20),
        ])
        if wink_left and not wink_right and gaze_neutral(m, 1.1):
            return _profile("winkLeft", float(m["blinkLeft"]) - float(m["blinkRight"]), other_eye_leak, m)
        if wink_right and not wink_left and gaze_neutral(m, 1.1):
            return _profile("winkRight", float(m["blinkRight"]) - float(m["blinkLeft"]), other_eye_leak, m)
        if min(float(m["blinkLeft"]), float(m["blinkRight"])) >= .40 and abs(float(m["blinkLeft"]) - float(m["blinkRight"])) <= .22:
            aps = [value for value in (m["leftAperture"], m["rightAperture"]) if value is not None]
            if not aps or max(float(value) for value in aps) <= .060:
                return _profile("blink", min(float(m["blinkLeft"]), float(m["blinkRight"])), other_eye_leak, m)
        if (
            float(m["blinkLeft"]) <= .25 and float(m["blinkRight"]) <= .25
            and abs(float(m["blinkLeft"]) - float(m["blinkRight"])) <= .20
            and float(m["squint"]) <= .28 and gaze_neutral(m, 1.05)
            and float(m["eyeWide"]) >= .18
        ):
            return _profile("eyesWide", float(m["eyeWide"]), float(m["squint"]) / .30, m)
        if basic_eyes_neutral(m, 1.05):
            directions = {
                "gazeUp": float(m["gazeUp"]), "gazeDown": float(m["gazeDown"]),
                "gazeLeft": float(m["gazeLeft"]), "gazeRight": float(m["gazeRight"]),
            }
            ordered = sorted(directions.items(), key=lambda item: item[1], reverse=True)
            if ordered[0][1] >= .18 and ordered[0][1] - ordered[1][1] >= .055:
                return _profile(ordered[0][0], ordered[0][1], ordered[1][1] / .18, m)

    # Brow-only and nose-only states.
    if quiet_mouth and all_eyes_neutral(m, 1.08) and quiet_nose and quiet_jaw:
        up, down = float(m["browUp"]), float(m["browDown"])
        if up >= .19 and down <= .17:
            return _profile("browsUp", up, down / .17, m)
        if down >= .18 and up <= .18:
            return _profile("browsDown", down, up / .18, m)
    if quiet_mouth and all_eyes_neutral(m, 1.08) and quiet_brows and quiet_jaw and float(m["sneer"]) >= .18:
        return _profile("noseSneer", float(m["sneer"]), 0.0, m)

    # Mouth-only states. Every other anatomical family must be quiet.
    if not (all_eyes_neutral(m, 1.08) and quiet_brows and quiet_nose and quiet_jaw):
        return None

    jaw_open = float(m["jawOpen"]); smile = float(m["smile"])
    smile_diff = float(m["smileDifference"]); frown = float(m["frown"])
    funnel = float(m["funnel"]); pucker = float(m["pucker"])
    stretch = float(m["stretch"]); press = float(m["press"]); roll = float(m["roll"])
    shrug = float(m["shrug"]); upper = float(m["upperUp"]); lower = float(m["lowerDown"])
    mouth_left = float(m["mouthLeft"]); mouth_right = float(m["mouthRight"])
    cheek_puff = float(m["cheekPuff"])
    candidates: list[tuple[int, CleanProfile]] = []

    def add(priority: int, name: str, strength: float, leak_pairs: Sequence[tuple[float, float]]) -> None:
        candidates.append((priority, _profile(name, strength, max_ratio(leak_pairs), m)))

    if smile >= .31 and jaw_open >= .21 and smile_diff <= .28 and frown <= .20 and max(funnel, pucker) <= .25:
        add(0, "smileOpen", smile * .70 + jaw_open * .38, ((stretch, .36), (press, .30), (roll, .28)))
    if smile >= .30 and jaw_open <= .19 and smile_diff <= .27 and frown <= .19 and max(funnel, pucker) <= .23:
        add(1, "smileClosed", smile, ((stretch, .34), (press, .31), (roll, .27)))
    if funnel >= .09 and jaw_open >= .08 and pucker < .45 and stretch <= .21 and smile <= .23 and frown <= .18:
        add(2, "mouthRound", funnel * .72 + min(jaw_open, .45) * .44, ((pucker, .46), (press, .28)))
    if pucker >= .27 and jaw_open <= .24 and stretch <= .21 and smile <= .22 and frown <= .18:
        add(3, "mouthPucker", pucker, ((funnel, .34), (press, .29)))
    if stretch >= .23 and smile <= .27 and max(funnel, pucker) <= .23 and frown <= .19:
        add(4, "mouthWide", stretch, ((jaw_open, .46), (press, .31)))
    if press >= .18 and jaw_open <= .17 and smile <= .23 and pucker <= .25 and stretch <= .21:
        add(5, "mouthPress", press, ((roll, .27), (frown, .21)))
    if roll >= .16 and jaw_open <= .22 and smile <= .23 and pucker <= .25 and stretch <= .23:
        add(6, "mouthRoll", roll, ((press, .31), (frown, .21)))
    if mouth_left >= .16 and mouth_right <= .13 and jaw_open <= .23 and smile <= .24 and pucker <= .25 and stretch <= .23:
        add(7, "mouthLeft", mouth_left, ((press, .29), (roll, .29)))
    if mouth_right >= .16 and mouth_left <= .13 and jaw_open <= .23 and smile <= .24 and pucker <= .25 and stretch <= .23:
        add(8, "mouthRight", mouth_right, ((press, .29), (roll, .29)))
    if frown >= .18 and float(m["browDown"]) <= .17 and jaw_open <= .24 and smile <= .21 and pucker <= .23 and stretch <= .23:
        add(9, "mouthFrown", frown, ((press, .33), (roll, .29)))
    if shrug >= .18 and jaw_open <= .24 and smile <= .23 and pucker <= .25 and stretch <= .23:
        add(10, "mouthShrug", shrug, ((press, .34), (roll, .31)))
    if upper >= .17 and lower <= .14 and jaw_open <= .25 and smile <= .25 and pucker <= .24:
        add(11, "mouthUpperUp", upper, ((frown, .24), (stretch, .28)))
    if lower >= .17 and upper <= .14 and jaw_open <= .28 and smile <= .25 and pucker <= .24:
        add(12, "mouthLowerDown", lower, ((frown, .25), (stretch, .28)))
    if cheek_puff >= .20 and jaw_open <= .20 and smile <= .22 and stretch <= .20:
        add(13, "cheekPuff", cheek_puff, ((pucker, .35), (funnel, .35)))
    if jaw_open >= .30 and smile <= .27 and max(funnel, pucker) <= .25 and stretch <= .25 and frown <= .19:
        add(14, "mouthOpen", jaw_open, ((press, .31), (roll, .30)))
    if .12 <= jaw_open < .30 and smile <= .23 and max(funnel, pucker) <= .21 and stretch <= .21 and frown <= .17 and press <= .23 and roll <= .21:
        add(15, "mouthSlightOpen", jaw_open / .30, ())
    if mouth_neutral(m, 1.08):
        leak = max_ratio([
            (float(m["eyeWide"]), .20), (float(m["browUp"]), .20),
            (float(m["browDown"]), .19), (float(m["sneer"]), .15),
        ])
        add(16, "neutral", 1.0 - min(1.0, leak) * .20, ())

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], -item[1].purity))
    best = candidates[0][1]
    return best if best.purity >= .20 else None


def quantized_pose_cell(feature: Sequence[float], step: int = 3) -> tuple[str, int, int]:
    if step <= 0 or 90 % step:
        raise ValueError("pose step must be a positive divisor of 90")
    yaw = round(float(feature[0]) * 90 / step) * step
    pitch = round(float(feature[1]) * 90 / step) * step
    yaw = max(-45, min(45, yaw)); pitch = max(-36, min(36, pitch))
    return f"{yaw}:{pitch}", yaw, pitch
