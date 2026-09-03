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
    from run_build_clean_core_v3_repair import fast_rank_diverse, is_verified_facs
else:  # CI's lightweight Python pass intentionally omits image dependencies.
    fast_rank_diverse = None
    is_verified_facs = None


def candidate(index: int, *, verified_facs: bool, dhash: str = "0000000000000000"):
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
class CleanCoreRepairSelectorTests(unittest.TestCase):
    def test_verified_facs_is_not_collapsed_by_uniform_background_hash(self) -> None:
        candidates = [candidate(index, verified_facs=True) for index in range(8)]
        selected = fast_rank_diverse(candidates, 8)
        self.assertEqual(len(selected), 8)
        self.assertTrue(all(is_verified_facs(item) for item in selected))

    def test_natural_near_duplicates_keep_normal_perceptual_filter(self) -> None:
        candidates = [candidate(index, verified_facs=False) for index in range(8)]
        selected = fast_rank_diverse(candidates, 8)
        self.assertEqual(len(selected), 1)

    def test_only_explicit_verified_facs_metadata_gets_the_exception(self) -> None:
        item = candidate(0, verified_facs=False)
        item.entry["sourceKind"] = "verified-synthetic-facs"
        self.assertFalse(is_verified_facs(item))
        item.entry["annotationVerified"] = True
        self.assertTrue(is_verified_facs(item))


if __name__ == "__main__":
    unittest.main()
