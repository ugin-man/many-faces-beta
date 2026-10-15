import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from clean_core_selection_review import WinkExpressionReview


class WinkExpressionReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.digest = hashlib.sha256(b"unchanged image bytes").hexdigest()
        self.document = {
            "schemaVersion": 1, "documentKind": "clean-core-wink-expression-review",
            "mode": "confirmed-side-only", "candidateAuditSha256": "a" * 64,
            "recordsSha256": "b" * 64, "reviewer": "assistant-visual-review",
            "humanVerified": False, "reviewedOn": "2026-10-06",
            "reviews": [{"encodedSha256": self.digest, "decision": "confirmed", "side": "left",
                         "reason": "Original pixels show one closed and one open eye.",
                         "sourceCatalogId": "source", "sourceId": "image",
                         "evidence": {"imageSha256": self.digest, "pixelChangesApplied": False,
                                      "recordSha256": "c" * 64}}],
        }

    def write(self, document=None):
        target = self.root / "review.json"
        target.write_text(json.dumps(self.document if document is None else document, indent=2))
        return target

    def load(self, document=None):
        return WinkExpressionReview(self.write(document), "a" * 64, "b" * 64)

    def database(self):
        connection = sqlite3.connect(":memory:")
        connection.execute("CREATE TABLE records(source_catalog_id TEXT,source_id TEXT,encoded_sha256 TEXT,decision TEXT,record_sha256 TEXT)")
        connection.executemany("INSERT INTO records VALUES(?,?,?,?,?)", [
            ("source", "image", self.digest, "pass", "c" * 64),
            ("alias", "other-id", self.digest, "pass", "d" * 64),
            ("source", "unresolved", "e" * 64, "unresolved", "f" * 64),
        ])
        self.addCleanup(connection.close)
        return connection

    def test_exact_side_evidence_survives_aliases_without_rewriting_admission(self):
        review, connection = self.load(), self.database()
        original = connection.execute("SELECT * FROM records").fetchall()
        review.validate_audit_records(connection)
        self.assertEqual(review.side_for(self.digest), "left")
        self.assertIsNone(review.side_for("e" * 64))
        self.assertEqual(review.evidence_for(self.digest, "left"), {
            "schemaVersion": 1, "encodedSha256": self.digest, "side": "left", "reviewSha256": review.sha256,
        })
        with self.assertRaisesRegex(ValueError, "same-side"):
            review.evidence_for(self.digest, "right")
        self.assertEqual(connection.execute("SELECT * FROM records").fetchall(), original)

    def test_uncertain_and_nonmatching_images_remain_unlabeled(self):
        for decision in ("uncertain", "does-not-match"):
            document = copy.deepcopy(self.document)
            document["reviews"][0].update(decision=decision, side=None)
            review = self.load(document)
            self.assertIsNone(review.side_for(self.digest))
            self.assertEqual(review.stamp()["confirmedSides"], {"left": 0, "right": 0})
            with self.assertRaisesRegex(ValueError, "same-side"):
                review.evidence_for(self.digest, "left")

    def test_confirmation_does_not_override_unresolved_admission(self):
        document = copy.deepcopy(self.document)
        document["reviews"][0].update(encodedSha256="e" * 64, sourceId="unresolved",
                                     evidence={"imageSha256": "e" * 64, "recordSha256": "f" * 64})
        review, connection = self.load(document), self.database()
        review.validate_audit_records(connection)
        self.assertEqual(review.side_for("e" * 64), "left")
        self.assertEqual(connection.execute("SELECT decision FROM records WHERE source_id='unresolved'").fetchone()[0], "unresolved")
        self.assertNotIn("allSelectedPhotosHavePassingAdmission", review.stamp())

    def test_optional_record_hash_is_bound_to_the_declared_source_only(self):
        document = copy.deepcopy(self.document)
        document["reviews"][0]["evidence"]["recordSha256"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "exact audited source row"):
            self.load(document).validate_audit_records(self.database())
        document["reviews"][0].update(sourceCatalogId="alias", sourceId="other-id")
        self.load(document).validate_audit_records(self.database())
        del document["reviews"][0]["evidence"]["recordSha256"]
        self.load(document).validate_audit_records(self.database())

    def test_source_id_and_missing_image_cannot_be_substituted(self):
        document = copy.deepcopy(self.document)
        document["reviews"][0]["sourceId"] = "unresolved"
        with self.assertRaisesRegex(ValueError, "source ID does not match"):
            self.load(document).validate_audit_records(self.database())
        connection = self.database()
        connection.execute("DELETE FROM records WHERE encoded_sha256=?", (self.digest,))
        with self.assertRaisesRegex(ValueError, "absent from the completed audit"):
            self.load().validate_audit_records(connection)

    def test_invalid_bindings_and_false_reviewer_claims_are_rejected(self):
        for field, value in (("candidateAuditSha256", "f" * 64), ("recordsSha256", "f" * 64),
                             ("mode", "allow"), ("humanVerified", True), ("schemaVersion", True),
                             ("reviewer", "human"), ("reviewedOn", "2026-02-30")):
            document = copy.deepcopy(self.document)
            document[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.load(document)

    def test_invalid_or_contradictory_row_evidence_is_rejected(self):
        for patch in ({"side": "right|left"}, {"decision": "deny"}, {"reason": ""},
                      {"decision": "uncertain"}, {"encodedSha256": "bad"},
                      {"sourceId": None}, {"evidence": {"imageSha256": "d" * 64}},
                      {"evidence": {"pixelChangesApplied": True}},
                      {"evidence": {"recordSha256": "not-a-sha"}}):
            document = copy.deepcopy(self.document)
            document["reviews"][0].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.load(document)
        document = copy.deepcopy(self.document)
        document["reviews"][0].pop("sourceCatalogId")
        document["reviews"][0].pop("sourceId")
        with self.assertRaisesRegex(ValueError, "exact digest and source identity"):
            self.load(document)

    def test_duplicate_rows_and_duplicate_json_keys_are_rejected(self):
        document = copy.deepcopy(self.document)
        document["reviews"].append(copy.deepcopy(document["reviews"][0]))
        with self.assertRaisesRegex(ValueError, "Repeated image digest"):
            self.load(document)
        path = self.write()
        path.write_text(path.read_text().replace('"side": "left"', '"side": "right", "side": "left"'))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            WinkExpressionReview(path, "a" * 64, "b" * 64)

    def test_exact_review_bytes_and_counts_are_copied_to_catalog(self):
        review = self.load()
        target = self.root / "catalog"
        target.mkdir()
        review.write_catalog_files(target)
        review.verify_catalog_files(target)
        stamp = review.stamp()
        self.assertEqual(stamp["reviewedEncodedImages"], 1)
        self.assertEqual(stamp["confirmedEncodedImages"], 1)
        self.assertEqual(stamp["confirmedSides"], {"left": 1, "right": 0})
        self.assertFalse(stamp["humanVerified"])
        self.assertEqual(hashlib.sha256((target / stamp["reviewPath"]).read_bytes()).hexdigest(), review.sha256)
        (target / stamp["reviewPath"]).write_bytes(review.raw_bytes + b"\n")
        with self.assertRaisesRegex(ValueError, "exact bound file"):
            review.verify_catalog_files(target)


if __name__ == "__main__":
    unittest.main()
