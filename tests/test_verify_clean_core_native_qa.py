"""Network-faked native provenance tests; these fixtures are not browser QA."""
from __future__ import annotations

import copy
from email.message import Message
import hashlib
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import verify_clean_core_native_qa as gate


CODE = "b66eaa0cf466e61cc01f4999ab9e04770097702c"
RUN_ID, ATTEMPT, ARTIFACT_ID = 37494402324, 1, 11426884161
REPO_ID = 1340833640
API_PREFIX = gate.API_ROOT + "/repos/" + gate.REPOSITORY
RUN_URL = f"{API_PREFIX}/actions/runs/{RUN_ID}/attempts/{ATTEMPT}"
LIST_URL = f"{API_PREFIX}/actions/runs/{RUN_ID}/artifacts?per_page=100&page=1"
ARCHIVE_URL = f"{API_PREFIX}/actions/artifacts/{ARTIFACT_ID}/zip"
BLOB_URL = "https://artifact.example.invalid/authorized-summary.zip?signature=test-only"


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def summary_zip(receipt, extra=()):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as zipped:
        zipped.writestr("qa-receipt.json", receipt)
        for name, raw in extra:
            zipped.writestr(name, raw)
    return output.getvalue()


def native_receipt():
    # Names and nesting match the current QA packaging schema. Automated
    # outcomes are deliberately constructed here; real run 37494402324 failed.
    comparison_sha = "a" * 64
    return {
        "schemaVersion": 1, "documentKind": "clean-core-v5-candidate-qa",
        "status": "automated-checks-passed-visual-review-pending",
        "passed": False, "automatedChecksPassed": True,
        "executionOrigin": {"kind": "github-actions", "repository": gate.REPOSITORY,
                            "workflowRunId": RUN_ID, "workflowRunAttempt": ATTEMPT,
                            "codeCommit": CODE, "runnerOs": "Linux",
                            "browserRuntime": "Chromium on the GitHub Actions runner"},
        "candidate": {
            "runId": 37491677036, "runAttempt": 1,
            "artifactName": "clean-core-v5-candidate-37491677036-1", "artifactId": 11426800117,
            "archiveSha256": "923b59d9b59ca4ba7ac54bb7660731d5fe89ac81495438f3ed098db705bd1f1c",
            "manifestSha256": "d8265b8077187e7c08e5e4b4a6c39d5999155f1ff0c02bff2160842b97cb5785",
            "generationReceiptSha256": "79c8f68790b11414cdb8b88e9ec2aeb2665d6747e99a7dd51690bb5824ec505f",
            "selectionReviewSha256": "da2b294442ed56c87db3362885e5765e909809ebdb95b1a25ae9bdd8d7618c77",
            "previousSelectionReviewSha256": "3b2b8068ea088f51a1d9796424c2d64718e4180dad8e1e763cba30460407efa1",
            "winkExpressionReviewSha256": "fb6e6845a84118daa64eb06d163077063934d2126a3621a04884ef850d45103f",
            "selectionIdentitySha256": "5281fc23723c252b2ed646f2b53bf7d4a0b6d2b0618aeba8e864abffb5eb5131",
            "codeCommit": CODE,
        },
        "baselineCommit": gate.BASELINE_COMMIT, "requestSha256": "b" * 64,
        "outcomes": dict.fromkeys(gate.OUTCOME_FIELDS, "success"),
        "comparisonContract": {
            "schemaVersion": 1, "status": "complete", "candidatePassed": True,
            "candidateInitialPresentationPassed": True, "baselinePassed": False,
            "baselineInitialPresentationPassed": False, "baselineRemainingChecksPassed": True,
            "baselineKnownInitialFailureAccepted": True, "sameAcquiredFrames": True,
            "sameTimeline": True, "acquiredFramesSha256": "c" * 64,
            "timelineSha256": "d" * 64, "comparedFaceFrames": 410,
        },
        "comparisonContractValidation": {"status": "passed", "error": None},
        "comparisonReportSha256": comparison_sha,
        "comparisonEvidence": {"path": "reports/browser/admitted-catalog/report.json", "sha256": comparison_sha},
        "baselineVerification": {
            "status": "known-initial-drawing-failure", "baselinePassed": False,
            "initialPresentationPassed": False, "remainingChecksPassed": True,
            "knownInitialFailure": {"kind": "baseline-initial-square-aspect"},
            "initialRecovery": {"passed": True},
            "source": {"commit": gate.BASELINE_COMMIT, "sha256": "e" * 64},
        },
        "fixedVideo": {"status": "passed", "fixtureSha256": "d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b",
                       "densityFps": 20, "plannedFrames": 466, "sameAcquiredFrames": True,
                       "sameTimeline": True, "comparison": {"selectedIdChanges": 400}},
        "facePositionSizeTracking": {"status": "passed", "initialPresentationPassed": True,
                                     "defaultEnabled": True, "presentationControlsPreserveSelection": True,
                                     "evidence": "reports/browser/admitted-catalog/report.json"},
        "physicalAdmission": {"status": "passed", "physicalFaces": 70000,
                              "manifestSha256": "d8265b8077187e7c08e5e4b4a6c39d5999155f1ff0c02bff2160842b97cb5785",
                              "allSelectedPhotosHavePassingAdmission": True},
        "pendingNetworkCancellation": {"status": "passed", "cancelToIdleMs": 52.8},
        "virtualCamera": {"status": "passed", "cameraPhase": "running", "catalogTotal": 70000,
                          "physicalCameraVerified": False},
        "selectedPhotoHoldout": {"status": "pending", "reviewer": "assistant visual inspection",
                                 "humanVerified": False, "checkedPhotos": 0, "preparedPhotos": 360,
                                 "previouslyInspectedSha256": "f" * 64,
                                 "previouslyInspectedImageCount": 1617, "sampleIndexSha256": "9" * 64},
        "physicalCameraVerified": False, "hostedSiteVerified": False, "promotionReady": False,
    }


