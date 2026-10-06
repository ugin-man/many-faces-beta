import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from clean_core_selection_review import SelectionReview


class SelectionReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.payload = b"exact original image bytes"
        self.image_sha = hashlib.sha256(self.payload).hexdigest()
        self.document = {
            "schemaVersion": 1, "documentKind": "clean-core-selection-visibility-review",
            "candidateAuditSha256": "a" * 64, "recordsSha256": "b" * 64,
            "reviewer": "assistant-visual-review", "humanVerified": False,
            "reviewedOn": "2026-10-06", "mode": "deny-only", "previousReviewSha256": None,
            "reviews": [{"encodedSha256": self.image_sha, "decision": "deny", "reason": "Mouth obscured",
                         "sourceCatalogId": "original-source", "sourceId": "photo-1"}],
        }

    def write(self, document=None, filename="review.json"):
        path = self.root / filename
        path.write_text(json.dumps(self.document if document is None else document, indent=2))
        return path

    def load(self, document=None, previous=None):
        return SelectionReview(self.write(document), "a" * 64, "b" * 64, previous)

    def database(self):
        connection = sqlite3.connect(":memory:")
        connection.execute("CREATE TABLE records(source_catalog_id TEXT,source_id TEXT,encoded_sha256 TEXT,decision TEXT)")
        connection.executemany("INSERT INTO records VALUES(?,?,?,?)", [
            ("original-source", "photo-1", self.image_sha, "pass"),
            ("alias-source", "renamed-image", self.image_sha, "pass"),
            ("original-source", "unknown-visibility", "c" * 64, "unresolved"),
        ])
        self.addCleanup(connection.close)
        return connection

    def test_exact_digest_excludes_all_aliases_without_rewriting_admission(self):
        review, connection = self.load(), self.database()
        before = connection.execute("SELECT * FROM records").fetchall()
        review.validate_audit_records(connection)
        self.assertTrue(review.excludes(self.image_sha))
        with self.assertRaisesRegex(ValueError, "reviewed excluded image"):
            review.require_payload(self.payload)
        self.assertEqual(connection.execute("SELECT * FROM records").fetchall(), before)
        self.assertFalse(review.excludes("c" * 64))  # This is still an unresolved admission row.
        self.assertEqual(connection.execute("SELECT decision FROM records WHERE encoded_sha256=?", ("c" * 64,)).fetchone()[0], "unresolved")

    def test_no_allow_or_ambiguous_decision_can_enter_review(self):
        for decision in ("allow", "pass", "unresolved", None):
            document = copy.deepcopy(self.document)
            document["reviews"][0]["decision"] = decision
            with self.subTest(decision=decision), self.assertRaisesRegex(ValueError, "cannot admit"):
                self.load(document)

    def test_wrong_audit_or_database_is_rejected(self):
        for field in ("candidateAuditSha256", "recordsSha256"):
            document = copy.deepcopy(self.document)
            document[field] = "f" * 64
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "bound to another"):
                self.load(document)

    def test_duplicate_json_keys_and_duplicate_image_ids_are_rejected(self):
        path = self.write()
        path.write_text(path.read_text().replace('"mode": "deny-only"', '"mode": "allow", "mode": "deny-only"'))
        with self.assertRaisesRegex(ValueError, "Duplicate selection review JSON key"):
            SelectionReview(path, "a" * 64, "b" * 64)
        document = copy.deepcopy(self.document)
        document["reviews"].append(copy.deepcopy(document["reviews"][0]))
        with self.assertRaisesRegex(ValueError, "Repeated image digest"):
            self.load(document)

    def test_denial_must_have_original_image_evidence_identity(self):
        for extra in ({"encodedSha256": "bad-id"}, {"reason": "  "}, {"sourceId": None},
                      {"evidence": {"imageSha256": "c" * 64}}, {"evidence": {"pixelChangesApplied": True}}):
            document = copy.deepcopy(self.document)
            document["reviews"][0].update(extra)
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.load(document)

    def test_source_evidence_is_bound_to_audited_pixels(self):
        document = copy.deepcopy(self.document)
        document["reviews"][0]["sourceId"] = "unknown-visibility"
        with self.assertRaisesRegex(ValueError, "source ID does not match"):
            self.load(document).validate_audit_records(self.database())
        document["reviews"][0]["encodedSha256"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "absent from the completed audit"):
            self.load(document).validate_audit_records(self.database())

    def test_monotonic_revision_requires_exact_predecessor_and_keeps_all_denials(self):
        old = self.write(filename="previous.json")
        document = copy.deepcopy(self.document)
        document["previousReviewSha256"] = hashlib.sha256(old.read_bytes()).hexdigest()
        document["reviews"].append({"encodedSha256": "c" * 64, "decision": "deny", "reason": "Additional original reviewed"})
        review = self.load(document, old)
        self.assertEqual(review.denied, frozenset((self.image_sha, "c" * 64)))
        with self.assertRaisesRegex(ValueError, "exact previous selection review is required"):
            self.load(document)
        document["reviews"] = document["reviews"][1:]
        with self.assertRaisesRegex(ValueError, "may only add exclusions"):
            self.load(document, old)

    def test_wrong_predecessor_cannot_be_substituted(self):
        old = self.write(filename="previous.json")
        document = copy.deepcopy(self.document)
        document["previousReviewSha256"] = hashlib.sha256(old.read_bytes()).hexdigest()
        old.write_text(old.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "Previous selection review digest mismatch"):
            self.load(document, old)

    def test_catalog_contains_exact_review_bytes_and_no_unbound_predecessor(self):
        review = self.load()
        catalog = self.root / "catalog"
        catalog.mkdir()
        review.write_catalog_files(catalog)
        review.verify_catalog_files(catalog)
        stamp = review.stamp()
        self.assertEqual(stamp["reviewSha256"], hashlib.sha256((catalog / "selection-review.json").read_bytes()).hexdigest())
        self.assertEqual(stamp["excludedEncodedImages"], 1)
        self.assertFalse(stamp["humanVerified"])
        (catalog / "selection-review.json").write_bytes(review.raw_bytes + b"\n")
        with self.assertRaisesRegex(ValueError, "differs from the bound review"):
            review.verify_catalog_files(catalog)
        review.write_catalog_files(catalog)
        (catalog / "selection-review-previous.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "Unbound predecessor"):
            review.verify_catalog_files(catalog)

    def test_empty_review_is_explicit_and_does_not_claim_admission(self):
        document = copy.deepcopy(self.document)
        document["reviews"] = []
        review = self.load(document)
        self.assertFalse(review.excludes(self.image_sha))
        self.assertEqual(review.stamp()["excludedEncodedImages"], 0)
        self.assertNotIn("allSelectedPhotosHavePassingAdmission", review.stamp())


if __name__ == "__main__":
    unittest.main()
