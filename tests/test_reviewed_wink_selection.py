import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from clean_core_policy_v3 import classify_assignment, observed_wink_evidence
from clean_core_selection_review import WinkExpressionReview
from validate_clean_core_admission import validate_wink_review_binding

FIXTURE = json.loads((Path(__file__).parent / "fixtures/reviewed-wink-admission.json").read_text())


class ReviewedWinkSelectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        document = FIXTURE["reviewDocument"]
        self.path = self.root / "source-review.json"
        self.path.write_text(json.dumps(document, indent=2))
        self.review = WinkExpressionReview(self.path, document["candidateAuditSha256"], document["recordsSha256"])

    def test_frozen_records_and_reviewed_sides_reproduce_true_and_false_automatic_cases(self):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute("CREATE TABLE records(source_catalog_id TEXT,source_id TEXT,encoded_sha256 TEXT,record_sha256 TEXT)")
        for row in FIXTURE["records"]:
            record = row["record"]
            # The inference receipt uses canonical JSON with no trailing line.
            raw = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row["recordSha256"])
            connection.execute("INSERT INTO records VALUES(?,?,?,?)", (
                record["sourceCatalogId"], record["sourceId"], record["encodedSha256"], row["recordSha256"],
            ))
        self.review.validate_audit_records(connection)
        outcomes = {}
        for row in FIXTURE["records"]:
            with self.subTest(sample=row["sampleId"]):
                record = copy.deepcopy(row["record"])
                self.assertEqual(record["decision"], "pass")
                self.assertIsNotNone(observed_wink_evidence(record["feature"], record["projection"]))
                side = self.review.side_for(record["encodedSha256"])
                assignment = classify_assignment(record["feature"], record["projection"], allow_observed_wink=side)
                outcomes[row["sampleId"]] = None if assignment is None else (assignment[0].name, assignment[1])
                if row["sampleId"] in ("WL011", "WR043"):
                    self.assertEqual(outcomes[row["sampleId"]], ("wink" + side.title(), "observed"))
                else:
                    self.assertIsNone(side)
                    self.assertTrue(assignment is None or assignment[0].name not in ("winkLeft", "winkRight"))
                self.assertEqual(record, row["record"])
        # The toddler's downward gaze stays a useful ordinary core candidate;
        # a disputed wink is not turned into an image visibility denial.
        self.assertEqual(outcomes["MF011"], ("backgroundNeutral", "background"))

    def test_physical_catalog_requires_the_exact_review_file_and_enforced_gate(self):
        self.review.write_catalog_files(self.root)
        manifest = {"winkExpressionReview": self.review.stamp()}
        selection = {**copy.deepcopy(manifest), "winkExpressionReviewSha256": self.review.sha256,
                     "allSelectedWinkProfilesHaveReviewedEvidence": True}
        validate_wink_review_binding(manifest, selection, self.root, self.review)
        for patch in ({"winkExpressionReviewSha256": "f" * 64},
                      {"allSelectedWinkProfilesHaveReviewedEvidence": False},
                      {"winkExpressionReview": {**self.review.stamp(), "confirmedEncodedImages": 70000}}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_wink_review_binding(manifest, {**selection, **patch}, self.root, self.review)
        copied = self.root / "wink-expression-review.json"
        copied.write_bytes(copied.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "exact bound file"):
            validate_wink_review_binding(manifest, selection, self.root, self.review)


if __name__ == "__main__":
    unittest.main()
