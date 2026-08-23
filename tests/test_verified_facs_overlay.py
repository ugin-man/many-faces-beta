from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

HAS_IMAGE_RUNTIME = (
    importlib.util.find_spec("numpy") is not None
    and importlib.util.find_spec("PIL") is not None
)

if HAS_IMAGE_RUNTIME:
    from apply_verified_facs_annotations import (
        CANONICAL_ACTIONS,
        canonical_feature,
        corrected_projection,
        encode_projection,
    )
    from clean_core_policy_v3 import FEATURE_LENGTH, classify_strict_profile
    from mirror_clean_core_pairs import MIRROR_TARGETS
    from run_build_clean_core_v3_repair import fast_rank_diverse, is_verified_facs
else:  # Lightweight CI validates syntax without the optional image stack.
    CANONICAL_ACTIONS = {}
    FEATURE_LENGTH = 55
    MIRROR_TARGETS = {}
    canonical_feature = corrected_projection = encode_projection = None
    classify_strict_profile = fast_rank_diverse = is_verified_facs = None


def selector_candidate(
    index: int,
    *,
    verified_facs: bool,
    dhash: str = "0000000000000000",
):
    entry = {
        "id": f"candidate-{index}",
        "creator": f"identity-{index}",
    }
    if verified_facs:
        entry.update(
            {
                "sourceKind": "verified-synthetic-facs",
                "annotationVerified": True,
            }
        )
    return SimpleNamespace(
        score=1.0 - index * 0.01,
        source=SimpleNamespace(catalog_id="facs" if verified_facs else "natural"),
        entry=entry,
        structure=(index * 0.05, index * 0.08, index * 0.11),
        dhash=dhash,
    )


@unittest.skipUnless(HAS_IMAGE_RUNTIME, "optional NumPy/Pillow runtime is not installed")
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

    def test_uniform_facs_background_does_not_erase_verified_profiles(self) -> None:
        candidates = [selector_candidate(index, verified_facs=True) for index in range(8)]
        selected = fast_rank_diverse(candidates, 8)
        self.assertEqual(len(selected), 8)
        self.assertTrue(all(is_verified_facs(item) for item in selected))

    def test_natural_near_duplicates_still_use_perceptual_filter(self) -> None:
        candidates = [selector_candidate(index, verified_facs=False) for index in range(8)]
        selected = fast_rank_diverse(candidates, 8)
        self.assertEqual(len(selected), 1)

    def test_mirroring_swaps_asymmetric_profiles(self) -> None:
        self.assertEqual(MIRROR_TARGETS["winkLeft"], "winkRight")
        self.assertEqual(MIRROR_TARGETS["mouthRight"], "mouthLeft")

    def test_mirroring_preserves_symmetric_profile_labels(self) -> None:
        for profile in ("eyesWide", "noseSneer", "mouthRound", "mouthWide"):
            with self.subTest(profile=profile):
                self.assertEqual(MIRROR_TARGETS[profile], profile)


if __name__ == "__main__":
    unittest.main()
