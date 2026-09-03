import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from clean_core_policy_v2 import BLEND_KEYS, FEATURE_INDEX, FEATURE_LENGTH, classify_clean_profile


def feature(**values):
    result = [0.0] * FEATURE_LENGTH
    for key, value in values.items():
        if key in {"yaw", "pitch", "roll"}:
            result[{"yaw": 0, "pitch": 1, "roll": 2}[key]] = value / 90
        else:
            result[FEATURE_INDEX[key]] = value
    return result


class CleanCorePolicyV2Tests(unittest.TestCase):
    def assert_profile(self, expected, **values):
        profile = classify_clean_profile(feature(**values))
        self.assertIsNotNone(profile)
        self.assertEqual(expected, profile.name)

    def test_neutral(self):
        self.assert_profile("neutral")

    def test_winks_require_neutral_mouth(self):
        self.assert_profile("winkLeft", eyeBlinkLeft=.62, eyeBlinkRight=.08)
        self.assert_profile("winkRight", eyeBlinkRight=.62, eyeBlinkLeft=.08)
        self.assertIsNone(classify_clean_profile(feature(eyeBlinkLeft=.62, eyeBlinkRight=.08, jawOpen=.45)))
        self.assertIsNone(classify_clean_profile(feature(eyeBlinkRight=.62, eyeBlinkLeft=.08, mouthSmileLeft=.5, mouthSmileRight=.5)))

    def test_eye_and_brow_profiles(self):
        self.assert_profile("blink", eyeBlinkLeft=.58, eyeBlinkRight=.61)
        self.assert_profile("eyesWide", eyeWideLeft=.34, eyeWideRight=.31)
        self.assert_profile("gazeUp", eyeLookUpLeft=.32, eyeLookUpRight=.30)
        self.assert_profile("gazeLeft", eyeLookOutLeft=.32, eyeLookInRight=.30)
        self.assert_profile("browsUp", browInnerUp=.36)
        self.assert_profile("browsDown", browDownLeft=.31, browDownRight=.29)
        self.assert_profile("noseSneer", noseSneerLeft=.30, noseSneerRight=.28)

    def test_mouth_profiles_keep_eyes_neutral(self):
        self.assert_profile("mouthSlightOpen", jawOpen=.20)
        self.assert_profile("mouthOpen", jawOpen=.46)
        self.assert_profile("smileClosed", mouthSmileLeft=.52, mouthSmileRight=.50)
        self.assert_profile("smileOpen", mouthSmileLeft=.49, mouthSmileRight=.47, jawOpen=.35)
        self.assert_profile("mouthPucker", mouthPucker=.55)
        self.assert_profile("mouthWide", mouthStretchLeft=.40, mouthStretchRight=.42)
        self.assert_profile("mouthPress", mouthPressLeft=.35, mouthPressRight=.34)
        self.assert_profile("mouthRoll", mouthRollLower=.30, mouthRollUpper=.28)
        self.assert_profile("mouthLeft", mouthLeft=.34)
        self.assert_profile("mouthRight", mouthRight=.34)
        self.assert_profile("mouthFrown", mouthFrownLeft=.34, mouthFrownRight=.32)
        self.assert_profile("mouthShrug", mouthShrugLower=.31, mouthShrugUpper=.30)
        self.assert_profile("mouthUpperUp", mouthUpperUpLeft=.30, mouthUpperUpRight=.29)
        self.assert_profile("mouthLowerDown", mouthLowerDownLeft=.30, mouthLowerDownRight=.29)
        self.assert_profile("cheekPuff", cheekPuff=.36)
        self.assertIsNone(classify_clean_profile(feature(mouthPucker=.55, eyeBlinkLeft=.60, eyeBlinkRight=.08)))

    def test_mixed_brow_and_mouth_rejected(self):
        self.assertIsNone(classify_clean_profile(feature(jawOpen=.40, browInnerUp=.38)))


if __name__ == "__main__":
    unittest.main()
