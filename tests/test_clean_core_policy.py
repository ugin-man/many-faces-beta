import unittest

from tools.clean_core_policy import (
    BLEND_KEYS,
    FEATURE_INDEX,
    FEATURE_LENGTH,
    classify_clean_profile,
    quantized_pose_cell,
)


def feature(**values):
    output = [0.0] * FEATURE_LENGTH
    for key, value in values.items():
        if key in {"yaw", "pitch", "roll"}:
            output[{"yaw": 0, "pitch": 1, "roll": 2}[key]] = value / 90
        else:
            output[FEATURE_INDEX[key]] = value
    return output


class CleanCorePolicyTest(unittest.TestCase):
    def test_neutral(self):
        profile = classify_clean_profile(feature())
        self.assertIsNotNone(profile)
        self.assertEqual(profile.name, "neutral")

    def test_isolated_open_mouth(self):
        profile = classify_clean_profile(feature(jawOpen=0.52))
        self.assertIsNotNone(profile)
        self.assertEqual(profile.name, "mouthOpen")

    def test_isolated_open_smile(self):
        profile = classify_clean_profile(
            feature(jawOpen=0.36, mouthSmileLeft=0.72, mouthSmileRight=0.68)
        )
        self.assertIsNotNone(profile)
        self.assertEqual(profile.name, "smileOpen")

    def test_pucker(self):
        profile = classify_clean_profile(feature(mouthPucker=0.72))
        self.assertIsNotNone(profile)
        self.assertEqual(profile.name, "mouthPucker")

    def test_wink_with_open_mouth_is_rejected(self):
        profile = classify_clean_profile(
            feature(eyeBlinkLeft=0.82, eyeBlinkRight=0.08, jawOpen=0.46)
        )
        self.assertIsNone(profile)

    def test_open_mouth_with_brow_action_is_rejected(self):
        profile = classify_clean_profile(feature(jawOpen=0.52, browInnerUp=0.80))
        self.assertIsNone(profile)

    def test_pose_uses_three_degree_cells(self):
        self.assertEqual(quantized_pose_cell(feature(yaw=4.4, pitch=-5.0)), ("3:-6", 3, -6))


if __name__ == "__main__":
    unittest.main()
