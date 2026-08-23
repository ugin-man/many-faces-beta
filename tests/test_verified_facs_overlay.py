from __future__ import annotations

import base64
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from apply_verified_facs_annotations import (
    CANONICAL_ACTIONS,
    canonical_feature,
    corrected_projection,
    encode_projection,
)
from clean_core_policy_v3 import FEATURE_LENGTH, classify_strict_profile


class VerifiedFacsOverlayTests(unittest.TestCase):
    def base_feature(self) -> list[float]:
        return [0.0] * FEATURE_LENGTH

    def projection(self) -> str:
        # 468 x/y pairs. Give both eyes a normal starting aperture; the overlay
        # then applies the verified eye state.
        values = [0.0] * (468 * 2)
        values[159 * 2 + 1] = -0.03
        values[145 * 2 + 1] = 0.03
        values[386 * 2 + 1] = -0.03
        values[374 * 2 + 1] = 0.03
        return encode_projection(values)

    def test_every_verified_profile_reclassifies_as_itself(self) -> None:
        for profile in CANONICAL_ACTIONS:
            with self.subTest(profile=profile):
                feature = canonical_feature(self.base_feature(), profile)
                projection = corrected_projection(self.projection(), profile)
                classified = classify_strict_profile(feature, projection)
                self.assertIsNotNone(classified)
                self.assertEqual(classified.name, profile)

    def test_wink_projection_keeps_opposite_eye_open(self) -> None:
        for profile in ("winkLeft", "winkRight"):
            feature = canonical_feature(self.base_feature(), profile)
            projection = corrected_projection(self.projection(), profile)
            classified = classify_strict_profile(feature, projection)
            self.assertIsNotNone(classified)
            self.assertEqual(classified.name, profile)


if __name__ == "__main__":
    unittest.main()
