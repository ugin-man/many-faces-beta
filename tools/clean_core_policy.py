#!/usr/bin/env python3
"""Clean single-factor face-state policy for Many Faces.

The first clean-core catalog deliberately avoids combinatorial expressions.
An accepted image contains either:
- a neutral face,
- one isolated eye state while mouth/brows/jaw stay neutral, or
- one isolated mouth state while eyes/brows/nose/jaw stay neutral.

Mouth profiles may combine related mouth channels (for example smile + jawOpen
for an open smile), but actions from another anatomical group are rejected.
"""

from __future__ import annotations

import base64
import math
import struct
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

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
POLICY_VERSION = "clean-single-factor-v1"

PROFILE_GROUPS = {
    "neutral": "neutral",
    "winkLeft": "eyes",
    "winkRight": "eyes",
    "blink": "eyes",
    "mouthSlightOpen": "mouth",
    "mouthOpen": "mouth",
    "smileClosed": "mouth",
    "smileOpen": "mouth",
    "mouthRound": "mouth",
    "mouthPucker": "mouth",
    "mouthWide": "mouth",
    "mouthPress": "mouth",
    "mouthRoll": "mouth",
    "mouthLeft": "mouth",
    "mouthRight": "mouth",
    "mouthFrown": "mouth",
}

# Maximum candidates retained in each 3-degree pose cell. Selection is
# breadth-first, so every available profile gets one image before a second.
PROFILE_CELL_LIMITS = {
    "neutral": 12,
    "winkLeft": 4,
    "winkRight": 4,
    "blink": 4,
    "mouthSlightOpen": 6,
    "mouthOpen": 7,
    "smileClosed": 9,
    "smileOpen": 7,
    "mouthRound": 7,
    "mouthPucker": 7,
    "mouthWide": 6,
    "mouthPress": 5,
    "mouthRoll": 5,
    "mouthLeft": 4,
    "mouthRight": 4,
    "mouthFrown": 5,
}

PROFILE_PRIORITY = (
    "neutral",
    "mouthSlightOpen", "mouthOpen", "smileClosed", "smileOpen",
    "mouthRound", "mouthPucker", "mouthWide", "mouthPress", "mouthRoll",
    "mouthLeft", "mouthRight", "mouthFrown",
    "winkLeft", "winkRight", "blink",
)


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


