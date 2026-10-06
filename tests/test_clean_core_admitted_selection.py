import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
try:
    from build_clean_core_v3 import (admitted_entry, fill_breadth_first, title_rejection,
                                    selection_identity, selection_identity_sha256)
except ModuleNotFoundError as error:
    if error.name not in {"numpy", "PIL"}:
        raise
    admitted_entry = None


@unittest.skipIf(admitted_entry is None, "catalog image dependencies unavailable")
class AdmittedSelectionTests(unittest.TestCase):
    def test_reserved_minimums_survive_exact_target(self):
        reserved = SimpleNamespace(key="reserved")
        groups = {
            ("winkLeft", "-12:0"): [SimpleNamespace(key=f"left-{i}") for i in range(9)],
            ("winkRight", "12:0"): [SimpleNamespace(key=f"right-{i}") for i in range(9)],
        }
        selected = [reserved]
        fill_breadth_first(selected, groups, ["winkLeft", "winkRight"], 6)
        self.assertEqual(len(selected), 6)
        self.assertIs(selected[0], reserved)
        self.assertEqual([c.key for c in selected[1:]], ["left-0", "right-0", "left-1", "right-1", "left-2"])
        fill_breadth_first(selected, groups, ["winkLeft", "winkRight"], 6)
        self.assertEqual(len(selected), 6)

    def test_existing_entries_are_not_selected_twice(self):
        first = SimpleNamespace(key="first")
        selected = [first]
        fill_breadth_first(selected, {("p", "0:0"): [first, SimpleNamespace(key="second")]}, ["p"], 3)
        self.assertEqual([c.key for c in selected], ["first", "second"])

    def test_all_measurements_are_fresh_before_classification(self):
        source = {"id": "original", "feature": [-.5] * 55, "shape": "old", "mesh": "old",
                  "projection": "old", "layout": [0, 0, 0, 0], "cleanProfile": "old-profile", "name": "Photo"}
        record = {"feature": [.25] * 55, "shape": "new-shape", "mesh": "new-mesh", "projection": "new-projection",
                  "layout": [.5, .5, .6, .8], "encodedSha256": "a" * 64, "policySha256": "b" * 64,
                  "sourceCatalogId": "source", "sourceId": "original"}
        fresh = admitted_entry(source, record)
        for key in ("feature", "shape", "mesh", "projection", "layout"):
            self.assertEqual(fresh[key], record[key])
        self.assertNotIn("cleanProfile", fresh)
        self.assertEqual(source["feature"][0], -.5)
        self.assertEqual(fresh["admissionSourceId"], "original")

    def test_paint_and_incidental_titles_do_not_veto_visibility(self):
        profile = SimpleNamespace(group="mouth")
        for name in ("Face Painting Festival", "Facepaint", "ordinary eyeglasses", "DSCN9586", "50 shades of blue", "Singing on stage"):
            self.assertIsNone(title_rejection({"name": name}, profile), name)
        self.assertEqual(title_rejection({"name": "Oil painting portrait"}, profile), "likely_artwork")

    def test_selection_identity_changes_with_classification_or_additional_reviews(self):
        original = selection_identity("a" * 64, 70000, 6)
        digest = selection_identity_sha256(original)
        self.assertEqual(digest, selection_identity_sha256(selection_identity("a" * 64, 70000, 6)))
        for changed in (
            {**original, "policyVersion": "a-different-classification-policy"},
            selection_identity("b" * 64, 70000, 6),
            selection_identity("a" * 64, 70000, 7),
            selection_identity("a" * 64, 70000, 6, "c" * 64),
        ):
            self.assertNotEqual(digest, selection_identity_sha256(changed))
        self.assertEqual(set(original["selectionCodeSha256"]), {
            "clean_core_policy_v2.py", "clean_core_policy_v3.py", "build_clean_core_v3.py",
            "run_build_clean_core_v3_real_only.py", "run_build_clean_core_v3_repair.py"})


if __name__ == "__main__":
    unittest.main()