def remediation_native_receipt():
    # Network-only fixture for the new mode, not a claim that a future native
    # run or the added-image visual review has succeeded.
    native = native_receipt()
    final_manifest = "8" * 64
    native["candidate"]["manifestSha256"] = final_manifest
    native["physicalAdmission"]["manifestSha256"] = final_manifest
    native["selectedPhotoHoldout"].update({
        "status": "failed", "checkedPhotos": 360, "preparedPhotos": 360,
        "counts": {"pass": 301, "deny": 27, "uncertain": 32},
        "previouslyInspectedSha256": gate.REMEDIATION_PREVIOUSLY_INSPECTED_SHA256,
        "previouslyInspectedImageCount": 1617, "sampleIndexSha256": gate.REMEDIATION_SAMPLE_INDEX_SHA256,
        "visualReviewSha256": gate.REMEDIATION_FAILED_HOLDOUT_SHA256,
    })
    native["visualReviewPreparation"] = {
        "mode": "remediation", "independentFinalHoldout": False,
        "indexPath": gate.REMEDIATION_INDEX_PATH, "indexSha256": "7" * 64,
        "addedPhotos": 59, "evaluatedCandidateRunId": gate.REMEDIATION_EVALUATED_RUN_ID,
        "evaluatedManifestSha256": gate.REMEDIATION_EVALUATED_MANIFEST_SHA256,
        "finalManifestSha256": final_manifest,
        "failedHoldoutSha256": gate.REMEDIATION_FAILED_HOLDOUT_SHA256,
    }
    native["remediationEvidence"] = {"path": gate.REMEDIATION_INDEX_PATH, "sha256": "7" * 64}
    return native


def case(native=None, zip_bytes=None):
    native = copy.deepcopy(native or native_receipt())
    receipt = encode(native)
    archive = zip_bytes if zip_bytes is not None else summary_zip(receipt, [("sample-index.json", b"{}\n")])
    wrapper = copy.deepcopy(native)
    wrapper.update(status="passed", passed=True, promotionReady=True)
    if "visualReviewPreparation" not in native:
        wrapper["selectedPhotoHoldout"].update(status="passed", checkedPhotos=360)
    elif isinstance(wrapper.get("remediationEvidence"), dict):
        wrapper["remediationEvidence"]["path"] = "data/catalog-quality/candidate-remediation-index.json"
    wrapper["comparisonEvidence"]["path"] = "data/catalog-quality/candidate-comparison-report.json"
    wrapper["evidence"] = [copy.deepcopy(wrapper["comparisonEvidence"])]
    pins = {"runId": RUN_ID, "runAttempt": ATTEMPT, "artifactId": ARTIFACT_ID,
            "artifactName": f"clean-core-v5-qa-summary-{RUN_ID}-{ATTEMPT}",
            "archiveSha256": digest(archive), "qaReceiptSha256": digest(receipt)}
    wrapper["nativeExecution"] = pins
    run = {"id": RUN_ID, "run_attempt": ATTEMPT, "status": "completed", "conclusion": "success",
           "head_sha": CODE, "head_commit": {"id": CODE}, "head_branch": gate.BRANCH,
           "event": "push", "path": gate.WORKFLOW_PATH,
           "repository": {"id": REPO_ID, "full_name": gate.REPOSITORY},
           "head_repository": {"id": REPO_ID, "full_name": gate.REPOSITORY}}
    artifact = {"id": ARTIFACT_ID, "name": pins["artifactName"], "size_in_bytes": len(archive),
                "url": ARCHIVE_URL[:-4], "archive_download_url": ARCHIVE_URL, "expired": False,
                "digest": "sha256:" + digest(archive),
                "workflow_run": {"id": RUN_ID, "repository_id": REPO_ID, "head_repository_id": REPO_ID,
                                 "head_branch": gate.BRANCH, "head_sha": CODE}}
    return {"native": native, "receipt": receipt, "archive": archive, "wrapper": wrapper,
            "run": run, "artifact": artifact}


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = Message()
        for name, value in (headers or {"Content-Length": str(len(body))}).items():
            self.headers[name] = value

    def getcode(self):
        return self.status


class FakeOpener:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, request, timeout):
        self.requests.append({"url": request.full_url, "method": request.get_method(),
                              "headers": dict((key.lower(), value) for key, value in request.header_items()),
                              "timeout": timeout})
        status, raw, headers = self.routes[request.full_url]
        response = Response(raw, status, headers)
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "mock status", response.headers, response)
        return response


