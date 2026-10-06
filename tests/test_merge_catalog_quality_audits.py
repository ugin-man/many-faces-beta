import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from merge_catalog_quality_audits import (
    AuditIntegrityError, DEFAULT_MODEL_SHA256, merge_audits, partition_for_id,
)


class MergeCatalogQualityAuditsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog = root / "catalog"
        self.audits = root / "audits"
        (self.catalog / "shards").mkdir(parents=True)
        (self.catalog / "packs").mkdir()
        self.audits.mkdir()
        self.ids = {}
        entries = []
        offset = 0
        for part in range(4):
            found = []
            index = 0
            while len(found) < 2:
                image_id = f"image-{part}-{index}"
                if partition_for_id(image_id) == part:
                    found.append(image_id)
                index += 1
            self.ids[part] = found
            for image_id, yaw in zip(found, (12.0, -12.0)):
                entries.append({"id": image_id, "name": image_id, "pack": "faces.bin",
                                "offset": offset, "length": 4, "feature": [yaw / 90] + [0.] * 54})
                offset += 4
        for image_id, yaw in (("front-zero", 0), ("front-pos", 11.99999), ("front-neg", -11.99999)):
            entries.append({"id": image_id, "name": image_id, "pack": "faces.bin",
                            "offset": offset, "length": 4, "feature": [yaw / 90] + [0.] * 54})
            offset += 4
        self.entries = entries
        self.source_count = len(entries)
        self.write(self.catalog / "shards" / "faces.json", {"cell": "0:0", "items": entries})
        (self.catalog / "packs" / "faces.bin").write_bytes(b"face" * len(entries))
        self.write(self.catalog / "manifest.json", {
            "schemaVersion": 3, "featureLength": 55, "catalogId": "fixture-current",
            "totalFaces": len(entries), "sourceFaces": len(entries), "searchableFaces": len(entries),
            "cells": {"0:0": {"count": len(entries), "shards": ["faces.json"]}},
        })
        for part in range(4):
            rows = [{"id": image_id, "storedYaw": yaw, "freshYaw": yaw,
                     "name": image_id, "contradiction": False}
                    for image_id, yaw in zip(self.ids[part], (12., -12.))]
            if part == 0:
                rows[0].update(freshYaw=-8., contradiction=True)
            if part == 1:
                rows[0].update(freshYaw=None)
            if part == 2:
                rows[0].pop("freshYaw")
                rows[0].pop("contradiction")
                rows[0]["error"] = "Image decode failed"
            self.write(self.audits / f"yaw-{part}.json", {
                "samples": len(rows), "audit": rows,
                "contradictions": [row for row in rows if row.get("contradiction")],
            })
        candidate = {"id": self.ids[0][0], "reason": "face_mask", "mask": .999,
                     "sunglasses": .1, "yaw": 12., "name": self.ids[0][0]}
        self.write(self.audits / "occlusion.json", {
            "schemaVersion": 1, "catalogId": "fixture-current", "catalogFaces": len(entries),
            "model": "FaceAttribNet", "modelSha256": DEFAULT_MODEL_SHA256,
            "thresholdPolicy": {"hard": .985, "titleCorroborated": .94},
            "ordinaryEyeglassesAllowed": True, "facePaintNotExcludedByPolicy": True,
            "excluded": [candidate],
            "review90": [{key: value for key, value in candidate.items() if key not in ("reason", "yaw")},
                         {"id": self.ids[3][0], "mask": .93, "sunglasses": .2}],
        })

    def write(self, path, payload):
        path.write_text(json.dumps(payload), encoding="utf-8")

    def edit(self, name, change):
        path = self.audits / name
        payload = json.loads(path.read_text())
        change(payload)
        self.write(path, payload)

    def merge(self):
        return merge_audits(self.catalog, self.audits, expected_faces=self.source_count,
                            audit_source_commit="a" * 40, inspected_code_commit="b" * 40)

    def test_complete_membership_preserves_contradictions_unresolved_and_review_only(self):
        receipt = self.merge()
        self.assertEqual(8, receipt["yaw"]["auditedSidePoseImageCount"])
        self.assertEqual(1, receipt["yaw"]["contradictionCount"])
        self.assertEqual(2, receipt["yaw"]["unresolvedCount"])
        self.assertEqual(5, receipt["yaw"]["resolvedWithoutContradictionCount"])
        self.assertFalse(receipt["yaw"]["measurementsComplete"])
        self.assertEqual(2, receipt["occlusion"]["uniqueReviewCandidateCount"])
        self.assertTrue(all(row["reviewStatus"] == "unreviewed" for row in receipt["occlusion"]["candidates"]))
        self.assertFalse(receipt["admissionAllowlist"])
        self.assertFalse(receipt["completeCandidateCertification"])
        self.assertNotIn("excluded", receipt)
        self.assertNotIn("audit", receipt["yaw"])
        self.assertEqual(hashlib.sha256((self.catalog / "manifest.json").read_bytes()).hexdigest(),
                         receipt["source"]["manifestSha256"])
        self.assertEqual("a" * 40, receipt["auditSourceCommit"])
        self.assertEqual("b" * 40, receipt["inspectedCodeCommit"])

    def test_requires_four_partitions_before_occlusion_incorporation(self):
        (self.audits / "yaw-3.json").unlink()
        (self.audits / "occlusion.json").write_text("invalid")
        with self.assertRaisesRegex(AuditIntegrityError, "yaw-3.json"):
            self.merge()

    def test_rejects_sample_count_mismatch(self):
        self.edit("yaw-0.json", lambda p: p.update(samples=3))
        with self.assertRaisesRegex(AuditIntegrityError, "sample count mismatch"):
            self.merge()

    def test_explicitly_missing_artifact_references_are_not_filled_silently(self):
        with self.assertRaisesRegex(AuditIntegrityError, "four yaw artifact references"):
            merge_audits(self.catalog, self.audits, expected_faces=self.source_count,
                         audit_source_commit="a" * 40, inspected_code_commit="b" * 40,
                         yaw_artifacts={})

    def test_rejects_missing_source_id_even_when_sample_count_matches(self):
        self.edit("yaw-3.json", lambda p: (p["audit"].pop(), p.update(samples=1)))
        with self.assertRaisesRegex(AuditIntegrityError, "missing 1 expected IDs"):
            self.merge()

    def test_rejects_duplicate_rows(self):
        self.edit("yaw-3.json", lambda p: p["audit"].__setitem__(1, copy.deepcopy(p["audit"][0])))
        with self.assertRaisesRegex(AuditIntegrityError, "Duplicate yaw ID"):
            self.merge()

    def test_rejects_wrong_partition_unknown_and_frontal_ids(self):
        path = self.audits / "yaw-3.json"
        original = path.read_text()
        for image_id in (self.ids[0][1], "not-in-source", "front-pos", "front-neg"):
            with self.subTest(image_id=image_id):
                path.write_text(original)
                self.edit("yaw-3.json", lambda p: p["audit"][0].update(id=image_id))
                with self.assertRaisesRegex(AuditIntegrityError, "wrong-partition ID"):
                    self.merge()

    def test_rejects_stale_stored_yaw(self):
        self.edit("yaw-3.json", lambda p: p["audit"][0].update(storedYaw=13.))
        with self.assertRaisesRegex(AuditIntegrityError, "Stored yaw disagrees"):
            self.merge()

    def test_rejects_forged_or_omitted_contradiction_lists(self):
        path = self.audits / "yaw-0.json"
        original = path.read_text()
        for change in (lambda p: p.update(contradictions=[]),
                       lambda p: p["contradictions"][0].update(freshYaw=-9.),
                       lambda p: p["contradictions"].append(copy.deepcopy(p["contradictions"][0]))):
            with self.subTest(change=change):
                path.write_text(original)
                self.edit("yaw-0.json", change)
                with self.assertRaisesRegex(AuditIntegrityError, "contradiction"):
                    self.merge()

    def test_yaw_rule_boundaries_and_nonfinite_measurements(self):
        path = self.audits / "yaw-0.json"
        original = path.read_text()
        for fresh, flag in ((-7.999999, False), (-8., True), (0., False), (8., False)):
            with self.subTest(fresh=fresh):
                path.write_text(original)
                self.edit("yaw-0.json", lambda p: (p["audit"][0].update(freshYaw=fresh, contradiction=flag),
                                                    p.update(contradictions=[copy.deepcopy(p["audit"][0])] if flag else [])))
                self.assertEqual(int(flag), self.merge()["yaw"]["contradictionCount"])
        path.write_text(original)
        self.edit("yaw-0.json", lambda p: p["audit"][0].update(freshYaw=float("nan")))
        with self.assertRaisesRegex(AuditIntegrityError, "Non-finite"):
            self.merge()

    def test_rejects_null_measurement_claimed_as_pass_or_error_with_measurement(self):
        self.edit("yaw-1.json", lambda p: p["audit"][0].update(contradiction=True))
        with self.assertRaisesRegex(AuditIntegrityError, "Contradiction flag"):
            self.merge()
        self.edit("yaw-1.json", lambda p: p["audit"][0].update(contradiction=False))
        self.edit("yaw-2.json", lambda p: p["audit"][0].update(freshYaw=12.))
        with self.assertRaisesRegex(AuditIntegrityError, "Error row also claims"):
            self.merge()

    def test_occlusion_source_model_schema_and_policy_must_match(self):
        path = self.audits / "occlusion.json"
        original = path.read_text()
        for field, value in (("schemaVersion", 2), ("catalogId", "other"), ("catalogFaces", 70000),
                             ("modelSha256", "f" * 64), ("ordinaryEyeglassesAllowed", False),
                             ("facePaintNotExcludedByPolicy", False)):
            with self.subTest(field=field):
                path.write_text(original)
                self.edit("occlusion.json", lambda p: p.update({field: value}))
                with self.assertRaises(AuditIntegrityError):
                    self.merge()

    def test_rejects_duplicate_unknown_and_conflicting_occlusion_rows(self):
        path = self.audits / "occlusion.json"
        original = path.read_text()
        for change in (lambda p: p["excluded"].append(copy.deepcopy(p["excluded"][0])),
                       lambda p: p["review90"][1].update(id="unknown"),
                       lambda p: p["review90"][0].update(mask=.95),
                       lambda p: p["excluded"][0].update(reason="approved")):
            with self.subTest(change=change):
                path.write_text(original)
                self.edit("occlusion.json", change)
                with self.assertRaises(AuditIntegrityError):
                    self.merge()

    def test_source_integrity_rejects_duplicate_ids_and_bad_physical_ranges(self):
        path = self.catalog / "shards" / "faces.json"
        original = path.read_text()
        for field, value in (("id", self.entries[0]["id"]), ("offset", 0), ("length", 100000),
                             ("offset", -1), ("offset", True), ("pack", "../escape.bin")):
            with self.subTest(field=field, value=value):
                payload = json.loads(original)
                payload["items"][1][field] = value
                self.write(path, payload)
                with self.assertRaises(AuditIntegrityError):
                    self.merge()

    def test_source_counts_and_duplicate_json_keys_are_rejected(self):
        path = self.catalog / "manifest.json"
        original = path.read_text()
        payload = json.loads(original)
        payload["cells"]["0:0"]["count"] -= 1
        self.write(path, payload)
        with self.assertRaisesRegex(AuditIntegrityError, "cell count mismatch"):
            self.merge()
        path.write_text(original[:-1] + ', "catalogId": "duplicate"}')
        with self.assertRaisesRegex(AuditIntegrityError, "Duplicate JSON object key"):
            self.merge()


if __name__ == "__main__":
    unittest.main()
