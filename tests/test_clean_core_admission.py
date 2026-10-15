import base64
import hashlib
import io
import json
import math
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import clean_core_admission as admission
import audit_clean_core_candidates as runner


def picture(flat=False):
    from PIL import Image, ImageDraw
    image = Image.new("RGB", (256, 256), (125, 125, 125))
    if not flat:
        draw = ImageDraw.Draw(image)
        for y in range(0, 256, 8):
            for x in range(0, 256, 8):
                if (x + y) % 16:
                    draw.rectangle((x, y, x + 7, y + 7), fill=(60, 90, 150))
                else:
                    draw.rectangle((x, y, x + 7, y + 7), fill=(190, 160, 100))
    stream = io.BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def result(yaw=0, face_count=1, matrix=None):
    angle = math.radians(yaw)
    if matrix is None:
        matrix = [math.cos(angle), 0, math.sin(angle), 0,
                  0, 1, 0, 0, -math.sin(angle), 0, math.cos(angle), 0, 0, 0, 0, 1]
    points = [SimpleNamespace(x=.5, y=.5, z=0.0) for _ in range(478)]
    scores = [SimpleNamespace(category_name=key, score=0.0) for key in admission.BLEND_KEYS]
    return SimpleNamespace(face_landmarks=[points for _ in range(face_count)],
                           face_blendshapes=[scores], facial_transformation_matrixes=[matrix])


def fake_engine(scores=None, detected=None, reviews=None, prior=None):
    engine = admission.AdmissionEngine.__new__(admission.AdmissionEngine)
    engine.policy = admission.AdmissionPolicy()
    engine.reviews = reviews or {}
    engine.prior_exclusions = prior or {}
    engine.detect = lambda image: detected if detected is not None else result()
    engine.attributes = lambda image: scores or [1.0, 1.0, .999, .01, .01]
    engine.face_geometry = lambda points: ([.5] * 20, [.2] * 30, [0.0] * 936, [.5, .5, .6, .6])
    return engine


def entry(identity="one", stored_yaw=0):
    feature = [0.0] * admission.FEATURE_LENGTH
    feature[0] = stored_yaw / 90
    return {"id": identity, "name": "Face painting with clear eyeglasses, DSCN9586", "feature": feature}