def client_for(value, redirect=True):
    routes = {RUN_URL: (200, encode(value["run"]), None),
              LIST_URL: (200, encode({"total_count": 1, "artifacts": [value["artifact"]]}), None)}
    if redirect:
        routes[ARCHIVE_URL] = (302, b"", {"Location": BLOB_URL})
        routes[BLOB_URL] = (200, value["archive"], None)
    else:
        routes[ARCHIVE_URL] = (200, value["archive"], None)
    opener = FakeOpener(routes)
    return gate.GitHubClient("test-token-not-real", opener), opener


class NativeQAVerificationTests(unittest.TestCase):
    def verify_case(self, value, client=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            qa = root / "candidate-qa.json"
            qa.write_bytes(encode(value["wrapper"]))
            actual_client, opener = client_for(value)
            result = gate.verify(qa, gate.REPOSITORY, root / "evidence", client or actual_client)
            self.assertEqual((root / "evidence/native-qa-receipt.json").read_bytes(), value["receipt"])
            self.assertEqual(json.loads((root / "evidence/native-qa-verification.json").read_bytes()), result)
            metadata = (root / "evidence/native-qa-source-metadata.json").read_bytes()
            self.assertEqual(digest(metadata), result["evidence"]["metadata"]["sha256"])
            self.assertEqual(qa.read_bytes(), encode(value["wrapper"]))
            return result, opener.requests

    def test_success_is_bound_to_native_attempt_artifact_and_exact_receipt(self):
        value = case()
        result, requests = self.verify_case(value)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["runId"], RUN_ID)
        self.assertEqual(result["runAttempt"], ATTEMPT)
        self.assertEqual(result["codeCommit"], CODE)
        self.assertEqual(result["qaReceiptSha256"], digest(value["receipt"]))
        self.assertEqual(result["archiveSha256"], digest(value["archive"]))
        self.assertEqual(result["matchedFields"], list(gate.IMMUTABLE_FIELDS))
        self.assertEqual(result["matchedHoldoutFields"], list(gate.HOLDOUT_PREPARATION_FIELDS))
        self.assertEqual([item["url"] for item in requests], [RUN_URL, LIST_URL, ARCHIVE_URL, BLOB_URL])
        self.assertTrue(all(item["method"] == "GET" for item in requests))
        self.assertNotIn("test-token-not-real", json.dumps(result))

    def test_manual_review_fields_may_change_but_automatic_fields_do_not(self):
        value = case()
        value["wrapper"]["selectedPhotoHoldout"]["notes"] = "Originals inspected after native execution"
        value["wrapper"]["status"] = "still-under-manual-review"
        self.verify_case(value)  # Manual authorization is deliberately a separate gate.
        for name in gate.IMMUTABLE_FIELDS:
            with self.subTest(field=name):
                changed = case()
                changed["wrapper"][name] = {"forged": True}
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(changed)

    def test_prepared_holdout_and_seen_index_cannot_be_replaced_during_manual_review(self):
        changes = {"preparedPhotos": 359, "previouslyInspectedSha256": "0" * 64,
                   "previouslyInspectedImageCount": 1618, "sampleIndexSha256": "0" * 64}
        for field, altered in changes.items():
            with self.subTest(field=field):
                value = case(); value["wrapper"]["selectedPhotoHoldout"][field] = altered
                with self.assertRaisesRegex(gate.VerificationError, "native holdout preparation"):
                    self.verify_case(value)
        value = case(); value["wrapper"]["selectedPhotoHoldout"]["preparedPhotos"] = 360.0
        with self.assertRaisesRegex(gate.VerificationError, "native holdout preparation"):
            self.verify_case(value)

    def test_simultaneous_wrapper_raw_report_and_self_hash_forgery_has_no_native_anchor(self):
        value = case()
        forged_report = {"passed": True, "comparisonContract": {"baselinePassed": True}}
        forged_sha = digest(encode(forged_report))
        value["wrapper"]["comparisonReportSha256"] = forged_sha
        value["wrapper"]["comparisonEvidence"]["sha256"] = forged_sha
        value["wrapper"]["comparisonContract"]["baselinePassed"] = True
        value["wrapper"]["baselineVerification"]["baselinePassed"] = True
        forged_receipt = copy.deepcopy(value["native"])
        for field in ("comparisonReportSha256", "comparisonContract", "baselineVerification"):
            forged_receipt[field] = copy.deepcopy(value["wrapper"][field])
        value["wrapper"]["nativeExecution"]["qaReceiptSha256"] = digest(encode(forged_receipt))
        with self.assertRaisesRegex(gate.VerificationError, "receipt SHA differs"):
            self.verify_case(value)
        value["wrapper"]["nativeExecution"]["qaReceiptSha256"] = digest(value["receipt"])
        with self.assertRaisesRegex(gate.VerificationError, "wrapper changed native field"):
            self.verify_case(value)

    def test_forged_archive_and_wrapper_hashes_cannot_replace_the_github_digest(self):
        value = case()
        forged = copy.deepcopy(value["native"])
        forged["comparisonContract"]["baselinePassed"] = True
        value["archive"] = summary_zip(encode(forged))
        value["wrapper"]["nativeExecution"]["archiveSha256"] = digest(value["archive"])
        value["wrapper"]["nativeExecution"]["qaReceiptSha256"] = digest(encode(forged))
        with self.assertRaisesRegex(gate.VerificationError, "independent artifact digest"):
            self.verify_case(value)

    def test_wrong_run_attempt_code_branch_workflow_repo_or_failed_run_is_rejected(self):
        mutations = {
            "run": lambda r: r.update(id=RUN_ID + 1),
            "attempt": lambda r: r.update(run_attempt=2),
            "bool attempt": lambda r: r.update(run_attempt=True),
            "code": lambda r: r.update(head_sha="f" * 40),
            "head commit": lambda r: r["head_commit"].update(id="f" * 40),
            "branch": lambda r: r.update(head_branch="main"),
            "workflow": lambda r: r.update(path=".github/workflows/ci.yml"),
            "event": lambda r: r.update(event="pull_request"),
            "repo": lambda r: r["repository"].update(full_name="elsewhere/repo"),
            "fork": lambda r: r["head_repository"].update(id=REPO_ID + 1),
            "failed": lambda r: r.update(conclusion="failure"),
            "in progress": lambda r: r.update(status="in_progress"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = case(); mutate(value["run"])
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value)

    def test_wrong_candidate_code_or_manifest_cannot_be_relabelled(self):
        for field, changed in (("codeCommit", "f" * 40), ("manifestSha256", "f" * 64)):
            with self.subTest(field=field):
                value = case(); value["wrapper"]["candidate"][field] = changed
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value)

    def test_artifact_membership_identity_digest_size_and_expiry_are_required(self):
        mutations = {
            "id": lambda a: a.update(id=ARTIFACT_ID + 1),
            "name": lambda a: a.update(name="qa-summary-other"),
            "expired": lambda a: a.update(expired=True),
            "expiry missing": lambda a: a.pop("expired"),
            "size": lambda a: a.update(size_in_bytes=gate.MAX_ARCHIVE_BYTES + 1),
            "actual size": lambda a: a.update(size_in_bytes=a["size_in_bytes"] + 1),
            "digest": lambda a: a.update(digest="sha256:" + "f" * 64),
            "no digest": lambda a: a.pop("digest"),
            "URL": lambda a: a.update(archive_download_url=BLOB_URL),
            "run": lambda a: a["workflow_run"].update(id=RUN_ID + 1),
            "repo": lambda a: a["workflow_run"].update(repository_id=REPO_ID + 1),
            "head repo": lambda a: a["workflow_run"].update(head_repository_id=REPO_ID + 1),
            "head": lambda a: a["workflow_run"].update(head_sha="f" * 40),
            "branch": lambda a: a["workflow_run"].update(head_branch="main"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                value = case(); mutate(value["artifact"])
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value)

    def test_native_execution_flags_and_origin_must_succeed_independently_of_wrapper(self):
        mutations = {
            "automated false": lambda n: n.update(automatedChecksPassed=False),
            "failed status": lambda n: n.update(status="automated-checks-incomplete"),
            "native manual pass": lambda n: n.update(passed=True),
            "failed browser": lambda n: n["outcomes"].update(browser="failure"),
            "skipped physical": lambda n: n["outcomes"].update(physical="skipped"),
            "missing stage": lambda n: n["outcomes"].pop("holdout"),
            "run": lambda n: n["executionOrigin"].update(workflowRunId=RUN_ID + 1),
            "attempt": lambda n: n["executionOrigin"].update(workflowRunAttempt=2),
            "code": lambda n: n["executionOrigin"].update(codeCommit="f" * 40),
            "kind": lambda n: n["executionOrigin"].update(kind="local"),
            "repo": lambda n: n["executionOrigin"].update(repository="elsewhere/repo"),
            "baseline": lambda n: n.update(baselineCommit="f" * 40),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                native = native_receipt(); mutate(native)
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(case(native))

    def test_type_sensitive_equality_rejects_boolean_and_numeric_substitutions(self):
        for field, key, value in (("fixedVideo", "densityFps", 20.0),
                                  ("facePositionSizeTracking", "defaultEnabled", 1),
                                  ("baselineVerification", "baselinePassed", 0)):
            with self.subTest(field=field, key=key):
                changed = case(); changed["wrapper"][field][key] = value
                with self.assertRaisesRegex(gate.VerificationError, "wrapper changed native field"):
                    self.verify_case(changed)

    def test_receipt_sha_and_actual_download_digest_are_checked(self):
        value = case(); value["wrapper"]["nativeExecution"]["qaReceiptSha256"] = "f" * 64
        with self.assertRaisesRegex(gate.VerificationError, "receipt SHA differs"):
            self.verify_case(value)
        value = case(); raw = bytearray(value["archive"]); raw[45] ^= 1; value["archive"] = bytes(raw)
        with self.assertRaisesRegex(gate.VerificationError, "Downloaded archive SHA"):
            self.verify_case(value)

    def test_comparison_reference_may_move_to_data_but_sha_or_unsafe_paths_are_rejected(self):
        mutations = ({"path": "data/catalog-quality/another-reviewed-name.json"},
                     {"sha256": "f" * 64}, {"path": "../comparison.json"},
                     {"path": "/data/comparison.json"}, {"path": "work/comparison.json"})
        for index, change in enumerate(mutations):
            with self.subTest(change=change):
                value = case(); value["wrapper"]["comparisonEvidence"].update(change)
                if index == 0:
                    self.verify_case(value)
                else:
                    with self.assertRaises(gate.VerificationError):
                        self.verify_case(value)

    def test_missing_or_ambiguous_artifact_and_pagination_are_fail_closed(self):
        value = case()
        for artifacts in ([], [value["artifact"], copy.deepcopy(value["artifact"])],
                          [value["artifact"], {**value["artifact"], "id": ARTIFACT_ID + 1}]):
            with self.subTest(count=len(artifacts)):
                client, opener = client_for(value)
                opener.routes[LIST_URL] = (200, encode({"total_count": len(artifacts), "artifacts": artifacts}), None)
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value, client)
        client, opener = client_for(value)
        extras = [{"id": index + 1, "name": "other-" + str(index)} for index in range(100)]
        opener.routes[LIST_URL] = (200, encode({"total_count": 101, "artifacts": extras}), None)
        second = LIST_URL[:-1] + "2"
        opener.routes[second] = (200, encode({"total_count": 101, "artifacts": [value["artifact"]]}), None)
        result, _ = self.verify_case(value, client)
        self.assertEqual(result["status"], "verified")
        self.assertIn(second, [request["url"] for request in opener.requests])
        opener.routes[second] = (200, encode({"total_count": 101, "artifacts": []}), None)
        with self.assertRaisesRegex(gate.VerificationError, "pagination is incomplete"):
            self.verify_case(value, client)

    def test_invalid_or_oversized_wrapper_and_missing_pin_are_rejected(self):
        mutations = (lambda w: w.pop("nativeExecution"),
                     lambda w: w["nativeExecution"].update(runId=True),
                     lambda w: w["nativeExecution"].update(artifactName="unbound-summary"),
                     lambda w: w["nativeExecution"].update(archiveSha256="bad"))
        for mutate in mutations:
            value = case(); mutate(value["wrapper"])
            with self.assertRaises(gate.VerificationError):
                self.verify_case(value)
        with tempfile.TemporaryDirectory() as directory:
            qa = Path(directory) / "qa.json"
            qa.write_bytes(b"{" + b" " * 500 + b"}")
            with mock.patch.object(gate, "MAX_ARCHIVE_BYTES", 128):
                with self.assertRaisesRegex(gate.VerificationError, "wrapper exceeds"):
                    gate.bounded_file(qa)

    def test_main_emits_one_verified_json_and_saves_exact_native_evidence(self):
        value = case(); client, _ = client_for(value)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); qa = root / "qa.json"; qa.write_bytes(encode(value["wrapper"]))
            output = io.StringIO()
            argv = ["verify_clean_core_native_qa.py", "--qa", str(qa), "--repository", gate.REPOSITORY,
                    "--evidence-dir", str(root / "evidence")]
            with mock.patch.object(sys, "argv", argv), mock.patch.object(gate, "GitHubClient", return_value=client), mock.patch.object(sys, "stdout", output):
                self.assertEqual(gate.main(), 0)
            result = json.loads(output.getvalue())
            self.assertEqual(result["status"], "verified")
            self.assertEqual((root / "evidence/native-qa-receipt.json").read_bytes(), value["receipt"])


