"""Small real-byte fixtures for the complete remediation difference contract."""
import copy
import gzip
import hashlib
import json
import shutil
import struct
import sys
import tempfile
import unittest
import zlib
from collections import Counter
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import clean_core_admission as admission
import clean_core_remediation_review as remediation
from clean_core_policy_v3 import POLICY_VERSION, classify_assignment, quantized_pose_cell
from clean_core_selection_review import SelectionReview, WinkExpressionReview


def png(number):
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)
    pixels = b"".join(b"\0" + bytes((number * 29 + 20, 100 + number, 190 - number)) * 8 for _ in range(8))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


class RemediationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        # Only fixtures alter the fixed production target/reference constants.
        # There is deliberately no CLI switch for reducing the real 70k gate.
        self.target = patch.object(remediation, "TARGET_TOTAL", 3)
        self.target.start()
        self.addCleanup(self.target.stop)
        self.payloads = [png(number) for number in range(6)]
        self.image_shas = [hashlib.sha256(raw).hexdigest() for raw in self.payloads]
        self.records = []
        for number in range(6):
            yaw = [0, 6, -6, 12, -12, 3][number]
            feature = [yaw / 90, 0.0, 0.0] + [0.0] * 52
            self.records.append({
                "sourceKey": "fixture-source\0photo-" + str(number), "sourceCatalogId": "fixture-source",
                "sourceId": "photo-" + str(number), "sourceLabel": "current", "encodedSha256": self.image_shas[number],
                "sourceFeatureSha256": admission.feature_sha256({"feature": feature}), "decision": "pass",
                "feature": feature, "shape": "", "mesh": "", "projection": "", "layout": [.5, .5, .6, .6],
                "freshYaw": float(yaw), "freshPitch": 0.0, "freshRoll": 0.0,
                "byteLength": len(self.payloads[number]), "checks": {key: "pass" for key in admission.REQUIRED_CHECKS},
                "faceAttributes": [.1, .1, .1, .001, .001], "fullAttributes": [.1, .1, .1, .002, .002],
            })
        self.audit_path = self.root / "admission/candidate-audit.json"
        self.audit_path.parent.mkdir()
        policy = admission.AdmissionPolicy()
        self.receipt = {"schemaVersion": 2, "status": "complete", "policy": policy.document(), "policySha256": policy.sha256,
                        "analysisCodeSha256": admission.sha256_file(admission.__file__), "runnerCodeSha256": "c" * 64,
                        "models": {"attributeSha256": "a" * 64, "faceSha256": "b" * 64}, "controlsSha256": "d" * 64,
                        "sources": [{"catalogId": "fixture-source", "label": "current", "expectedRows": 6, "manifestSha256": "e" * 64}],
                        "recordCount": 6, "passCount": 6, "rejectCount": 0, "unresolvedCount": 0,
                        "sourceCounts": {"fixture-source": 6}, "allCandidateRowsAccounted": True,
                        "runtimeExclusionOverlayRequired": False, "recordsPath": "records.sqlite"}
        self.database_path = self.audit_path.parent / "records.sqlite"
        database = admission.create_records_database(self.database_path, {key: self.receipt[key] for key in (
            "schemaVersion", "status", "policySha256", "analysisCodeSha256", "models", "controlsSha256", "sources")})
        for record in self.records:
            record["policySha256"] = policy.sha256
            admission.insert_record(database, record)
        database.commit()
        database.close()
        self.receipt["recordsSha256"] = admission.sha256_file(self.database_path)
        self.write(self.audit_path, self.receipt)
        self.audit_sha = admission.sha256_file(self.audit_path)
        self.previous_review = self.review_document([5], None)
        self.previous_path = self.root / "old-review.json"
        self.write(self.previous_path, self.previous_review)
        self.previous_sha = admission.sha256_file(self.previous_path)
        self.final_review = self.review_document([5, 1, 2], self.previous_sha)
        self.selection_path = self.root / "final-review.json"
        self.write(self.selection_path, self.final_review)
        self.wink_document = {
            "schemaVersion": 1, "documentKind": "clean-core-wink-expression-review", "mode": "confirmed-side-only",
            "candidateAuditSha256": self.audit_sha, "recordsSha256": self.receipt["recordsSha256"],
            "reviewer": "assistant-visual-review", "humanVerified": False, "reviewedOn": "2026-10-06", "reviews": []}
        self.prior_path, self.final_path = self.root / "prior", self.root / "final"
        self.prior = self.catalog(self.prior_path, [0, 1, 2], self.previous_path, None, 101, "1" * 40)
        self.final = self.catalog(self.final_path, [0, 3, 4], self.selection_path, self.previous_path, 202, "2" * 40)
        self.failed_path = self.root / "original-failed.json"
        report_rows = []
        for number, decision in enumerate(("pass", "deny", "uncertain")):
            entry, record = self.prior["entries"][number], self.records[number]
            report_rows.append({"sample": f"H{number + 1:03d}", "id": entry["id"], "encodedSha256": self.image_shas[number],
                                "sourceCatalogId": record["sourceCatalogId"], "sourceId": record["sourceId"], "sourceKey": record["sourceKey"],
                                "byteLength": record["byteLength"], "freshYaw": record["freshYaw"], "freshPitch": record["freshPitch"],
                                "cleanProfile": entry["cleanProfile"], "cleanTier": entry["cleanTier"],
                                "decision": decision, "pixelChangesApplied": False, "viewedOriginal": number > 0})
        self.failed = {"schemaVersion": 1, "documentKind": "clean-core-selected-photo-holdout-visual-review",
                       "status": "failed-requires-preselection-remediation", "reviewer": "assistant-visual-review", "humanVerified": False,
                       "candidateRunId": 101, "qaRunId": 303, "manifestSha256": self.prior["manifestSha256"],
                       "candidateAuditSha256": self.audit_sha, "recordsSha256": self.receipt["recordsSha256"],
                       "sampleIndexSha256": "f" * 64, "sampleCount": 3, "counts": {"pass": 1, "deny": 1, "uncertain": 1},
                       "reviews": report_rows}
        self.write(self.failed_path, self.failed)
        reference = {
            "runId": 101, "runAttempt": 1, "codeCommit": "1" * 40, "artifactId": 123,
            "artifactName": "fixture-reference", "archiveSha256": "0" * 64,
            "manifestSha256": self.prior["manifestSha256"], "generationReceiptSha256": self.prior["generationReceiptSha256"],
            "candidateAuditSha256": self.audit_sha, "recordsSha256": self.receipt["recordsSha256"],
            "failedHoldoutSha256": admission.sha256_file(self.failed_path), "qaRunId": 303, "sampleIndexSha256": "f" * 64,
            "sampleCount": 3, "counts": self.failed["counts"]}
        self.reference = patch.dict(remediation.REFERENCE, reference, clear=True)
        self.reference.start()
        self.addCleanup(self.reference.stop)
        self.output = self.root / "prepared"

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(remediation.canonical(value) + b"\n")

    def review_document(self, numbers, previous):
        return {"schemaVersion": 1, "documentKind": "clean-core-selection-visibility-review", "mode": "deny-only",
                "candidateAuditSha256": self.audit_sha, "recordsSha256": self.receipt["recordsSha256"],
                "reviewer": "assistant-visual-review", "humanVerified": False, "reviewedOn": "2026-10-06",
                "previousReviewSha256": previous,
                "reviews": [{"encodedSha256": self.image_shas[number], "decision": "deny", "reason": "A visible fixture defect",
                             "sourceCatalogId": "fixture-source", "sourceId": f"photo-{number}"} for number in numbers]}

    def catalog(self, root, numbers, review_path, previous_path, run, commit):
        catalog = root / "catalog"
        for directory in (catalog / "packs", catalog / "shards", root / "provenance", root / "selection"):
            directory.mkdir(parents=True, exist_ok=True)
        review = SelectionReview(review_path, self.audit_sha, self.receipt["recordsSha256"], previous_path)
        review.write_catalog_files(catalog)
        self.write(catalog / "wink-expression-review.json", self.wink_document)
        wink = WinkExpressionReview(catalog / "wink-expression-review.json", self.audit_sha, self.receipt["recordsSha256"])
        project = Path(__file__).resolve().parents[1]
        code = {name: admission.sha256_file(project / name) for name in remediation.SELECTION_PROGRAMS}
        identity = {"schemaVersion": 1, "policyVersion": POLICY_VERSION, "candidateAuditSha256": self.audit_sha,
                    "targetTotal": 3, "preselectMultiplier": 6,
                    "selectionCodeSha256": {Path(name).name: value for name, value in code.items()
                                            if name not in ("tools/validate_clean_core_admission.py", "tools/repack-live-pose-packs.mjs",
                                                            "scripts/rebuild-clean-wink-support.mjs")},
                    "profileEvidenceTiers": {"neutral": ["strict"]}, "profileMinimums": {"neutral": 1},
                    "profilePoseCellMinimums": {"neutral": 1}, "backgroundMinimums": {}, "backgroundPoseCellMinimums": {},
                    "profileCellLimits": {"neutral": 10}, "additionalSelectionExclusionsSha256": review.sha256,
                    "winkExpressionReviewSha256": wink.sha256}
        identity_sha = hashlib.sha256(remediation.canonical(identity)).hexdigest()
        stamp = {"schemaVersion": 2, "status": "complete", "policyId": self.receipt["policy"]["policyId"],
                 "policySha256": self.receipt["policySha256"], "receiptSha256": self.audit_sha,
                 "recordsSha256": self.receipt["recordsSha256"], "attributeModelSha256": "a" * 64, "faceModelSha256": "b" * 64,
                 "selectedCount": 3, "runtimeExclusionOverlayRequired": False}
        entries, cells, payload = [], {}, b""
        for number in numbers:
            record = self.records[number]
            assignment, tier = classify_assignment(record["feature"], record["projection"])
            entry = {key: record[key] for key in remediation.MEASUREMENTS}
            entry.update({"id": "clean-v5-" + self.image_shas[number][:28], "admissionSha256": self.image_shas[number],
                          "admissionSourceCatalogId": "fixture-source", "admissionSourceId": f"photo-{number}",
                          "admissionPolicySha256": self.receipt["policySha256"], "pack": "faces.bin", "offset": len(payload),
                          "length": len(self.payloads[number]), "cleanProfile": assignment.name, "cleanTier": tier,
                          "cleanPolicy": POLICY_VERSION, "cleanPurity": round(assignment.purity, 6), "cleanScore": .9})
            payload += self.payloads[number]
            entries.append(entry)
            cell = quantized_pose_cell(record["feature"], 3)[0]
            filename = "cell-" + cell.replace(":", "_") + ".json"
            self.write(catalog / "shards" / filename, {"cell": cell, "items": [entry]})
            cells[cell] = {"count": 1, "shards": [filename]}
        (catalog / "packs/faces.bin").write_bytes(payload)
        counts = dict(Counter(entry["cleanProfile"] for entry in entries))
        breadth = {"neutral": len(cells)}
        common = {"selectionIdentity": identity, "selectionIdentitySha256": identity_sha, "qualityAdmission": stamp,
                  "selectionReview": review.stamp(), "winkExpressionReview": wink.stamp()}
        selection = {**common, "selectionReviewSha256": review.sha256, "winkExpressionReviewSha256": wink.sha256,
                     "gatePassed": True, "gateFailures": [], "knownSyntheticFacesSelected": 0,
                     "selectedProfiles": counts, "selectedProfilePoseCells": breadth, "selectedSources": {"fixture-source": 3},
                     "selectedTiers": {"strict": 3}, "strictProfiles": counts, "observedProfiles": {},
                     "policyVersion": POLICY_VERSION, "minimums": {"neutral": 1}, "poseCellMinimums": {"neutral": 1},
                     "backgroundMinimums": {}, "backgroundPoseCellMinimums": {}, "limits": {"neutral": 10},
                     "profileEvidenceTiers": {"neutral": ["strict"]}}
        self.write(catalog / "clean-core-audit.json", selection)
        shutil.copyfile(catalog / "clean-core-audit.json", root / "selection/audit.json")
        manifest = {**common, "schemaVersion": 3, "catalogId": "many-faces-clean-core-v5-" + identity_sha[:16] + "-pose-local-v1",
                    "totalFaces": 3, "sourceFaces": 3, "searchableFaces": 3, "poseStep": 3, "shardsContainGeometry": True,
                    "bounds": {"yawMin": -45, "yawMax": 45, "pitchMin": -36, "pitchMax": 36}, "outputSize": 256,
                    "shapeVersion": "mediapipe-projection-468-v4", "featureSchema": "mediapipe-face-actions-v2", "featureLength": 55,
                    "indexFiles": [], "cells": cells, "stats": {"cleanCore": {"profileCounts": counts, "profilePoseCells": breadth}}}
        self.write(catalog / "manifest.json", manifest)
        manifest_sha = admission.sha256_file(catalog / "manifest.json")
        physical = {**common, "schemaVersion": 1, "status": "passed", "physicalFaces": 3, "uniqueEncodedImages": 3,
                    "allSelectedPhotosHavePassingAdmission": True, "allFreshMeasurementsMatch": True,
                    "allSelectedPhotosAbsentFromSelectionExclusions": True, "allSelectedWinkProfilesHaveReviewedEvidence": True,
                    "allSelectedProfilesHaveDeclaredEvidence": True, "selectionReviewSha256": review.sha256,
                    "winkExpressionReviewSha256": wink.sha256, "runtimeExclusionOverlayRequired": False,
                    "catalogId": manifest["catalogId"], "manifestSha256": manifest_sha,
                    "selectedProfiles": counts, "selectedProfilePoseCells": breadth, "selectedSources": {"fixture-source": 3},
                    "strictProfiles": counts, "observedProfiles": {}}
        self.write(catalog / "clean-admission-validation.json", physical)
        inference = {"mode": "reused", "workflowRunId": 100, "workflowRunAttempt": 1, "codeCommit": "3" * 40,
                     "candidateAuditSha256": self.audit_sha, "sourceCandidateRows": 6,
                     "reuseVerificationSha256": str(run % 10) * 64, "newInferencePerformedInThisRun": False, "auditRemergedInThisRun": False,
                     **{key: self.receipt[key] for key in ("recordsSha256", "analysisCodeSha256", "runnerCodeSha256", "policySha256", "controlsSha256", "models")}}
        generation = {"schemaVersion": 1, "artifactPurpose": "physical-catalog-candidate-for-review", "workflowRunId": run,
                      "workflowRunAttempt": 1, "builtFromCommit": commit, "candidateManifestSha256": manifest_sha,
                      "candidateAuditSha256": self.audit_sha, "targetTotal": 3, "inference": inference,
                      "ffhqSourceCommit": "4" * 40, "auditPartitions": 16, "visibilityMaxScore": .05,
                      "sourceManifestSha256": {"current": "e" * 64}, "attributeModelSha256": "a" * 64, "faceModelSha256": "b" * 64,
                      "priorYawEvidenceSha256": "1" * 64, "reviewedVisibilitySha256": "2" * 64,
                      "selectionReviewSha256": review.sha256, "previousSelectionReviewSha256": review.document["previousReviewSha256"],
                      "winkExpressionReviewSha256": wink.sha256, "winkExpressionReview": wink.stamp(), "runtimeExclusionOverlayRequired": False,
                      "selection": {"codeCommit": commit, "codeFilesSha256": code, "additionalSelectionExclusionsSha256": review.sha256,
                                    "previousAdditionalSelectionExclusionsSha256": review.document["previousReviewSha256"],
                                    "winkExpressionReviewSha256": wink.sha256,
                                    "selectionAuditSha256": admission.sha256_file(catalog / "clean-core-audit.json")}}
        self.write(root / "provenance/candidate-receipt.json", generation)
        (root / "provenance/catalog-selection-reviewed.json").write_bytes(review.raw_bytes)
        (root / "provenance/catalog-wink-expression-reviewed.json").write_bytes(wink.raw_bytes)
        if previous_path is not None:
            (root / "provenance/catalog-selection-reviewed-previous.json").write_bytes(previous_path.read_bytes())
        return {"entries": entries, "manifest": manifest, "selection": selection, "physical": physical, "generation": generation,
                "manifestSha256": manifest_sha, "generationReceiptSha256": admission.sha256_file(root / "provenance/candidate-receipt.json")}

    def inputs(self):
        return (self.prior_path, self.final_path, self.audit_path, self.failed_path, self.selection_path)

    def prepare(self):
        result = remediation.prepare(*self.inputs(), self.output)
        self.index_path = self.output / "remediation-index.json"
        self.index = json.loads(self.index_path.read_bytes())
        self.index_sha = admission.sha256_file(self.index_path)
        return result

    def image_review(self, rows=None, filename="review.json"):
        if rows is None:
            rows = [{**{key: row[key] for key in ("sample", "encodedSha256", "sourceCatalogId", "sourceId")},
                     "decision": "pass", "reason": "Original face and all surrounding objects are readable",
                     "viewedOriginal": True, "pixelChangesApplied": False} for row in self.index["added"]]
        document = {"schemaVersion": 1, "documentKind": remediation.REVIEW_KIND, "scope": remediation.REVIEW_SCOPE,
                    "remediationIndexSha256": self.index_sha, "finalManifestSha256": self.final["manifestSha256"],
                    "reviewer": "assistant-visual-review", "humanVerified": False, "reviews": rows}
        path = self.root / filename
        self.write(path, document)
        return path, document

    def index_verify(self, paths):
        return remediation.verify_index(self.index_path, self.index_sha, self.final["manifestSha256"], paths)

    def test_prepare_extracts_the_complete_exact_delta_and_preserves_failed_evidence(self):
        original_bytes = self.failed_path.read_bytes()
        result = self.prepare()
        self.assertEqual(self.index["counts"], {"priorPhotos": 3, "finalPhotos": 3, "retainedPhotos": 1, "removedPhotos": 2, "addedPhotos": 2})
        self.assertEqual({row["encodedSha256"] for row in self.index["added"]}, set(self.image_shas[3:5]))
        self.assertEqual({row["encodedSha256"] for row in self.index["removed"]}, set(self.image_shas[1:3]))
        self.assertEqual((self.output / "original-failed-holdout.json").read_bytes(), original_bytes)
        self.assertEqual(self.failed_path.read_bytes(), original_bytes)
        self.assertFalse(result["independentHoldoutPassed"])
        self.assertFalse(result["allAddedOriginalsReviewed"])
        self.assertEqual(self.index["failedHoldout"]["status"], "failed-requires-preselection-remediation")
        self.assertEqual(len(self.index["retainedSampleCarry"]), 1)
        self.assertFalse(self.index["retainedSampleCarry"][0]["supplementalOriginalReview"])
        for row in self.index["added"]:
            self.assertEqual((self.output / row["imagePath"]).read_bytes(), self.payloads[self.image_shas.index(row["encodedSha256"])] )
        for item in self.index["inventoryFiles"]:
            self.assertEqual(admission.sha256_file(self.output / item["path"]), item["sha256"])
            self.assertEqual(len(gzip.decompress((self.output / item["path"]).read_bytes()).splitlines()), 3)

    def test_full_recomputation_and_native_index_paths_have_the_same_review_verdict(self):
        self.prepare()
        path, _ = self.image_review()
        small = self.index_verify([path])
        full = remediation.verify(*self.inputs(), self.index_path, [path])
        self.assertTrue(full["fullCatalogDifferenceRevalidated"])
        self.assertFalse(small["fullCatalogDifferenceRevalidated"])
        for key in small.keys() - {"fullCatalogDifferenceRevalidated", "nativeIndexAuthentication"}:
            self.assertEqual(small[key], full[key], key)
        self.assertEqual(small["reviewedPhotos"], 2)
        self.assertEqual(small["failedHoldout"]["counts"], {"pass": 1, "deny": 1, "uncertain": 1})
        self.assertFalse(small["independentHoldoutPassed"])

    def test_actual_served_catalog_copy_can_be_checked_without_copying_provenance(self):
        served = self.root / "app/public/seed-catalog"
        shutil.copytree(self.final_path / "catalog", served)
        result = remediation.prepare(*self.inputs(), self.output, final_catalog=served)
        self.assertEqual(result["finalManifestSha256"], self.final["manifestSha256"])
        (served / "packs/faces.bin").write_bytes(b"broken")
        with self.assertRaises(ValueError):
            remediation.prepare(*self.inputs(), self.root / "other-output", final_catalog=served)

    def test_wrong_original_audit_database_or_failed_report_bytes_are_rejected(self):
        for path in (self.audit_path, self.database_path, self.failed_path):
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            try:
                with self.subTest(path=path.name), self.assertRaises(ValueError):
                    remediation.prepare(*self.inputs(), self.output)
                self.assertFalse(self.output.exists())
            finally:
                path.write_bytes(original)

    def test_moving_reference_to_the_final_catalog_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "fixed c92"):
            remediation.prepare(self.final_path, self.final_path, self.audit_path, self.failed_path, self.selection_path, self.output)

    def test_generic_visibility_model_source_or_selector_changes_are_rejected(self):
        path = self.final_path / "provenance/candidate-receipt.json"
        for label in ("visibilityMaxScore", "attributeModelSha256", "sourceManifestSha256", "codeFilesSha256", "newInference"):
            changed = copy.deepcopy(self.final["generation"])
            if label == "codeFilesSha256":
                changed["selection"][label]["tools/clean_core_policy_v3.py"] = "f" * 64
            elif label == "sourceManifestSha256":
                changed[label]["current"] = "f" * 64
            elif label == "newInference":
                changed["inference"]["newInferencePerformedInThisRun"] = True
            else:
                changed[label] = .2 if label == "visibilityMaxScore" else "f" * 64
            self.write(path, changed)
            with self.subTest(change=label), self.assertRaises(ValueError):
                remediation.prepare(*self.inputs(), self.output)
        self.write(path, self.final["generation"])

    def test_original_denial_must_be_preserved_exactly(self):
        rewritten = copy.deepcopy(self.final_review)
        rewritten["reviews"][0]["reason"] = "Rewritten old decision"
        self.write(self.selection_path, rewritten)
        self.catalog(self.final_path, [0, 3, 4], self.selection_path, self.previous_path, 202, "2" * 40)
        with self.assertRaisesRegex(ValueError, "prior denial was removed or rewritten"):
            remediation.prepare(*self.inputs(), self.output)

    def test_deny_or_uncertain_cannot_remain_by_sha_or_source_alias(self):
        for denied_number in (1, 2):
            self.catalog(self.final_path, [0, denied_number, 3], self.selection_path, self.previous_path, 202, "2" * 40)
            with self.subTest(denied_number=denied_number), self.assertRaisesRegex(ValueError, "known denied image"):
                remediation.prepare(*self.inputs(), self.output)

    def test_actual_payload_truncation_or_hash_change_is_rejected(self):
        path = self.final_path / "catalog/packs/faces.bin"
        original = path.read_bytes()
        for changed in (original[:-1], bytes([original[0] ^ 1]) + original[1:]):
            path.write_bytes(changed)
            with self.subTest(length=len(changed)), self.assertRaises(ValueError):
                remediation.prepare(*self.inputs(), self.output)

    def test_changed_fresh_geometry_source_and_profile_are_rejected(self):
        shard_path = self.final_path / "catalog/shards/cell-0_0.json"
        original = json.loads(shard_path.read_bytes())
        for field, value in (("layout", [.1, .1, .2, .2]), ("admissionSourceId", "missing"),
                             ("admissionSha256", "f" * 64), ("cleanProfile", "winkLeft"), ("feature", [0] * 54)):
            changed = copy.deepcopy(original)
            changed["items"][0][field] = value
            self.write(shard_path, changed)
            with self.subTest(field=field), self.assertRaises(ValueError):
                remediation.prepare(*self.inputs(), self.output)

    def test_duplicate_photos_or_wrong_cell_cannot_hide_behind_valid_counts(self):
        path = self.final_path / "catalog/shards/cell-12_0.json"
        original = json.loads(path.read_bytes())
        changed = copy.deepcopy(original)
        changed["items"][0] = copy.deepcopy(self.final["entries"][0])
        self.write(path, changed)
        with self.assertRaisesRegex(ValueError, "duplicate|Duplicate"):
            remediation.prepare(*self.inputs(), self.output)
        changed = copy.deepcopy(original)
        changed["cell"] = "-12:0"
        self.write(path, changed)
        with self.assertRaisesRegex(ValueError, "Shard header"):
            remediation.prepare(*self.inputs(), self.output)

    def test_preparation_fails_without_truncating_when_archive_bound_is_exceeded(self):
        # The two originals are still required; an output cap never samples one.
        with patch.object(remediation, "MAX_PART_BYTES", 1024), self.assertRaisesRegex(ValueError, "24 MiB"):
            remediation.prepare(*self.inputs(), self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".remediation-*")), [])

    def test_zero_delta_is_not_a_successful_remediation(self):
        self.prepare()
        changed = copy.deepcopy(self.index)
        changed["counts"].update(addedPhotos=0, removedPhotos=0, retainedPhotos=3)
        changed["added"], changed["removed"] = [], []
        with self.assertRaisesRegex(ValueError, "census size"):
            remediation.validate_index(changed, self.final["manifestSha256"])

    def test_actual_zero_replacements_fail_even_when_a_new_unused_image_was_denied(self):
        self.write(self.selection_path, self.review_document([5, 4], self.previous_sha))
        self.catalog(self.final_path, [0, 1, 2], self.selection_path, self.previous_path, 202, "2" * 40)
        with self.assertRaisesRegex(ValueError, "nonempty complete replenishment delta"):
            remediation.prepare(*self.inputs(), self.output)

    def test_native_index_digest_and_candidate_binding_are_required(self):
        self.prepare()
        path, _ = self.image_review()
        for index_sha, manifest_sha in (("f" * 64, self.final["manifestSha256"]), (self.index_sha, "f" * 64)):
            with self.subTest(index_sha=index_sha), self.assertRaises(ValueError):
                remediation.verify_index(self.index_path, index_sha, manifest_sha, [path])
        self.index_path.write_bytes(self.index_path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "native QA artifact anchor"):
            self.index_verify([path])

    def test_every_added_original_needs_one_and_only_one_pass(self):
        self.prepare()
        _, valid = self.image_review()
        cases = [[], valid["reviews"][:1], valid["reviews"] + valid["reviews"][:1]]
        for decision in ("deny", "uncertain"):
            changed = copy.deepcopy(valid["reviews"])
            changed[0]["decision"] = decision
            cases.append(changed)
        for rows in cases:
            path, _ = self.image_review(rows)
            with self.subTest(count=len(rows)), self.assertRaises(ValueError):
                self.index_verify([path])

    def test_review_cannot_substitute_scope_source_contact_or_attribution(self):
        self.prepare()
        path, valid = self.image_review()
        alterations = ({"scope": "wink-side-only"}, {"humanVerified": True}, {"remediationIndexSha256": "f" * 64},
                       {"finalManifestSha256": "f" * 64})
        for alteration in alterations:
            changed = {**copy.deepcopy(valid), **alteration}
            self.write(path, changed)
            with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                self.index_verify([path])
        for alteration in ({"viewedOriginal": False}, {"viewedOriginal": 1}, {"pixelChangesApplied": True},
                           {"sourceId": "alias"}, {"sample": "H999"}, {"reason": " "}):
            changed = copy.deepcopy(valid)
            changed["reviews"][0].update(alteration)
            self.write(path, changed)
            with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                self.index_verify([path])

    def test_multiple_reviewers_can_cover_disjoint_complete_originals(self):
        self.prepare()
        _, complete = self.image_review()
        first, _ = self.image_review(complete["reviews"][:1], "review-first.json")
        second, _ = self.image_review(complete["reviews"][1:], "review-second.json")
        result = self.index_verify([first, second])
        self.assertEqual(result["reviewedPhotos"], 2)
        self.assertEqual(len(result["reviewFiles"]), 2)

    def test_prior_full_original_quality_pass_can_be_reused_but_still_counts_as_added(self):
        self.prepare()
        path, document = self.image_review()
        old_document = {"schemaVersion": 1, "documentKind": remediation.ORIGINAL_REVIEW_KIND, "scope": remediation.REVIEW_SCOPE,
                        "reviewer": "assistant-visual-review", "humanVerified": False, "reviews": [copy.deepcopy(document["reviews"][0])]}
        old_path = self.root / "earlier-original-review.json"
        self.write(old_path, old_document)
        document["reviews"][0]["reusedFrom"] = {"path": old_path.name, "sha256": admission.sha256_file(old_path)}
        self.write(path, document)
        result = self.index_verify([path])
        self.assertEqual(result["addedPhotos"], 2)
        self.assertEqual(result["reusedOriginalReviews"], 1)
        self.assertEqual(result["newOriginalReviews"], 1)
        self.assertEqual(len(self.index["added"]), 2)
        for field, value in (("scope", "wink-side-only"), ("documentKind", "clean-core-wink-expression-review")):
            changed = {**copy.deepcopy(old_document), field: value}
            self.write(old_path, changed)
            document["reviews"][0]["reusedFrom"]["sha256"] = admission.sha256_file(old_path)
            self.write(path, document)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "full-original-image"):
                self.index_verify([path])

    def test_reuse_contact_only_uncertain_chain_or_changed_sha_is_rejected(self):
        self.prepare()
        path, document = self.image_review()
        old_path = self.root / "earlier.json"
        base = {"schemaVersion": 1, "documentKind": remediation.ORIGINAL_REVIEW_KIND, "scope": remediation.REVIEW_SCOPE,
                "reviewer": "assistant-visual-review", "humanVerified": False, "reviews": [copy.deepcopy(document["reviews"][0])]}
        for alteration in ({"viewedOriginal": False}, {"decision": "uncertain"}, {"sourceId": "another"},
                           {"reusedFrom": {"path": "chain.json", "sha256": "f" * 64}}):
            old = copy.deepcopy(base)
            old["reviews"][0].update(alteration)
            self.write(old_path, old)
            document["reviews"][0]["reusedFrom"] = {"path": old_path.name, "sha256": admission.sha256_file(old_path)}
            self.write(path, document)
            with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                self.index_verify([path])
        document["reviews"][0]["reusedFrom"] = {"path": old_path.name, "sha256": "f" * 64}
        self.write(path, document)
        with self.assertRaisesRegex(ValueError, "Reused review bytes changed"):
            self.index_verify([path])

    def test_safe_paths_and_unique_json_are_enforced(self):
        for value in ("../escape.json", "/absolute.json", "folder/../escape.json", "a\\b.json", "a//b.json"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                remediation.child(self.root, value)
        with self.assertRaisesRegex(ValueError, "Duplicate remediation JSON key"):
            remediation.parse(b'{"schemaVersion":1,"schemaVersion":2}')
        with self.assertRaisesRegex(ValueError, "Non-finite"):
            remediation.parse(b'{"value":NaN}')

    def test_full_verify_detects_missing_original_and_changed_inventory(self):
        self.prepare()
        path, _ = self.image_review()
        image = self.output / self.index["added"][0]["imagePath"]
        raw = image.read_bytes()
        image.unlink()
        with self.assertRaisesRegex(ValueError, "Missing, incomplete"):
            remediation.verify(*self.inputs(), self.index_path, [path])
        image.write_bytes(raw)
        inventory = self.output / "prior-inventory.jsonl.gz"
        inventory.write_bytes(inventory.read_bytes() + b"\0")
        with self.assertRaisesRegex(ValueError, "inventory file changed"):
            remediation.verify(*self.inputs(), self.index_path, [path])


if __name__ == "__main__":
    unittest.main()