class AdmissionDecisionTests(unittest.TestCase):
    def test_clear_glasses_and_closed_eyes_are_not_vetoes(self):
        policy = admission.AdmissionPolicy()
        self.assertEqual("pass", admission.visibility_decision([0, 0, 1, .01, .01], policy)[0])
        record = fake_engine().evaluate(picture(), entry(), "ffhq-test", "ffhq")
        self.assertEqual("pass", record["decision"])
        self.assertTrue(all(record["checks"][name] == "pass" for name in admission.REQUIRED_CHECKS))
        self.assertEqual(55, len(record["feature"]))
        self.assertEqual(936 * 2, len(base64.b64decode(record["projection"])))

    def test_boundary_is_unresolved_not_a_factual_occlusion(self):
        policy = admission.AdmissionPolicy()
        self.assertEqual(.05, policy.visibility_max_score)
        self.assertEqual("pass", admission.visibility_decision([1, 1, 0, .049, .049], policy)[0])
        self.assertEqual(("unresolved", "visibility_unresolved"), admission.visibility_decision([1, 1, 0, .05, 0], policy))
        self.assertEqual(("unresolved", "visibility_unresolved"), admission.visibility_decision([1, 1, 0, 0, .999], policy))
        for invalid in ([0, 0], [0, 0, 0, float("nan"), 0], [0, 0, 0, 1.01, 0]):
            with self.assertRaises(ValueError):
                admission.validate_attribute_scores(invalid)

    def test_review_allow_cannot_override_bad_pose_or_detail(self):
        payload = picture()
        digest = hashlib.sha256(payload).hexdigest()
        review = {digest: {"encodedSha256": digest, "decision": "allow", "reason": "Visible clear lenses"}}
        approved = fake_engine(scores=[1, 1, 1, .99, .99], reviews=review).evaluate(payload, entry(), "ffhq-test", "ffhq")
        self.assertEqual("pass", approved["decision"])
        opposed = fake_engine(scores=[1, 1, 1, .99, .99], detected=result(30), reviews=review).evaluate(payload, entry(stored_yaw=-30), "ffhq-test", "ffhq")
        self.assertEqual("reject", opposed["decision"])
        self.assertEqual(["yaw_contradiction"], opposed["reasons"])
        flat = picture(flat=True)
        flat_digest = hashlib.sha256(flat).hexdigest()
        bad_detail = fake_engine(reviews={flat_digest: {"decision": "allow", "reason": "review"}}).evaluate(flat, entry(), "ffhq-test", "ffhq")
        self.assertEqual("reject", bad_detail["decision"])
        self.assertEqual(["image_quality_blur"], bad_detail["reasons"])

    def test_prior_yaw_rejection_survives_id_changes(self):
        payload = picture()
        digest = hashlib.sha256(payload).hexdigest()
        engine = fake_engine(prior={digest: {"reason": "prior_yaw_contradiction"}},
                             reviews={digest: {"decision": "allow", "reason": "review"}})
        for identity, catalog in (("original", "old"), ("renamed-original", "replacement")):
            record = engine.evaluate(payload, entry(identity), catalog)
            self.assertEqual("reject", record["decision"])
            self.assertEqual(["prior_yaw_contradiction"], record["reasons"])

    def test_missing_or_nonfinite_transform_never_becomes_zero_pose_pass(self):
        payload = picture()
        for matrix in ([0] * 11, [float("nan")] + [0] * 15):
            record = fake_engine(detected=result(matrix=matrix)).evaluate(payload, entry(), "ffhq-test", "ffhq")
            self.assertEqual("unresolved", record["decision"])
            self.assertIsNone(record["freshYaw"])
        record = fake_engine(detected=result(face_count=0)).evaluate(payload, entry(), "ffhq-test", "ffhq")
        self.assertEqual("unresolved", record["decision"])
        self.assertIsNone(record["freshYaw"])

    def test_existing_clamped_cell_semantics_are_preserved(self):
        record = fake_engine(detected=result(60)).evaluate(picture(), entry(), "ffhq-test", "ffhq")
        self.assertEqual("pass", record["decision"])
        self.assertAlmostEqual(60, record["freshYaw"])
        self.assertEqual("45:0", record["cell"])
        self.assertEqual((14, 14, 86, 86), admission.tight_crop_rect([.5, .5, .6, .6], 100, 100))

    def test_reviews_require_exact_hash_and_conflicts_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "reviews.json"
            path.write_text(json.dumps({"schemaVersion": 1, "reviews": [{"id": "unbound", "decision": "allow", "reason": "test"}]}))
            with self.assertRaises(ValueError):
                admission.load_visibility_reviews(path)
            digest = "a" * 64
            path.write_text(json.dumps({"schemaVersion": 1, "reviews": [
                {"encodedSha256": digest, "decision": decision, "reason": "test"} for decision in ("allow", "deny")]}))
            with self.assertRaises(ValueError):
                admission.load_visibility_reviews(path)


class AdmissionReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.catalog = self.root / "source"
        (self.catalog / "shards").mkdir(parents=True)
        (self.catalog / "packs").mkdir()
        self.payload = picture()
        (self.catalog / "packs" / "faces.bin").write_bytes(self.payload * 2)
        self.entries = [{**entry(identity), "pack": "faces.bin", "offset": index * len(self.payload), "length": len(self.payload)}
                        for index, identity in enumerate(("one", "two"))]
        self.shard_path = self.catalog / "shards" / "source.json"
        self.shard_path.write_text(json.dumps({"cell": "0:0", "items": self.entries}))
        # The 125 old unindexed FFHQ rows are analogous to this total/searchable difference.
        manifest = {"schemaVersion": 3, "featureLength": 55, "catalogId": "ffhq-test", "totalFaces": 5,
                    "searchableFaces": 2, "shardsContainGeometry": True, "indexFiles": [],
                    "cells": {"0:0": {"count": 2, "shards": ["source.json"]}}}
        (self.catalog / "manifest.json").write_text(json.dumps(manifest))
        self.model_path = self.root / "model.onnx"
        self.model_path.write_bytes(b"model fixture, no inference")
        self.fingerprint = admission.fingerprint_catalog("ffhq", self.catalog)
        self.sources = [("ffhq", self.catalog)]
        self.out = self.root / "audit"
        self.out.mkdir()
        self.controls_path = self.out / "admission-controls.json"
        self.controls_path.write_text(json.dumps({"schemaVersion": 1, "reviews": {}, "priorYawExclusions": {}}))
        self.policy = admission.AdmissionPolicy()
        self.metadata = {"schemaVersion": 2, "status": "complete", "policySha256": self.policy.sha256,
                         "analysisCodeSha256": admission.sha256_file(admission.__file__),
                         "models": {"attributeSha256": admission.sha256_file(self.model_path), "faceSha256": "a" * 64},
                         "controlsSha256": admission.sha256_file(self.controls_path), "sources": [self.fingerprint]}
        self.database_path = self.out / "records.sqlite"
        connection = admission.create_records_database(self.database_path, self.metadata)
        for item in self.entries:
            record = fake_engine().evaluate(self.payload, item, "ffhq-test", "ffhq")
            admission.insert_record(connection, record)
        connection.commit()
        summary = admission.database_summary(connection)
        connection.close()
        self.receipt = {**self.metadata, "policy": self.policy.document(), "workers": 1,
                        "sources": [self.fingerprint], "controlsPath": self.controls_path.name,
                        "partitions": [{"part": 0, "parts": 1, "status": "complete", "recordCount": 2}],
                        **summary, "recordsPath": self.database_path.name, "recordsSha256": admission.sha256_file(self.database_path)}
        self.receipt_path = self.out / "candidate-audit.json"
        self.write_receipt()

    def tearDown(self):
        self.temporary.cleanup()

    def write_receipt(self):
        self.receipt_path.write_text(json.dumps(self.receipt))

    def test_valid_audit_returns_fresh_geometry_and_uses_searchable_count(self):
        self.assertEqual(2, self.fingerprint["expectedRows"])
        with admission.AdmissionAudit(self.receipt_path, self.model_path, self.sources) as audit:
            record = audit.record("ffhq-test", self.entries[0])
            self.assertEqual("pass", record["decision"])
            self.assertEqual(self.payload, audit.readers["ffhq-test"].read(self.entries[0]))
            with self.assertRaises(ValueError):
                audit.record("ffhq-test", entry("unknown"))

    def test_changed_source_feature_and_changed_bytes_are_detected(self):
        with admission.AdmissionAudit(self.receipt_path, self.model_path, self.sources) as audit:
            changed = {**self.entries[0], "feature": [0.1] + [0.0] * 54}
            with self.assertRaises(ValueError):
                audit.record("ffhq-test", changed)
            with self.assertRaises(ValueError):
                audit.record("ffhq-test", self.entries[0], b"altered bytes")

    def test_altered_shard_or_database_is_rejected(self):
        self.shard_path.write_text(self.shard_path.read_text() + "\n")
        with self.assertRaises(ValueError):
            admission.AdmissionAudit(self.receipt_path, self.model_path, self.sources)
        self.shard_path.write_text(self.shard_path.read_text()[:-1])
        with self.database_path.open("ab") as handle:
            handle.write(b"changed")
        with self.assertRaises(ValueError):
            admission.AdmissionAudit(self.receipt_path, self.model_path, self.sources)

    def test_missing_id_is_detected_even_when_count_and_database_hash_match(self):
        connection = sqlite3.connect(self.database_path)
        connection.execute("UPDATE records SET source_key=?,source_id=? WHERE source_id='two'", (admission.source_key("ffhq-test", "other"), "other"))
        connection.commit()
        connection.close()
        self.receipt["recordsSha256"] = admission.sha256_file(self.database_path)
        self.write_receipt()
        with self.assertRaisesRegex(ValueError, "source-key coverage"):
            admission.AdmissionAudit(self.receipt_path, self.model_path, self.sources)

    def test_empty_or_incomplete_receipts_cannot_certify_candidates(self):
        for receipt in ({}, {"schemaVersion": 2, "status": "running"}):
            self.receipt_path.write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):
                admission.AdmissionAudit(self.receipt_path, self.model_path, self.sources)

    def test_duplicate_partitions_fail_before_any_merge(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            runner.merge_partitions(self.root / "unused", {"workers": 2}, [{"part": 0}, {"part": 0}])

    def test_streamed_partition_merge_roundtrip_without_models(self):
        output = self.root / "merged"
        output.mkdir()
        controls = output / self.controls_path.name
        controls.write_bytes(self.controls_path.read_bytes())
        config_metadata = {key: value for key, value in self.metadata.items() if key != "status"}
        config = {"workers": 1, "metadata": config_metadata,
                  "sources": admission.normalize_sources(self.sources), "fingerprints": [self.fingerprint]}
        part_path = output / "partition-00.sqlite"
        part = admission.create_records_database(part_path, {**config_metadata, "status": "complete", "part": 0, "parts": 1})
        original = admission.readonly_database(self.database_path)
        part.executemany("INSERT INTO records VALUES (?,?,?,?,?,?,?,?)", original.execute("SELECT * FROM records"))
        original.close()
        part.commit()
        summary = admission.database_summary(part)
        part.close()
        partitions = [{"part": 0, "parts": 1, "status": "complete", **summary,
                       "runtimeVersions": {"test": "no-model-inference"}, "path": part_path.name,
                       "sha256": admission.sha256_file(part_path)}]
        merged = runner.merge_partitions(output, config, partitions)
        receipt = {**self.receipt, **merged, "partitions": partitions}
        receipt_path = output / "candidate-audit.json"
        receipt_path.write_text(json.dumps(receipt))
        with admission.AdmissionAudit(receipt_path, self.model_path, self.sources) as audit:
            self.assertEqual("pass", audit.record("ffhq-test", self.entries[1])["decision"])

    def test_distributed_parts_are_independent_of_worker_count(self):
        required = ["--catalog", "ffhq=" + str(self.catalog), "--out", str(self.out),
                    "--face-attribute-model", str(self.model_path), "--face-model", str(self.model_path),
                    "--reviewed-visibility", str(self.controls_path), "--prior-yaw-evidence", str(self.controls_path)]
        parsed = runner.parse_arguments(required + ["--part", "15", "--parts", "16", "--workers", "1"])
        self.assertEqual((15, 16, 1, .05), (parsed.part, parsed.parts, parsed.workers, parsed.visibility_max_score))
        self.assertEqual(16, runner.partition_count({"parts": 16, "workers": 1}))
        parsed_merge = runner.parse_arguments(required + ["--merge-only", "--parts", "16", "--workers", "1"])
        self.assertTrue(parsed_merge.merge_only)
        self.assertIsNone(parsed_merge.part)

    def test_distributed_merge_requires_every_partition_and_consistent_configuration(self):
        output = self.root / "distributed"
        output.mkdir()
        controls = output / self.controls_path.name
        controls.write_bytes(self.controls_path.read_bytes())
        metadata = {key: value for key, value in self.metadata.items() if key != "status"}
        config = {"workers": 1, "parts": 16, "metadata": metadata,
                  "sources": admission.normalize_sources(self.sources), "fingerprints": [self.fingerprint]}
        original = admission.readonly_database(self.database_path)
        rows = list(original.execute("SELECT * FROM records"))
        original.close()
        partitions = []
        for index in range(16):
            path = output / f"partition-{index:02d}.sqlite"
            connection = admission.create_records_database(path, {**metadata, "status": "complete", "part": index, "parts": 16})
            connection.executemany("INSERT INTO records VALUES (?,?,?,?,?,?,?,?)",
                                   [row for row in rows if runner.partition_for(row[0], 16) == index])
            connection.commit()
            summary = admission.database_summary(connection)
            connection.close()
            partitions.append({"part": index, "parts": 16, "status": "complete", **summary,
                               "runtimeVersions": {"test": "no-model-inference"}, "path": path.name,
                               "sha256": admission.sha256_file(path)})
        with self.assertRaisesRegex(ValueError, "Missing or duplicate"):
            runner.merge_partitions(output, config, partitions[:-1])
        merged = runner.merge_partitions(output, config, partitions)
        receipt = {**self.receipt, **merged, "workers": 1, "partitionCount": 16, "executionWorkers": 1, "partitions": partitions}
        receipt_path = output / "candidate-audit.json"
        receipt_path.write_text(json.dumps(receipt))
        with admission.AdmissionAudit(receipt_path, self.model_path, self.sources) as audit:
            self.assertEqual("pass", audit.record("ffhq-test", self.entries[0])["decision"])


if __name__ == "__main__":
    unittest.main()
