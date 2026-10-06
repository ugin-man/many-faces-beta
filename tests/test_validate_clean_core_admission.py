import json
import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from validate_clean_core_admission import final_entries, validate_evidence_totals, validate_selection_identity
from clean_core_policy_v3 import POLICY_VERSION, PROFILE_EVIDENCE_TIERS, STRICT_PROFILE_PRIORITY, OBSERVED_PROFILE_PRIORITY


class PhysicalPoseAssignmentTests(unittest.TestCase):
    def test_balanced_cross_cell_swap_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "shards").mkdir()
            manifest = {"cells": {"-15:0": {"count": 1, "shards": ["left.json"]}, "15:0": {"count": 1, "shards": ["right.json"]}}}
            for cell, filename, yaw in (("-15:0", "left.json", -15), ("15:0", "right.json", 15)):
                (root / "shards" / filename).write_text(json.dumps({"cell": cell, "items": [{"feature": [yaw / 90, 0, 0] + [0] * 52}]}))
            self.assertEqual(len(list(final_entries(root, manifest))), 2)
            # Headers and aggregate fresh pose counts still look correct after
            # this equal-size swap, but each photo is now in the opposite shard.
            for cell, filename, yaw in (("-15:0", "left.json", 15), ("15:0", "right.json", -15)):
                (root / "shards" / filename).write_text(json.dumps({"cell": cell, "items": [{"feature": [yaw / 90, 0, 0] + [0] * 52}]}))
            with self.assertRaisesRegex(ValueError, "wrong physical pose cell"):
                list(final_entries(root, manifest))


class PhysicalEvidenceTierTests(unittest.TestCase):
    def fixture(self):
        counts = {"strict": {"winkLeft": 2}, "observed": {"winkLeft": 3, "winkRight": 4},
                  "background": {"backgroundNeutral": 5}}
        cells = {"strict": {"winkLeft": {"0:0"}},
                 "observed": {"winkLeft": {"0:0", "3:0"}, "winkRight": {"0:0", "-3:0"}}}
        common = {"policyVersion": POLICY_VERSION,
                  "profileEvidenceTiers": {name: list(tiers) for name, tiers in PROFILE_EVIDENCE_TIERS.items()}}
        selection, stats = copy.deepcopy(common), copy.deepcopy(common)
        tier_counts = {tier: sum(values.values()) for tier, values in counts.items()}
        selection["selectedTiers"], stats["tierCounts"] = tier_counts, tier_counts.copy()
        for tier, names, audit_count, manifest_count, cell_field in (
            ("strict", STRICT_PROFILE_PRIORITY, "strictProfiles", "strictProfileCounts", "strictProfilePoseCells"),
            ("observed", OBSERVED_PROFILE_PRIORITY, "observedProfiles", "observedProfileCounts", "observedProfilePoseCells"),
        ):
            totals = {name: counts[tier].get(name, 0) for name in names}
            breadth = {name: len(cells[tier].get(name, set())) for name in names}
            selection[audit_count], stats[manifest_count] = totals, totals.copy()
            selection[cell_field], stats[cell_field] = breadth, breadth.copy()
        return selection, stats, counts, cells

    def test_observed_winks_are_reported_separately_from_isolated_ones(self):
        result = validate_evidence_totals(*self.fixture())
        self.assertEqual(result["strictProfiles"]["winkLeft"], 2)
        self.assertEqual(result["observedProfiles"]["winkLeft"], 3)
        self.assertEqual(result["strictProfilePoseCells"]["winkLeft"], 1)
        self.assertEqual(result["observedProfilePoseCells"]["winkLeft"], 2)

    def test_observed_count_cannot_be_relabelled_as_isolated_coverage(self):
        selection, stats, counts, cells = self.fixture()
        selection["strictProfiles"]["winkLeft"] = 5
        stats["strictProfileCounts"]["winkLeft"] = 5
        with self.assertRaisesRegex(ValueError, "Isolated/observed profile counts"):
            validate_evidence_totals(selection, stats, counts, cells)

    def test_undeclared_observed_profile_cannot_satisfy_a_minimum(self):
        selection, stats, counts, cells = self.fixture()
        counts["observed"]["mouthFrown"] = 1
        with self.assertRaisesRegex(ValueError, "undeclared evidence tier"):
            validate_evidence_totals(selection, stats, counts, cells)

    def test_missing_or_changed_evidence_declaration_is_rejected(self):
        selection, stats, counts, cells = self.fixture()
        selection["profileEvidenceTiers"]["winkLeft"] = ["strict"]
        with self.assertRaisesRegex(ValueError, "Declared expression evidence tiers"):
            validate_evidence_totals(selection, stats, counts, cells)


class PhysicalSelectionIdentityTests(unittest.TestCase):
    def fixture(self, additional=None):
        try:
            from build_clean_core_v3 import selection_identity, selection_identity_sha256
        except ModuleNotFoundError as error:
            if error.name in {"numpy", "PIL"}:
                self.skipTest("catalog image dependencies unavailable")
            raise
        identity = selection_identity("a" * 64, 70000, 6, additional)
        digest = selection_identity_sha256(identity)
        selection = {"selectionIdentity": identity, "selectionIdentitySha256": digest}
        manifest = {**copy.deepcopy(selection), "catalogId": "many-faces-clean-core-v5-" + digest[:16] + "-pose-local-v1"}
        return manifest, selection

    def test_catalog_id_binds_the_effective_policy_and_original_audit(self):
        manifest, selection = self.fixture()
        validated = validate_selection_identity(manifest, selection, "a" * 64, 70000)
        self.assertEqual(validated["selectionIdentitySha256"], manifest["selectionIdentitySha256"])
        with self.assertRaisesRegex(ValueError, "admission receipt differ"):
            validate_selection_identity(manifest, selection, "b" * 64, 70000)

    def test_old_receipt_only_catalog_id_cannot_alias_changed_selection(self):
        manifest, selection = self.fixture()
        manifest["catalogId"] = "many-faces-clean-core-v5-" + "a" * 12 + "-pose-local-v1"
        with self.assertRaisesRegex(ValueError, "Catalog identity is not bound"):
            validate_selection_identity(manifest, selection, "a" * 64, 70000)

    def test_an_unenforced_additional_review_gate_cannot_be_claimed(self):
        manifest, selection = self.fixture("c" * 64)
        with self.assertRaisesRegex(ValueError, "bound deny-only review validator"):
            validate_selection_identity(manifest, selection, "a" * 64, 70000)

if __name__ == "__main__":
    unittest.main()