class NativeRemediationVerificationTests(unittest.TestCase):
    # Reuse only the network-faked harness. The complete original independent-
    # 360 suite remains above and runs once, without duplicated test cases.
    verify_case = NativeQAVerificationTests.verify_case

    def test_remediation_preserves_failed_holdout_and_verifies_only_native_preparation(self):
        value = case(remediation_native_receipt())
        result, _ = self.verify_case(value)
        self.assertEqual(result["visualReviewMode"], "remediation")
        self.assertEqual(result["matchedFields"], list(gate.IMMUTABLE_FIELDS))
        self.assertEqual(len(result["matchedFields"]), 14)
        self.assertEqual(result["matchedRemediationFields"], ["visualReviewPreparation", "selectedPhotoHoldout"])
        self.assertEqual(result["preparedHoldout"], value["native"]["selectedPhotoHoldout"])
        self.assertEqual(result["preparedHoldout"]["status"], "failed")
        self.assertEqual(result["preparedHoldout"]["counts"], {"pass": 301, "deny": 27, "uncertain": 32})
        self.assertEqual(result["visualReviewPreparation"], value["native"]["visualReviewPreparation"])
        self.assertEqual(result["remediationIndexSha256"], "7" * 64)
        self.assertIs(result["manualReviewVerified"], False)
        # The separate original-image review gate may attach later judgment;
        # this helper never upgrades that judgment or the old failed holdout.
        value["wrapper"]["laterManualReview"] = {"status": "pending"}
        self.assertIs(self.verify_case(value)[0]["manualReviewVerified"], False)

    def test_remediation_markers_and_evidence_must_be_present_on_both_sides(self):
        for side in ("native", "wrapper"):
            for field in ("visualReviewPreparation", "remediationEvidence"):
                for action in ("missing", "null"):
                    with self.subTest(side=side, field=field, action=action):
                        if side == "native":
                            native = remediation_native_receipt()
                            if action == "missing": native.pop(field)
                            else: native[field] = None
                            value = case(native)
                        else:
                            value = case(remediation_native_receipt())
                            if action == "missing": value["wrapper"].pop(field)
                            else: value["wrapper"][field] = None
                        with self.assertRaises(gate.VerificationError):
                            self.verify_case(value)
        # A regular independent receipt cannot gain a remediation claim later.
        for field in ("visualReviewPreparation", "remediationEvidence"):
            value = case(); value["wrapper"][field] = remediation_native_receipt()[field]
            with self.assertRaisesRegex(gate.VerificationError, "one-sided"):
                self.verify_case(value)

    def test_unknown_modes_extra_schema_fields_and_independent_claims_are_rejected(self):
        mutations = (
            lambda p: p.update(mode="independent"),
            lambda p: p.update(mode="remediation-passed"),
            lambda p: p.update(mode=None),
            lambda p: p.update(independentFinalHoldout=True),
            lambda p: p.update(independentFinalHoldout=0),
            lambda p: p.update(independentFinalHoldout=None),
            lambda p: p.update(preparationMayReplaceHoldout=True),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                native = remediation_native_receipt(); mutate(native["visualReviewPreparation"])
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(case(native))

    def test_remediation_added_count_is_an_integer_between_one_and_70000(self):
        for count in (1, 59, 70000):
            with self.subTest(valid=count):
                native = remediation_native_receipt(); native["visualReviewPreparation"]["addedPhotos"] = count
                result, _ = self.verify_case(case(native))
                self.assertEqual(result["visualReviewPreparation"]["addedPhotos"], count)
        for count in (0, -1, 70001, True, False, 59.0, "59", None):
            with self.subTest(invalid=count):
                native = remediation_native_receipt(); native["visualReviewPreparation"]["addedPhotos"] = count
                with self.assertRaisesRegex(gate.VerificationError, "added-photo count"):
                    self.verify_case(case(native))

    def test_original_failed_holdout_cannot_become_passed_even_inside_native_receipt(self):
        changes = {
            "status": "passed", "checkedPhotos": 359, "preparedPhotos": 359,
            "counts": {"pass": 360, "deny": 0, "uncertain": 0},
            "previouslyInspectedSha256": "4" * 64, "previouslyInspectedImageCount": 1618,
            "sampleIndexSha256": "4" * 64, "visualReviewSha256": "4" * 64,
            "humanVerified": True,
        }
        for field, changed in changes.items():
            for side in ("native", "wrapper"):
                with self.subTest(field=field, side=side):
                    if side == "native":
                        native = remediation_native_receipt(); native["selectedPhotoHoldout"][field] = changed
                        value = case(native)
                    else:
                        value = case(remediation_native_receipt()); value["wrapper"]["selectedPhotoHoldout"][field] = changed
                    with self.assertRaises(gate.VerificationError):
                        self.verify_case(value)

    def test_entire_failed_holdout_and_preparation_are_type_sensitive_immutable_objects(self):
        edits = (
            ("selectedPhotoHoldout", "checkedPhotos", 360.0),
            ("selectedPhotoHoldout", "counts", {"pass": 301.0, "deny": 27, "uncertain": 32}),
            ("selectedPhotoHoldout", "reviewer", "a different reviewer"),
            ("selectedPhotoHoldout", "newManualNote", "This belongs to a different review document"),
            ("visualReviewPreparation", "addedPhotos", 59.0),
            ("visualReviewPreparation", "addedPhotos", 60),
            ("visualReviewPreparation", "indexSha256", "6" * 64),
        )
        for section, field, changed in edits:
            with self.subTest(section=section, field=field):
                value = case(remediation_native_receipt()); value["wrapper"][section][field] = changed
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value)
        for field, changed in (("checkedPhotos", 360.0), ("counts", {"pass": 301, "deny": 27.0, "uncertain": 32})):
            native = remediation_native_receipt(); native["selectedPhotoHoldout"][field] = changed
            with self.assertRaisesRegex(gate.VerificationError, "original failed holdout"):
                self.verify_case(case(native))

    def test_evaluated_run_manifest_failed_review_and_final_manifest_are_fixed(self):
        changes = (
            ("evaluatedCandidateRunId", gate.REMEDIATION_EVALUATED_RUN_ID + 1),
            ("evaluatedCandidateRunId", float(gate.REMEDIATION_EVALUATED_RUN_ID)),
            ("evaluatedManifestSha256", "1" * 64),
            ("failedHoldoutSha256", "1" * 64),
            ("finalManifestSha256", "1" * 64),
            ("finalManifestSha256", "bad"),
            ("indexSha256", "bad"),
            ("indexPath", "reports/a-different-index.json"),
        )
        for field, changed in changes:
            with self.subTest(field=field, changed=changed):
                native = remediation_native_receipt(); native["visualReviewPreparation"][field] = changed
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(case(native))
        native = remediation_native_receipt()
        native["visualReviewPreparation"]["finalManifestSha256"] = gate.REMEDIATION_EVALUATED_MANIFEST_SHA256
        native["candidate"]["manifestSha256"] = gate.REMEDIATION_EVALUATED_MANIFEST_SHA256
        native["physicalAdmission"]["manifestSha256"] = gate.REMEDIATION_EVALUATED_MANIFEST_SHA256
        with self.assertRaisesRegex(gate.VerificationError, "replacement candidate"):
            self.verify_case(case(native))

    def test_remediation_evidence_only_allows_a_safe_data_path_move_with_exact_native_sha(self):
        value = case(remediation_native_receipt())
        value["wrapper"]["remediationEvidence"]["path"] = "data/catalog-quality/final-remediation-index.json"
        self.verify_case(value)
        for path in ("reports/remediation-index.json", "work/remediation-index.json", "../index.json",
                     "/data/index.json", "data/../index.json", "data//index.json", "data/index.csv"):
            with self.subTest(path=path):
                value = case(remediation_native_receipt()); value["wrapper"]["remediationEvidence"]["path"] = path
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value)
        for side in ("native", "wrapper"):
            for field, changed in (("sha256", "1" * 64), ("extra", "unsupported")):
                with self.subTest(side=side, field=field):
                    if side == "native":
                        native = remediation_native_receipt(); native["remediationEvidence"][field] = changed
                        value = case(native)
                    else:
                        value = case(remediation_native_receipt()); value["wrapper"]["remediationEvidence"][field] = changed
                    with self.assertRaises(gate.VerificationError):
                        self.verify_case(value)
        native = remediation_native_receipt(); native["remediationEvidence"]["path"] = "data/index.json"
        with self.assertRaisesRegex(gate.VerificationError, "native remediation index path"):
            self.verify_case(case(native))

    def test_remediation_cannot_bypass_any_original_immutable_or_failed_automatic_stage(self):
        for field in gate.IMMUTABLE_FIELDS:
            with self.subTest(field=field):
                value = case(remediation_native_receipt()); value["wrapper"][field] = {"forged": True}
                with self.assertRaises(gate.VerificationError):
                    self.verify_case(value)
        for stage in gate.OUTCOME_FIELDS:
            with self.subTest(stage=stage):
                native = remediation_native_receipt(); native["outcomes"][stage] = "failure"
                with self.assertRaisesRegex(gate.VerificationError, "required native QA stage"):
                    self.verify_case(case(native))
        native = remediation_native_receipt(); native["automatedChecksPassed"] = False
        with self.assertRaisesRegex(gate.VerificationError, "automated checks"):
            self.verify_case(case(native))

    def test_forged_remediation_index_and_self_hash_have_no_native_archive_anchor(self):
        value = case(remediation_native_receipt())
        forged = copy.deepcopy(value["native"])
        for document in (value["wrapper"], forged):
            document["visualReviewPreparation"].update(indexSha256="1" * 64, addedPhotos=1)
            document["remediationEvidence"]["sha256"] = "1" * 64
        value["wrapper"]["nativeExecution"]["qaReceiptSha256"] = digest(encode(forged))
        with self.assertRaisesRegex(gate.VerificationError, "receipt SHA differs"):
            self.verify_case(value)
        value["wrapper"]["nativeExecution"]["qaReceiptSha256"] = digest(value["receipt"])
        with self.assertRaisesRegex(gate.VerificationError, "changed native remediation preparation"):
            self.verify_case(value)