def _clamp01(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return max(0.0, min(1.0, number))


def _decode_projection(encoded: str | Sequence[float] | None) -> list[float] | None:
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


def _aperture(projection: Sequence[float] | None, top: int, bottom: int) -> float | None:
    if projection is None or bottom * 2 + 1 >= len(projection):
        return None
    return abs(float(projection[top * 2 + 1]) - float(projection[bottom * 2 + 1]))


def metrics_from_feature(
    feature: Sequence[float],
    projection: str | Sequence[float] | None = None,
) -> dict[str, float | None]:
    if len(feature) < FEATURE_LENGTH:
        raise ValueError(f"feature must contain {FEATURE_LENGTH} values")

    def score(key: str) -> float:
        return _clamp01(feature[FEATURE_INDEX[key]])

    decoded = _decode_projection(projection)
    values: dict[str, float | None] = {
        "yaw": float(feature[0]) * 90,
        "pitch": float(feature[1]) * 90,
        "rollPose": float(feature[2]) * 90,
        "jawOpen": score("jawOpen"),
        "mouthClose": score("mouthClose"),
        "funnel": score("mouthFunnel"),
        "pucker": score("mouthPucker"),
        "smileLeft": score("mouthSmileLeft"),
        "smileRight": score("mouthSmileRight"),
        "frownLeft": score("mouthFrownLeft"),
        "frownRight": score("mouthFrownRight"),
        "stretchLeft": score("mouthStretchLeft"),
        "stretchRight": score("mouthStretchRight"),
        "blinkLeft": score("eyeBlinkLeft"),
        "blinkRight": score("eyeBlinkRight"),
        "squintLeft": score("eyeSquintLeft"),
        "squintRight": score("eyeSquintRight"),
        "browInnerUp": score("browInnerUp"),
        "browDownLeft": score("browDownLeft"),
        "browDownRight": score("browDownRight"),
        "browOuterUpLeft": score("browOuterUpLeft"),
        "browOuterUpRight": score("browOuterUpRight"),
        "eyeWideLeft": score("eyeWideLeft"),
        "eyeWideRight": score("eyeWideRight"),
        "jawForward": score("jawForward"),
        "jawLeft": score("jawLeft"),
        "jawRight": score("jawRight"),
        "mouthLeft": score("mouthLeft"),
        "mouthRight": score("mouthRight"),
        "pressLeft": score("mouthPressLeft"),
        "pressRight": score("mouthPressRight"),
        "rollLower": score("mouthRollLower"),
        "rollUpper": score("mouthRollUpper"),
        "shrugLower": score("mouthShrugLower"),
        "shrugUpper": score("mouthShrugUpper"),
        "lowerDownLeft": score("mouthLowerDownLeft"),
        "lowerDownRight": score("mouthLowerDownRight"),
        "upperUpLeft": score("mouthUpperUpLeft"),
        "upperUpRight": score("mouthUpperUpRight"),
        "sneerLeft": score("noseSneerLeft"),
        "sneerRight": score("noseSneerRight"),
        "leftAperture": _aperture(decoded, 159, 145),
        "rightAperture": _aperture(decoded, 386, 374),
    }
    values.update({
        "smile": (float(values["smileLeft"]) + float(values["smileRight"])) / 2,
        "smileDifference": abs(float(values["smileLeft"]) - float(values["smileRight"])),
        "frown": (float(values["frownLeft"]) + float(values["frownRight"])) / 2,
        "stretch": (float(values["stretchLeft"]) + float(values["stretchRight"])) / 2,
        "press": (float(values["pressLeft"]) + float(values["pressRight"])) / 2,
        "roll": max(float(values["rollLower"]), float(values["rollUpper"])),
        "shrug": max(float(values["shrugLower"]), float(values["shrugUpper"])),
        "browUp": max(
            float(values["browInnerUp"]),
            float(values["browOuterUpLeft"]),
            float(values["browOuterUpRight"]),
        ),
        "browDown": (float(values["browDownLeft"]) + float(values["browDownRight"])) / 2,
        "sneer": (float(values["sneerLeft"]) + float(values["sneerRight"])) / 2,
    })
    return values


def _mouth_leakage(m: Mapping[str, float | None]) -> float:
    return max(
        float(m["jawOpen"]) / 0.18,
        float(m["smile"]) / 0.24,
        float(m["frown"]) / 0.17,
        float(m["funnel"]) / 0.15,
        float(m["pucker"]) / 0.22,
        float(m["stretch"]) / 0.22,
        float(m["press"]) / 0.24,
        float(m["roll"]) / 0.22,
        float(m["shrug"]) / 0.25,
        float(m["mouthLeft"]) / 0.18,
        float(m["mouthRight"]) / 0.18,
    )


def mouth_is_neutral(m: Mapping[str, float | None], *, relaxed: bool = False) -> bool:
    factor = 1.18 if relaxed else 1.0
    return (
        float(m["jawOpen"]) <= 0.14 * factor
        and float(m["smile"]) <= 0.19 * factor
        and float(m["frown"]) <= 0.12 * factor
        and float(m["funnel"]) <= 0.12 * factor
        and float(m["pucker"]) <= 0.17 * factor
        and float(m["stretch"]) <= 0.17 * factor
        and float(m["press"]) <= 0.19 * factor
        and float(m["roll"]) <= 0.17 * factor
        and float(m["shrug"]) <= 0.19 * factor
        and float(m["mouthLeft"]) <= 0.14 * factor
        and float(m["mouthRight"]) <= 0.14 * factor
    )


def _other_groups_neutral(m: Mapping[str, float | None]) -> bool:
    return (
        float(m["browUp"]) <= 0.42
        and float(m["browDown"]) <= 0.30
        and float(m["sneer"]) <= 0.16
        and float(m["jawLeft"]) <= 0.16
        and float(m["jawRight"]) <= 0.16
        and float(m["jawForward"]) <= 0.10
    )


def _wink_flags(m: Mapping[str, float | None]) -> tuple[bool, bool]:
    absolute_yaw = abs(float(m["yaw"]))
    if absolute_yaw > 33:
        return False, False
    left_blink = float(m["blinkLeft"])
    right_blink = float(m["blinkRight"])
    left_aperture = m["leftAperture"]
    right_aperture = m["rightAperture"]

    def passes(
        target: float,
        other: float,
        closed_aperture: float | None,
        open_aperture: float | None,
    ) -> bool:
        if target < 0.52 or other > 0.19 or target - other < 0.40:
            return False
        if closed_aperture is None or open_aperture is None:
            return absolute_yaw <= 18
        opened = float(open_aperture)
        closed = float(closed_aperture)
        if opened < 0.045:
            return False
        max_ratio = 0.46 if absolute_yaw <= 18 else 0.36 if absolute_yaw <= 27 else 0.30
        return closed / opened <= max_ratio

    # Blendshape sides are anatomical; image-space eye landmarks are mirrored.
    return (
        passes(left_blink, right_blink, right_aperture, left_aperture),
        passes(right_blink, left_blink, left_aperture, right_aperture),
    )


def eyes_are_neutral(m: Mapping[str, float | None]) -> bool:
    wink_left, wink_right = _wink_flags(m)
    if wink_left or wink_right:
        return False
    left = float(m["blinkLeft"])
    right = float(m["blinkRight"])
    if min(left, right) >= 0.48:
        return False
    if abs(left - right) >= 0.42 and max(left, right) >= 0.58:
        return False
    return True


def _profile(
    name: str,
    strength: float,
    leakage: float,
    m: Mapping[str, float | None],
) -> CleanProfile:
    purity = max(0.0, min(1.0, strength - max(0.0, leakage - 1.0) * 0.28))
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


def classify_clean_profile(
    feature: Sequence[float],
    projection: str | Sequence[float] | None = None,
) -> CleanProfile | None:
    """Return one isolated v1 profile, or None when actions are mixed/unclear."""
    m = metrics_from_feature(feature, projection)
    wink_left, wink_right = _wink_flags(m)

    # Eye states are accepted only when the mouth and the remaining groups are
    # neutral. This explicitly rejects wink + open mouth / smile combinations.
    if mouth_is_neutral(m) and _other_groups_neutral(m):
        if wink_left and not wink_right:
            return _profile(
                "winkLeft",
                float(m["blinkLeft"]) - float(m["blinkRight"]),
                _mouth_leakage(m),
                m,
            )
        if wink_right and not wink_left:
            return _profile(
                "winkRight",
                float(m["blinkRight"]) - float(m["blinkLeft"]),
                _mouth_leakage(m),
                m,
            )
        if (
            min(float(m["blinkLeft"]), float(m["blinkRight"])) >= 0.54
            and abs(float(m["blinkLeft"]) - float(m["blinkRight"])) <= 0.16
        ):
            left_aperture = m["leftAperture"]
            right_aperture = m["rightAperture"]
            if (
                left_aperture is None
                or right_aperture is None
                or max(float(left_aperture), float(right_aperture)) <= 0.042
            ):
                return _profile(
                    "blink",
                    min(float(m["blinkLeft"]), float(m["blinkRight"])),
                    _mouth_leakage(m),
                    m,
                )

    # Mouth states keep eyes, brows, nose and jaw translation neutral. Related
    # mouth channels may combine inside one named mouth state.
    if not eyes_are_neutral(m) or not _other_groups_neutral(m):
        return None

    jaw_open = float(m["jawOpen"])
    smile = float(m["smile"])
    smile_difference = float(m["smileDifference"])
    frown = float(m["frown"])
    funnel = float(m["funnel"])
    pucker = float(m["pucker"])
    stretch = float(m["stretch"])
    press = float(m["press"])
    roll = float(m["roll"])
    mouth_left = float(m["mouthLeft"])
    mouth_right = float(m["mouthRight"])

    candidates: list[tuple[int, CleanProfile]] = []

    def add(priority: int, name: str, strength: float, allowed_leakage: Iterable[float]) -> None:
        leakage = max(allowed_leakage, default=0.0)
        candidates.append((priority, _profile(name, strength, leakage, m)))

    if (
        smile >= 0.34 and jaw_open >= 0.22 and smile_difference <= 0.25
        and frown <= 0.18 and max(funnel, pucker) <= 0.23
    ):
        add(0, "smileOpen", smile * 0.72 + jaw_open * 0.38, (stretch / 0.32, press / 0.28, roll / 0.25))
    if (
        smile >= 0.34 and jaw_open <= 0.17 and smile_difference <= 0.22
        and frown <= 0.16 and max(funnel, pucker) <= 0.20
    ):
        add(1, "smileClosed", smile, (stretch / 0.30, press / 0.28, roll / 0.24))
    if (
        funnel >= 0.10 and jaw_open >= 0.10 and pucker < 0.42
        and stretch <= 0.18 and smile <= 0.20 and frown <= 0.15
    ):
        add(2, "mouthRound", funnel * 0.72 + min(jaw_open, 0.45) * 0.45, (pucker / 0.44, press / 0.25))
    if (
        pucker >= 0.30 and jaw_open <= 0.22 and stretch <= 0.18
        and smile <= 0.18 and frown <= 0.15
    ):
        add(3, "mouthPucker", pucker, (funnel / 0.30, press / 0.25))
    if (
        stretch >= 0.25 and smile <= 0.24 and max(funnel, pucker) <= 0.20
        and frown <= 0.16
    ):
        add(4, "mouthWide", stretch, (jaw_open / 0.42, press / 0.28))
    if (
        press >= 0.20 and jaw_open <= 0.14 and smile <= 0.20
        and pucker <= 0.22 and stretch <= 0.18
    ):
        add(5, "mouthPress", press, (roll / 0.24, frown / 0.18))
    if (
        roll >= 0.18 and jaw_open <= 0.20 and smile <= 0.20
        and pucker <= 0.22 and stretch <= 0.20
    ):
        add(6, "mouthRoll", roll, (press / 0.28, frown / 0.18))
    if (
        mouth_left >= 0.18 and mouth_right <= 0.10 and jaw_open <= 0.20
        and smile <= 0.20 and pucker <= 0.22 and stretch <= 0.20
    ):
        add(7, "mouthLeft", mouth_left, (press / 0.25, roll / 0.25))
    if (
        mouth_right >= 0.18 and mouth_left <= 0.10 and jaw_open <= 0.20
        and smile <= 0.20 and pucker <= 0.22 and stretch <= 0.20
    ):
        add(8, "mouthRight", mouth_right, (press / 0.25, roll / 0.25))
    if (
        frown >= 0.20 and float(m["browDown"]) <= 0.18 and jaw_open <= 0.22
        and smile <= 0.18 and pucker <= 0.20 and stretch <= 0.20
    ):
        add(9, "mouthFrown", frown, (press / 0.30, roll / 0.25))
    if (
        jaw_open >= 0.32 and smile <= 0.24 and max(funnel, pucker) <= 0.22
        and stretch <= 0.22 and frown <= 0.16
    ):
        add(10, "mouthOpen", jaw_open, (press / 0.28, roll / 0.26))
    if (
        0.14 <= jaw_open < 0.32 and smile <= 0.20 and max(funnel, pucker) <= 0.18
        and stretch <= 0.18 and frown <= 0.14 and press <= 0.20 and roll <= 0.18
    ):
        add(11, "mouthSlightOpen", jaw_open / 0.32, ())
    if mouth_is_neutral(m):
        add(12, "neutral", 1.0 - min(1.0, _mouth_leakage(m)) * 0.36, ())

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], -item[1].purity))
    best = candidates[0][1]
    if best.purity < 0.24:
        return None
    return best


def quantized_pose_cell(feature: Sequence[float], step: int = 3) -> tuple[str, int, int]:
    if step <= 0 or 90 % step:
        raise ValueError("pose step must be a positive divisor of 90")
    yaw = round(float(feature[0]) * 90 / step) * step
    pitch = round(float(feature[1]) * 90 / step) * step
    yaw = max(-45, min(45, yaw))
    pitch = max(-36, min(36, pitch))
    return f"{yaw}:{pitch}", yaw, pitch
