import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import clean_core_admission as admission
from review_clean_core_selection import load_previously_inspected, sample_buckets, selected_candidates, TARGET_SAMPLES


class HoldoutInspectionIndexTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "inspected.json"
        self.document = {
            "schemaVersion": 1, "documentKind": "clean-core-previously-inspected-images",
            "reviewer": "assistant-visual-review", "humanVerified": False, "reviewedOn": "2026-10-06",
            "scope": "sampling-only", "images": [{"encodedSha256": "a" * 64, "samples": ["Q001", "mouthWide-010"]}],
        }

    def load(self, document=None):
        self.path.write_text(json.dumps(self.document if document is None else document))
        return load_previously_inspected(self.path)

    def test_optional_index_is_digest_based_and_sampling_only(self):
        self.assertEqual(load_previously_inspected(None), frozenset())
        self.assertEqual(self.load(), frozenset(("a" * 64,)))
        self.assertEqual(json.loads(self.path.read_text()), self.document)
        changed = copy.deepcopy(self.document)
        changed["scope"] = "admission-allow"
        with self.assertRaisesRegex(ValueError, "sampling-only"):
            self.load(changed)

    def test_duplicate_or_partial_image_identity_is_rejected(self):
        for images in ([{"encodedSha256": "short"}], [{"sourceId": "photo-1"}],
                       [{"encodedSha256": "a" * 64}, {"encodedSha256": "a" * 64}]):
            with self.subTest(images=images), self.assertRaises(ValueError):
                self.load({**self.document, "images": images})

    def test_new_mouth_challenges_preserve_the_total_holdout_quota(self):
        buckets = sample_buckets()
        quotas = {name: count for name, count, _, _ in buckets}
        self.assertEqual(sum(quotas.values()), TARGET_SAMPLES)
        self.assertEqual(TARGET_SAMPLES, 360)
        self.assertEqual((quotas["mouth-wide"], quotas["mouth-frown"]), (12, 12))
        self.assertEqual(quotas["random-control"], 120)

    def test_selected_population_excludes_seen_pixels_without_double_counting_controls(self):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute("CREATE TABLE records(source_key TEXT,decision TEXT,encoded_sha256 TEXT,record_sha256 TEXT,record_z BLOB)")
        entries = []
        for letter in "abc":
            digest, identity = letter * 64, "source-photo-" + letter
            key = admission.source_key("source", identity)
            measurements = {"feature": [0] * 55, "shape": "shape", "mesh": "mesh", "projection": "projection", "layout": [.5, .5, .7, .8]}
            record = {**measurements, "sourceKey": key, "sourceCatalogId": "source", "sourceId": identity,
                      "encodedSha256": digest, "decision": "pass", "policySha256": "d" * 64,
                      "checks": {name: "pass" for name in admission.REQUIRED_CHECKS},
                      "freshYaw": 0, "freshPitch": 0, "faceAttributes": [.8, .8, .5, .01, .01],
                      "fullAttributes": [.8, .8, .5, .01, .01], "byteLength": 1}
            raw = json.dumps(record).encode()
            connection.execute("INSERT INTO records VALUES(?,?,?,?,?)", (key, "pass", digest, hashlib.sha256(raw).hexdigest(), zlib.compress(raw)))
            entries.append({**measurements, "id": "selected-alias-" + letter, "admissionSha256": digest,
                            "admissionSourceCatalogId": "source", "admissionSourceId": identity,
                            "cleanProfile": "mouthWide", "cleanTier": "observed", "pack": "faces.bin", "offset": 0, "length": 1})
        receipt = {"recordsSha256": "e" * 64, "policySha256": "d" * 64}
        manifest = {"searchableFaces": 3, "totalFaces": 3,
                    "qualityAdmission": {"schemaVersion": 2, "status": "complete", "selectedCount": 3, **receipt}}
        with patch("review_clean_core_selection.admission.iter_catalog_entries", return_value=iter(entries)):
            eligible, population = selected_candidates(Path(self.directory.name), manifest, receipt, connection,
                                                        {"a" * 64: {"decision": "allow"}}, frozenset(("a" * 64, "b" * 64)))
        self.assertEqual([row["encodedSha256"] for row in eligible], ["c" * 64])
        self.assertEqual(population["excludedCalibrationReviewedImages"], 1)
        self.assertEqual(population["excludedPreviouslyInspectedImages"], 1)
        self.assertEqual(population["excludedReviewedImages"], 2)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM records WHERE decision='pass'").fetchone()[0], 3)


if __name__ == "__main__":
    unittest.main()