class SummaryZipTests(unittest.TestCase):
    def test_only_root_receipt_is_read_and_other_regular_members_are_not_extracted(self):
        receipt = b'{"status":"test fixture"}\n'
        archive = summary_zip(receipt, [("nested/other.json", b"unrelated bytes")])
        self.assertEqual(gate.read_summary_receipt(archive), receipt)

    def test_bad_paths_duplicate_names_and_symlinks_are_rejected(self):
        for name in ("../outside.json", "/absolute.json", "a/../../escape.json", "a//b.json",
                     "a/./b.json", "..\\outside.json", "C:/outside.json", "qa-receipt.json"):
            with self.subTest(name=name):
                with self.assertWarns(UserWarning) if name == "qa-receipt.json" else mock.patch.object(sys, "stderr", io.StringIO()):
                    archive = summary_zip(b"{}", [(name, b"{}")])
                with self.assertRaises(gate.VerificationError):
                    gate.read_summary_receipt(archive)
        symlink = zipfile.ZipInfo("shortcut"); symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(gate.VerificationError, "symlink"):
            gate.read_summary_receipt(summary_zip(b"{}", [(symlink, b"/tmp/outside")]))

    def test_missing_root_receipt_and_invalid_crc_are_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zipped:
            zipped.writestr("summary/qa-receipt.json", b"{}")
        with self.assertRaisesRegex(gate.VerificationError, "missing root"):
            gate.read_summary_receipt(buffer.getvalue())
        raw = bytearray(summary_zip(b'{"fixture":true}'))
        start = raw.index(b'{"fixture":true}')
        raw[start] ^= 1
        with self.assertRaisesRegex(gate.VerificationError, "Invalid summary ZIP"):
            gate.read_summary_receipt(bytes(raw))

    def test_archive_size_expansion_and_member_limits_are_enforced(self):
        self.assertEqual(gate.MAX_ARCHIVE_BYTES, 32 * 1024 * 1024)
        with self.assertRaisesRegex(gate.VerificationError, "byte limit"):
            gate.read_summary_receipt(summary_zip(b"{}"), maximum=16)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr("qa-receipt.json", b" " * 2000)
        self.assertLess(len(buffer.getvalue()), 512)
        with self.assertRaisesRegex(gate.VerificationError, "entry exceeds"):
            gate.read_summary_receipt(buffer.getvalue(), maximum=512)
        extras = [("empty-" + str(index), b"") for index in range(gate.MAX_ZIP_MEMBERS)]
        with self.assertRaisesRegex(gate.VerificationError, "member count"):
            gate.read_summary_receipt(summary_zip(b"{}", extras))

    def test_json_duplicate_keys_nonfinite_numbers_and_nonobjects_are_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e9999}', b'[]'):
            with self.subTest(raw=raw):
                with self.assertRaises(gate.VerificationError):
                    gate.strict_json(raw, "fixture")


