import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from clean_core_policy_v3 import (
    FEATURE_INDEX, FEATURE_LENGTH, classify_assignment, classify_strict_profile,
    classify_background_profile, classify_target_assisted,
)


def feature(**values):
    result = [0.0] * FEATURE_LENGTH
    for key, value in values.items():
        if key in {"yaw", "pitch", "roll"}:
            result[{"yaw": 0, "pitch": 1, "roll": 2}[key]] = value / 90
        else:
            result[FEATURE_INDEX[key]] = value
    return result


class CleanCorePolicyV3Tests(unittest.TestCase):
    def test_strict_winks_reject_open_mouth(self):
        left = classify_strict_profile(feature(eyeBlinkLeft=.62, eyeBlinkRight=.08))
        right = classify_strict_profile(feature(eyeBlinkRight=.62, eyeBlinkLeft=.08))
        self.assertEqual("winkLeft", left.name)
        self.assertEqual("winkRight", right.name)
        self.assertIsNone(classify_assignment(feature(eyeBlinkLeft=.62, eyeBlinkRight=.08, jawOpen=.45)))
        self.assertIsNone(classify_assignment(feature(eyeBlinkRight=.62, eyeBlinkLeft=.08, mouthSmileLeft=.5, mouthSmileRight=.5)))

    def test_background_is_separately_labelled(self):
        assignment = classify_assignment(feature(mouthSmileLeft=.35, mouthSmileRight=.33, eyeLookUpLeft=.20, eyeLookUpRight=.20))
        self.assertIsNotNone(assignment)
        profile, tier = assignment
        self.assertEqual("backgroundNeutral", profile.name)
        self.assertEqual("background", tier)

    def test_two_strong_families_rejected(self):
        self.assertIsNone(classify_background_profile(feature(jawOpen=.70, eyeWideLeft=.75, eyeWideRight=.72)))
        self.assertIsNone(classify_assignment(feature(jawOpen=.70, eyeWideLeft=.75, eyeWideRight=.72)))

    def test_controlled_facs_targets(self):
        wink = classify_target_assisted("wink", feature(eyeBlinkLeft=.40, eyeBlinkRight=.10))
        self.assertIsNotNone(wink)
        self.assertEqual("winkLeft", wink.name)
        self.assertEqual("eyesWide", classify_target_assisted("eyesWide", feature(eyeWideLeft=.18, eyeWideRight=.17)).name)
        self.assertEqual("noseSneer", classify_target_assisted("noseSneer", feature(noseSneerLeft=.16, noseSneerRight=.14)).name)
        self.assertEqual("mouthPucker", classify_target_assisted("mouthPucker", feature(mouthPucker=.25)).name)
        self.assertIsNone(classify_target_assisted("wink", feature(eyeBlinkLeft=.40, eyeBlinkRight=.10, jawOpen=.35)))

    def test_strict_mouth_profiles_remain_available(self):
        self.assertEqual("mouthOpen", classify_strict_profile(feature(jawOpen=.46)).name)
        self.assertEqual("mouthPucker", classify_strict_profile(feature(mouthPucker=.55)).name)
        self.assertEqual("smileClosed", classify_strict_profile(feature(mouthSmileLeft=.52, mouthSmileRight=.50)).name)


if __name__ == "__main__":
    unittest.main()
