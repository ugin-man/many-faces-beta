import copy
import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import clean_core_admission as admission
import export_clean_core_profile_diagnostics as diagnostics
import test_clean_core_admission as fixtures
import test_observed_wink_policy as wink_fixtures


class ProfileDiagnosticTests(unittest.TestCase):
    """Small protocol fixtures; no production model inference or photograph claims."""

    def setUp(self):
        from PIL import Image
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        (self.source / "shards").mkdir(parents=True)
        (self.source / "packs").mkdir()
        self.audit_root = self.root / "audit"
        self.audit_root.mkdir()
        self.attribute = self.root / "attribute.onnx"
        self.face = self.root / "face.task"
        self.attribute.write_bytes(b"unit fixture attribute model; never inferred")
        self.face.write_bytes(b"unit fixture face model; never inferred")
        self.review_path = self.root / "reviews.json"
        self.policy = admission.AdmissionPolicy()
        self.catalog_id = "ffhq-diagnostic-fixture"
        self.source_arguments = [f"current={self.source}"]
        definitions = (
            ("wide", {"mouthStretchLeft": .30, "mouthStretchRight": .30}, None),
            ("frown", {"mouthFrownLeft": .30, "mouthFrownRight": .30}, None),
            ("left", {"mouthSmileLeft": .50, "mouthSmileRight": .50}, "left"),
            ("right", {"mouthFrownLeft": .30, "mouthFrownRight": .30}, "right"),
            ("left-alias", {"mouthSmileLeft": .50, "mouthSmileRight": .50}, "left"),
            ("hand-denied", {"mouthStretchLeft": .80, "mouthStretchRight": .80}, "left"),
            ("cg-excluded", {"mouthStretchLeft": .99, "mouthStretchRight": .99}, None),
        )
        self.entries, self.records, self.payloads = [], [], {}
        packed, offset = [], 0
        for number, (identity, scores, side) in enumerate(definitions):
            if identity == "left-alias":
                payload = self.payloads["left"]
            else:
                image = Image.open(io.BytesIO(fixtures.picture())).convert("RGB")
                image.putpixel((20, 20), (number * 20, 100, 130))
                stream = io.BytesIO(); image.save(stream, "PNG"); payload = stream.getvalue()
            self.payloads[identity] = payload
            entry = {**fixtures.entry(identity), "pack": "faces.bin", "offset": offset, "length": len(payload),
                     "creator": "unit creator " + str(number), "license": "test metadata", "sourceUrl": "https://example.test/fixture"}
            if identity == "cg-excluded":
                entry["sourceKind"] = "computer-generated"
            packed.append(payload); offset += len(payload)
            self.entries.append(entry)
            if side:
                feature, points = wink_fixtures.eye_fixture(.60, .10, .08, .25) if side == "left" else wink_fixtures.eye_fixture(.10, .60, .25, .08)
            else:
                feature, points = wink_fixtures.eye_fixture(.10, .10, .25, .25)
            for key, value in scores.items():
                feature[diagnostics.isolated.FEATURE_INDEX[key]] = value
            detected = fixtures.result()
            for category in detected.face_blendshapes[0]:
                category.score = feature[diagnostics.isolated.FEATURE_INDEX[category.category_name]]
            review = None
            if identity == "hand-denied":
                digest = hashlib.sha256(payload).hexdigest()
                review = {"encodedSha256": digest, "decision": "deny", "reason": "Fixture hand-obstruction denial"}
                self.denied_digest, self.denied_review = digest, review
            engine = fixtures.fake_engine(detected=detected, reviews={review["encodedSha256"]: review} if review else {})
            engine.face_geometry = lambda landmarks, points=points: ([.5] * 20, [.2] * 30, points, [.5, .5, .6, .6])
            self.records.append(engine.evaluate(payload, entry, self.catalog_id, "current"))
        (self.source / "packs/faces.bin").write_bytes(b"".join(packed))
        (self.source / "shards/source.json").write_text(json.dumps({"cell": "0:0", "items": self.entries}))
        (self.source / "manifest.json").write_text(json.dumps({
            "schemaVersion": 3, "featureLength": 55, "catalogId": self.catalog_id, "totalFaces": len(self.entries),
            "searchableFaces": len(self.entries), "shardsContainGeometry": True, "indexFiles": [],
            "cells": {"0:0": {"count": len(self.entries), "shards": ["source.json"]}}}))
        self.review_path.write_text(json.dumps({"schemaVersion": 1, "reviews": [self.denied_review]}))
        self.controls_path = self.audit_root / "admission-controls.json"
        self.controls_path.write_text(json.dumps({"schemaVersion": 1, "reviews": {self.denied_digest: self.denied_review},
            "priorYawExclusions": {}, "reviewedFileSha256": admission.sha256_file(self.review_path)}))
        fingerprint = admission.fingerprint_catalog("current", self.source)
        self.metadata = {"schemaVersion": 2, "status": "complete", "policySha256": self.policy.sha256,
                         "analysisCodeSha256": admission.sha256_file(admission.__file__),
                         "models": {"attributeSha256": admission.sha256_file(self.attribute), "faceSha256": admission.sha256_file(self.face)},
                         "controlsSha256": admission.sha256_file(self.controls_path), "sources": [fingerprint]}
        self.database_path = self.audit_root / "records.sqlite"
        self.receipt_path = self.audit_root / "candidate-audit.json"
        self.rewrite_records()

    def tearDown(self):
        self.temporary.cleanup()

    def rewrite_records(self):
        self.database_path.unlink(missing_ok=True)
        connection = admission.create_records_database(self.database_path, self.metadata)
        for record in self.records:
            admission.insert_record(connection, record)
        connection.commit()
        summary = admission.database_summary(connection)
        connection.close()
        self.receipt = {**self.metadata, "policy": self.policy.document(), "workers": 1,
                        "controlsPath": self.controls_path.name, "recordsPath": self.database_path.name,
                        "recordsSha256": admission.sha256_file(self.database_path), **summary,
                        "partitions": [{"part": 0, "parts": 1, "status": "complete", "recordCount": len(self.records)}]}
        self.receipt_path.write_text(json.dumps(self.receipt))

    def export(self, name="output", *, all_observed_winks=False):
        return diagnostics.export_diagnostics(self.receipt_path, self.attribute, self.face,
                                              self.source_arguments, self.review_path, self.root / name,
                                              all_observed_winks=all_observed_winks)

    def add_left_candidates(self, count):
        from PIL import Image
        base_entry = next(row for row in self.entries if row["id"] == "left")
        base_record = next(row for row in self.records if row["sourceId"] == "left")
        pack_path = self.source / "packs/faces.bin"
        packed = pack_path.read_bytes()
        for number in range(count):
            identity = f"extra-left-{number:03d}"
            image = Image.open(io.BytesIO(self.payloads["left"])).convert("RGB")
            image.putpixel((21, 20), (number % 256, number // 256, 210))
            stream = io.BytesIO(); image.save(stream, "PNG"); payload = stream.getvalue()
            entry = {**copy.deepcopy(base_entry), "id": identity, "offset": len(packed), "length": len(payload)}
            record = {**copy.deepcopy(base_record), "sourceId": identity,
                      "sourceKey": admission.source_key(self.catalog_id, identity),
                      "encodedSha256": hashlib.sha256(payload).hexdigest(),
                      "byteLength": len(payload),
                      "sourceFeatureSha256": admission.feature_sha256(entry)}
            self.payloads[identity] = payload
            self.entries.append(entry); self.records.append(record); packed += payload
        pack_path.write_bytes(packed)
        (self.source / "shards/source.json").write_text(json.dumps({"cell": "0:0", "items": self.entries}))
        manifest_path = self.source / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["totalFaces"] = manifest["searchableFaces"] = len(self.entries)
        manifest["cells"]["0:0"]["count"] = len(self.entries)
        manifest_path.write_text(json.dumps(manifest))
        self.metadata["sources"] = [admission.fingerprint_catalog("current", self.source)]
        self.rewrite_records()

    def test_four_bounded_groups_preserve_original_records_and_images_without_inference(self):
        frozen = {path: admission.sha256_file(path) for path in
                  (self.database_path, self.receipt_path, self.controls_path, self.source / "packs/faces.bin")}
        with patch.object(admission, "AdmissionEngine", side_effect=AssertionError("Exporter must not infer")):
            summary = self.export()
        self.assertEqual(summary["status"], "complete")
        self.assertFalse(summary["modelInferencePerformed"])
        self.assertFalse(summary["selectionOrAdmissionChanged"])
        self.assertEqual(summary["visualReview"], "pending")
        self.assertEqual(summary["population"]["verifiedPassRecords"], 6)
        self.assertEqual(summary["population"]["counts"]["realPhotoPass"], {"sourceRows": 5, "uniqueEncodedImages": 4})
        self.assertEqual(summary["population"]["nonphotographicPassRowsNotClassified"], {"computer-generated": 1})
        self.assertEqual(len(summary["groups"]), 4)
        for group in summary["groups"]:
            directory = self.root / "output" / group["group"]
            self.assertLessEqual(group["payloadBytes"], diagnostics.MAX_GROUP_BYTES)
            index = json.loads((directory / "index.json").read_text())
            self.assertGreater(index["sampleCount"], 0)
            self.assertEqual(len({sample["encodedSha256"] for sample in index["samples"]}), index["sampleCount"])
            self.assertEqual(index["shortfall"], 48 - index["sampleCount"])
            for sample in index["samples"]:
                self.assertNotEqual(sample["encodedSha256"], self.denied_digest)
                self.assertNotEqual(sample["sourceId"], "cg-excluded")
                raw = (directory / sample["recordPath"]).read_bytes()
                record = next(row for row in self.records if row["sourceKey"] == sample["sourceKey"])
                self.assertEqual(raw, admission.json_bytes(record))
                self.assertEqual(hashlib.sha256(raw).hexdigest(), sample["recordSha256"])
                self.assertEqual((directory / sample["imagePath"]).read_bytes(), self.payloads[sample["sourceId"]])
                original = json.loads((directory / sample["sourceRecordPath"]).read_text())
                self.assertEqual(original, next(row for row in self.entries if row["id"] == sample["sourceId"]))
        self.assertEqual({path: admission.sha256_file(path) for path in frozen}, frozen)

    def test_observed_counts_and_original_assignments_are_separate_and_raw_features_stay_exact(self):
        summary = self.export()
        self.assertEqual(summary["automaticWinkCandidates"]["wink-left"], {"sourceRows": 2, "uniqueEncodedImages": 1})
        index = json.loads((self.root / "output/wink-left/index.json").read_text())
        sample = next(row for row in index["samples"] if row["observedWinkEvidence"] and row["observedWinkEvidence"]["side"] == "left")
        if sample["currentAssignment"] and sample["currentAssignment"]["tier"] == "observed":
            self.assertEqual(sample["currentAssignment"]["purity"], 0)
            self.assertEqual(sample["currentAssignment"]["selectionPolicyVersion"], diagnostics.current.POLICY_VERSION)
        old = sample["originalIsolatedBackgroundAssignment"]
        self.assertTrue(old is None or old["tier"] != "observed")
        raw = json.loads((self.root / "output/wink-left" / sample["recordPath"]).read_text())
        expected = next(record for record in self.records if record["sourceKey"] == sample["sourceKey"])
        self.assertEqual(raw["feature"], expected["feature"])
        self.assertEqual(raw["projection"], expected["projection"])

    def test_all_automatic_winks_are_exported_with_every_exact_source_alias(self):
        frozen = {path: admission.sha256_file(path) for path in (self.database_path, self.receipt_path, self.controls_path)}
        with patch.object(admission, "AdmissionEngine", side_effect=AssertionError("No new inference")):
            summary = self.export(all_observed_winks=True)
        self.assertEqual(summary["diagnosticFocus"], "all-observed-winks")
        self.assertEqual(set(summary["exhaustiveAutomaticWinks"]), {"wink-left", "wink-right"})
        self.assertFalse(summary["expressionReviewApplied"])
        self.assertFalse(summary["laterSelectionDenialsApplied"])
        self.assertEqual(len(summary["groups"]), 2)
        samples = {}
        for page in summary["groups"]:
            directory = self.root / "output" / page["directory"]
            index = json.loads((directory / "index.json").read_text())
            for sample in index["samples"]:
                samples[sample["sample"]] = sample
                self.assertFalse(sample["expressionConfirmed"])
                self.assertEqual((directory / sample["imagePath"]).read_bytes(), self.payloads[sample["sourceId"]])
                for alias in sample["sourceAliases"]:
                    original = next(row for row in self.records if row["sourceKey"] == alias["sourceKey"])
                    self.assertEqual((directory / alias["recordPath"]).read_bytes(), admission.json_bytes(original))
                    self.assertEqual(json.loads((directory / alias["sourceRecordPath"]).read_text()),
                                     next(row for row in self.entries if row["id"] == alias["sourceId"]))
        self.assertEqual(set(samples), {"WLA001", "WRA001"})
        self.assertEqual(len(samples["WLA001"]["sourceAliases"]), 2)
        self.assertEqual(summary["exhaustiveAutomaticWinks"]["wink-left"]["exportedSourceRows"], 2)
        self.assertEqual({path: admission.sha256_file(path) for path in frozen}, frozen)

    def test_exhaustive_membership_does_not_depend_on_current_selection_assignment(self):
        with patch.object(diagnostics.current, "classify_assignment", return_value=None):
            summary = self.export(all_observed_winks=True)
        self.assertEqual(summary["exhaustiveAutomaticWinks"]["wink-left"]["exportedUniqueEncodedImages"], 1)
        self.assertEqual(summary["exhaustiveAutomaticWinks"]["wink-right"]["exportedUniqueEncodedImages"], 1)

    def test_exhaustive_scan_ignores_heap_caps_and_keeps_stable_ids_across_pages(self):
        self.add_left_candidates(50)
        with patch.object(diagnostics, "POOL_PER_BUCKET", 1):
            first = self.export("all-first", all_observed_winks=True)
            second = self.export("all-second", all_observed_winks=True)
        self.assertEqual(first["exhaustiveAutomaticWinks"]["wink-left"]["exportedUniqueEncodedImages"], 51)
        self.assertEqual(first["exhaustiveAutomaticWinks"]["wink-left"]["contactPages"], 2)
        self.assertEqual(first["groups"], second["groups"])
        self.assertTrue(all(page["sampleCount"] <= 48 for page in first["groups"]))
        self.assertFalse((self.root / "all-first/pages").exists())
        for part in first["artifactParts"]:
            self.assertLessEqual(part["payloadBytes"], diagnostics.MAX_GROUP_BYTES)
            files = [path for path in (self.root / "all-first" / part["directory"]).rglob("*") if path.is_file()]
            self.assertEqual(len(files), part["fileCount"])

    def test_oversized_contact_page_is_split_without_omitting_originals(self):
        self.add_left_candidates(4)
        with patch.object(diagnostics, "MAX_ARTIFACT_FILES", 10):
            summary = self.export(all_observed_winks=True)
        self.assertEqual(summary["exhaustiveAutomaticWinks"]["wink-left"]["exportedUniqueEncodedImages"], 5)
        self.assertGreater(summary["exhaustiveAutomaticWinks"]["wink-left"]["contactPages"], 1)
        self.assertTrue(all(part["fileCount"] <= 10 for part in summary["artifactParts"]))
        self.assertEqual(sum(page["sampleCount"] for page in summary["groups"]), 6)

    def test_single_image_or_total_artifact_overflow_fails_without_downsampling(self):
        with patch.object(diagnostics, "MAX_GROUP_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "single exact-image"):
                self.export("single-overflow", all_observed_winks=True)
        self.add_left_candidates(4)
        with patch.object(diagnostics, "MAX_ARTIFACT_FILES", 10), patch.object(diagnostics, "MAX_ARTIFACT_PARTS", 1):
            with self.assertRaisesRegex(ValueError, "no candidates may be omitted"):
                self.export("parts-overflow", all_observed_winks=True)

    def test_manually_denied_pass_row_fails_even_with_consistent_receipt_and_database_hash(self):
        record = next(row for row in self.records if row["sourceId"] == "hand-denied")
        record["decision"] = "pass"
        record["checks"]["visibility"] = "pass"
        self.rewrite_records()
        with self.assertRaisesRegex(ValueError, "manually denied"):
            self.export()

    def test_corrupt_raw_record_fails_even_if_outer_database_hash_is_rebound(self):
        connection = sqlite3.connect(self.database_path)
        connection.execute("UPDATE records SET record_z=? WHERE source_id='wide'", (zlib.compress(b'{}'),))
        connection.commit(); connection.close()
        self.receipt["recordsSha256"] = admission.sha256_file(self.database_path)
        self.receipt_path.write_text(json.dumps(self.receipt))
        with self.assertRaisesRegex(ValueError, "record hash"):
            self.export()

    def test_changed_models_reviews_database_and_source_images_fail_closed(self):
        for target, error in ((self.face, "face-model"), (self.review_path, "manual visibility"),
                              (self.database_path, "database hash"), (self.source / "packs/faces.bin", "image bytes")):
            with self.subTest(target=target.name):
                before = target.read_bytes()
                target.write_bytes(b"X" + before[1:] if target.name == "faces.bin" else before + b"\n")
                try:
                    with self.assertRaisesRegex(ValueError, error):
                        self.export("failure-" + target.name)
                finally:
                    target.write_bytes(before)

    def test_existing_outputs_frozen_input_paths_and_payload_overflow_are_rejected(self):
        output = self.root / "existing"
        output.mkdir(); (output / "keep.txt").write_text("keep")
        with self.assertRaisesRegex(ValueError, "nothing is overwritten"):
            self.export("existing")
        with self.assertRaisesRegex(ValueError, "inside frozen audit"):
            self.export("audit/diagnostics")
        with self.assertRaisesRegex(ValueError, "inside a source"):
            self.export("source/diagnostics")
        with patch.object(diagnostics, "MAX_GROUP_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "24 MiB"):
                self.export("overflow")

    def test_stratified_sampling_is_deterministic_and_does_not_change_acceptance(self):
        with admission.AdmissionAudit(self.receipt_path, self.attribute, self.source_arguments) as audit:
            indexed = diagnostics.source_index(audit)
            pools, _ = diagnostics.scan_pool(audit, indexed)
            first = {group: pools.choose(group, 48) for group in diagnostics.GROUPS}
            second = {group: pools.choose(group, 48) for group in diagnostics.GROUPS}
        self.assertEqual(first, second)
        feature = [0.0] * diagnostics.isolated.FEATURE_LENGTH
        feature[diagnostics.isolated.FEATURE_INDEX["mouthFrownLeft"]] = .18
        feature[diagnostics.isolated.FEATURE_INDEX["mouthFrownRight"]] = .18
        metrics = diagnostics.isolated.metrics_from_feature(feature)
        evidence = diagnostics.mouth_diagnostics(metrics)
        self.assertTrue(evidence["mouthFrownPredicate"])
        self.assertLess(evidence["mouthFrownPurityIfEligible"], evidence["minimumStrictPurity"])
        self.assertIsNone(diagnostics.isolated.classify_clean_profile(feature))


if __name__ == "__main__":
    unittest.main()