class NativeTransportTests(unittest.TestCase):
    def test_cross_host_redirect_strips_bearer_and_never_readds_it(self):
        return_url = API_PREFIX + "/actions/redirected-download"
        opener = FakeOpener({ARCHIVE_URL: (302, b"", {"Location": BLOB_URL}),
                             BLOB_URL: (307, b"", {"Location": return_url}),
                             return_url: (200, b"ZIP-test", None)})
        client = gate.GitHubClient("a-secret-token", opener)
        self.assertEqual(client.archive(ARCHIVE_URL[len(gate.API_ROOT):]), b"ZIP-test")
        self.assertEqual(opener.requests[0]["headers"]["authorization"], "Bearer a-secret-token")
        for request in opener.requests[1:]:
            self.assertNotIn("authorization", request["headers"])
            self.assertNotIn("a-secret-token", json.dumps(request))
        self.assertIsNone(gate.NoAutomaticRedirect().redirect_request(None, None, 302, "", {}, BLOB_URL))

    def test_metadata_redirects_and_unsafe_download_redirects_are_rejected(self):
        for target in ("http://artifact.example.invalid/file", "file:///tmp/qa.json",
                       "https://user:password@artifact.example.invalid/file", "https://artifact.example.invalid:444/file"):
            with self.subTest(target=target):
                opener = FakeOpener({ARCHIVE_URL: (302, b"", {"Location": target})})
                with self.assertRaises(gate.VerificationError):
                    gate.GitHubClient("token", opener).archive(ARCHIVE_URL[len(gate.API_ROOT):])
                self.assertEqual(len(opener.requests), 1)
        opener = FakeOpener({RUN_URL: (302, b"", {"Location": BLOB_URL})})
        with self.assertRaisesRegex(gate.VerificationError, "Unexpected redirect"):
            gate.GitHubClient("token", opener).json(RUN_URL[len(gate.API_ROOT):])

    def test_content_length_and_stream_limit_stop_oversized_downloads(self):
        cases = ((b"", {"Content-Length": str(gate.MAX_ARCHIVE_BYTES + 1)}, gate.MAX_ARCHIVE_BYTES),
                 (b"x" * 100, {}, 10), (b"short", {"Content-Length": "20"}, 20))
        for body, headers, limit in cases:
            with self.subTest(headers=headers, limit=limit):
                opener = FakeOpener({ARCHIVE_URL: (200, body, headers)})
                with self.assertRaises(gate.VerificationError):
                    gate.GitHubClient("token", opener).get(ARCHIVE_URL, maximum=limit)

    def test_http_rejection_never_prints_token_presigned_url_or_server_body(self):
        opener = FakeOpener({ARCHIVE_URL: (302, b"", {"Location": BLOB_URL}),
                             BLOB_URL: (403, b"secret-token from server", {})})
        with self.assertRaises(gate.VerificationError) as caught:
            gate.GitHubClient("secret-token", opener).archive(ARCHIVE_URL[len(gate.API_ROOT):])
        self.assertIn("HTTP 403", str(caught.exception))
        self.assertNotIn("secret-token", str(caught.exception))
        self.assertNotIn("signature", str(caught.exception))
        self.assertEqual(len(opener.requests), 2, "Rejected requests must not be retried or bypassed")

    def test_stream_read_failure_does_not_leak_redirect_location_or_credentials(self):
        response = Response(b"", headers={})
        response.read = mock.Mock(side_effect=urllib.error.URLError(BLOB_URL + "&token=secret"))
        with self.assertRaises(gate.VerificationError) as caught:
            gate.GitHubClient.read_body(response, 100)
        self.assertEqual(str(caught.exception), "Native GitHub response body could not be read")


if __name__ == "__main__":
    unittest.main()
