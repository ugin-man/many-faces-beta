from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from clean_core_v2_overlay import IDX, PROFILE_LIMITS, classify_clean_profile


def feature(**values: float) -> list[float]:
    output = [0.0] * 55
    for name, value in values.items():
        output[IDX[name]] = value
    return output


class CleanCoreV2PolicyTests(unittest.TestCase):
    def test_neutral(self) -> None:
        self.assertEqual(classify_clean_profile(feature()), "neutral")

    def test_winks_require_neutral_mouth(self) -> None:
        self.assertEqual(
            classify_clean_profile(feature(eyeBlinkLeft=0.72, eyeBlinkRight=0.06)),
            "winkLeft",
        )
        self.assertEqual(
            classify_clean_profile(feature(eyeBlinkRight=0.72, eyeBlinkLeft=0.06)),
            "winkRight",
        )
        self.assertIsNone(
            classify_clean_profile(
                feature(eyeBlinkLeft=0.72, eyeBlinkRight=0.06, jawOpen=0.55)
            )
        )
        self.assertIsNone(
            classify_clean_profile(
                feature(
                    eyeBlinkRight=0.72,
                    eyeBlinkLeft=0.06,
                    mouthSmileLeft=0.55,
                    mouthSmileRight=0.55,
                )
            )
        )

    def test_brows_require_neutral_eyes_and_mouth(self) -> None:
        self.assertEqual(classify_clean_profile(feature(browInnerUp=0.55)), "browsUp")
        self.assertEqual(
            classify_clean_profile(feature(browDownLeft=0.5, browDownRight=0.5)),
            "browsDown",
        )
        self.assertIsNone(
            classify_clean_profile(feature(browInnerUp=0.55, jawOpen=0.5))
        )

    def test_mouth_hierarchy_keeps_one_profile(self) -> None:
        self.assertEqual(
            classify_clean_profile(
                feature(mouthSmileLeft=0.55, mouthSmileRight=0.55, jawOpen=0.5)
            ),
            "smileOpen",
        )
        self.assertEqual(
            classify_clean_profile(
                feature(mouthSmileLeft=0.55, mouthSmileRight=0.55, jawOpen=0.05)
            ),
            "smileClosed",
        )
        self.assertEqual(classify_clean_profile(feature(mouthPucker=0.6)), "mouthPucker")
        self.assertEqual(classify_clean_profile(feature(mouthFunnel=0.6)), "mouthRound")
        self.assertEqual(classify_clean_profile(feature(jawOpen=0.55)), "mouthOpen")

    def test_mouth_profile_rejects_eye_activity(self) -> None:
        self.assertIsNone(
            classify_clean_profile(feature(mouthPucker=0.6, eyeBlinkLeft=0.65))
        )

    def test_v2_has_capacity_for_more_than_70k(self) -> None:
        self.assertGreater(sum(PROFILE_LIMITS.values()) * 775, 70000)


if __name__ == "__main__":
    unittest.main()
