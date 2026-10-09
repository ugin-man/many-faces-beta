"""Exercise the actual promotion routing with small exact-image review fixtures.

Git tracking and the already verified native receipt are explicit test inputs.
The supplemental helper runs for real. These tests are neither native Actions
authentication nor a browser run; those have separate mandatory gates.
"""
from __future__ import annotations

import ast
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import unittest
from unittest import mock

import test_clean_core_remediation_review as fixtures


PROJECT = Path(__file__).resolve().parents[1]


def workflow_program():
    source = (PROJECT / ".github/workflows/clean-core-v5-promote.yml").read_text()
    start = source.index("      - name: Verify request, candidate QA and successful candidate run\n")
    start = source.index("          python - <<'PY'\n", start) + len("          python - <<'PY'\n")
    end = source.index("          PY\n", start)
    program = ast.parse("\n".join(line[10:] for line in source[start:end].splitlines()))
    functions = {"require", "unique_object", "bad_constant", "read_json", "sha256", "valid_sha",
                 "tracked_file", "verify_reference"}
    definitions = [node for node in program.body if isinstance(node, ast.FunctionDef) and node.name in functions]
    def assignment(node, name):
        return isinstance(node, ast.Assign) and any(isinstance(item, ast.Name) and item.id == name for item in node.targets)
    first = next(number for number, node in enumerate(program.body) if assignment(node, "holdout"))
    last = next(number for number, node in enumerate(program.body[first:], first) if assignment(node, "run"))
    return compile(ast.Module(body=[*definitions, *program.body[first:last]], type_ignores=[]),
                   "clean-core-v5-promote.yml:original-review-gate", "exec")


class PromotionOriginalReviewWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.program = workflow_program()

    def setUp(self):
        self.fixture = fixtures.RemediationTests("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.prepare()
        self.root = self.fixture.root
        self.data = self.root / "data/catalog-quality"
        self.data.mkdir(parents=True)
        self.index_path = self.data / "remediation-index.json"
        shutil.copyfile(self.fixture.index_path, self.index_path)
        self.review_path, self.review = self.fixture.image_review(filename="data/catalog-quality/added-originals.json")
        self.comparison_path = self.data / "comparison.json"
        self.comparison_path.write_text('{"testFixtureOnly":true}\n')
        self.comparison_reference = self.reference(self.comparison_path)
        self.evidence = self.root / "work/promotion-evidence"
        self.evidence.mkdir(parents=True)
        self.candidate = {"manifestSha256": self.fixture.final["manifestSha256"]}
        self.preparation = {
            "mode": "remediation", "indexSha256": self.fixture.index_sha,
            "addedPhotos": 2, "finalManifestSha256": self.candidate["manifestSha256"],
            "evaluatedManifestSha256": self.fixture.prior["manifestSha256"],
            "failedHoldoutSha256": fixtures.remediation.REFERENCE["failedHoldoutSha256"],
        }
        self.native = {"visualReviewMode": "remediation", "visualReviewPreparation": self.preparation,
                       "remediationIndexSha256": self.fixture.index_sha}
        self.qa = {
            "selectedPhotoHoldout": {"status": "failed", "reviewer": "assistant visual inspection",
                                     "humanVerified": False, "checkedPhotos": 360, "preparedPhotos": 360,
                                     "counts": {"pass": 301, "deny": 27, "uncertain": 32}},
            "physicalCameraVerified": False,
            "remediationEvidence": self.reference(self.index_path),
            "remediationReview": {"status": "complete", "reviewer": "assistant-visual-review", "humanVerified": False},
        }
        self.refresh_review()
        self.calls = []

    def reference(self, path):
        return {"path": path.relative_to(self.root).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def refresh_review(self, verify=True, extra=()):
        self.fixture.write(self.review_path, self.review)
        self.qa["remediationReview"]["reviews"] = [self.reference(self.review_path)]
        if verify:
            self.qa["remediationReview"]["verification"] = fixtures.remediation.verify_index(
                self.index_path, self.fixture.index_sha, self.candidate["manifestSha256"], [self.review_path])
        self.qa["evidence"] = [self.comparison_reference, self.qa["remediationEvidence"],
                               self.reference(self.review_path), *extra]

    def tracked(self, arguments, **options):
        self.assertEqual(arguments[:3], ["git", "ls-files", "--error-unmatch"])
        self.assertTrue(options.get("check"))
        return subprocess.CompletedProcess(arguments, 0)

    def supplemental(self, arguments, **options):
        self.assertEqual(Path(arguments[1]).name, "clean_core_remediation_review.py")
        self.assertEqual(arguments[2], "verify-index")
        self.calls.append(list(arguments))
        def value(flag):
            return arguments[arguments.index(flag) + 1]
        reviews = [Path(arguments[number + 1]) for number, item in enumerate(arguments) if item == "--review"]
        result = fixtures.remediation.verify_index(
            Path(value("--index")), value("--native-index-sha256"), value("--final-manifest-sha256"),
            reviews, Path(value("--out")))
        return json.dumps(result)

    def execute(self):
        shutil.rmtree(self.evidence / "remediation", ignore_errors=True)
        namespace = {"root": self.root, "evidence": self.evidence, "qa": self.qa,
                     "candidate": self.candidate, "native_qa": self.native,
                     "physical": {"selectionReviewSha256": self.fixture.index["selectionReviewSha256"]},
                     "comparison_reference": self.comparison_reference, "Path": Path, "PurePosixPath": PurePosixPath,
                     "json": json, "hashlib": hashlib, "re": re, "subprocess": subprocess}
        with mock.patch.object(subprocess, "run", side_effect=self.tracked), \
             mock.patch.object(subprocess, "check_output", side_effect=self.supplemental):
            exec(self.program, namespace)
        return namespace

    def test_all_originals_use_the_native_index_anchor_and_preserve_failed_holdout(self):
        original = copy.deepcopy(self.qa["selectedPhotoHoldout"])
        result = self.execute()
        self.assertEqual(self.qa["selectedPhotoHoldout"], original)
        self.assertEqual(result["remediation_verification"]["reviewedPhotos"], 2)
        self.assertFalse(result["remediation_verification"]["independentHoldoutPassed"])
        self.assertEqual(result["reviewed_files"], [self.reference(self.review_path)])
        self.assertEqual(self.calls[0][self.calls[0].index("--native-index-sha256") + 1], self.native["remediationIndexSha256"])
        self.assertTrue((self.evidence / "remediation/remediation-verification.json").is_file())

    def test_missing_uncertain_denied_or_contact_only_original_cannot_complete(self):
        original = copy.deepcopy(self.review)
        changes = [lambda document: document["reviews"].pop(),
                   lambda document: document["reviews"][0].update(decision="deny"),
                   lambda document: document["reviews"][0].update(decision="uncertain"),
                   lambda document: document["reviews"][0].update(viewedOriginal=False),
                   lambda document: document.update(scope="wink-side-only")]
        for number, change in enumerate(changes):
            with self.subTest(change=number):
                self.review = copy.deepcopy(original)
                change(self.review)
                self.refresh_review(verify=False)
                with self.assertRaises(ValueError):
                    self.execute()

    def test_native_count_manifest_and_index_cannot_be_replaced_by_local_claims(self):
        baseline = copy.deepcopy(self.native)
        mutations = [lambda native: native.update(remediationIndexSha256="f" * 64),
                     lambda native: native["visualReviewPreparation"].update(addedPhotos=3),
                     lambda native: native["visualReviewPreparation"].update(finalManifestSha256="f" * 64),
                     lambda native: native["visualReviewPreparation"].update(failedHoldoutSha256="f" * 64)]
        for number, mutation in enumerate(mutations):
            with self.subTest(change=number):
                self.native = copy.deepcopy(baseline)
                mutation(self.native)
                with self.assertRaises(ValueError):
                    self.execute()

    def test_index_and_each_original_review_must_be_bound_as_committed_evidence(self):
        complete = copy.deepcopy(self.qa["evidence"])
        for omitted in (self.qa["remediationEvidence"], self.reference(self.review_path)):
            with self.subTest(omitted=omitted["path"]):
                self.qa["evidence"] = [item for item in complete if item != omitted]
                with self.assertRaises(ValueError):
                    self.execute()

    def test_wrapper_cannot_rewrite_recomputed_manual_result(self):
        baseline = copy.deepcopy(self.qa["remediationReview"]["verification"])
        for field, value in (("reviewedPhotos", 70000), ("allAddedPhotosPassed", 1), ("independentHoldoutPassed", True)):
            with self.subTest(field=field):
                self.qa["remediationReview"]["verification"] = {**baseline, field: value}
                with self.assertRaisesRegex(ValueError, "independently recomputed"):
                    self.execute()

    def test_original_failed_status_cannot_be_relabelled_as_passed(self):
        self.qa["selectedPhotoHoldout"]["status"] = "passed"
        with self.assertRaisesRegex(ValueError, "preserve.*failed"):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_reused_full_original_review_needs_its_committed_hash_reference(self):
        prior = self.data / "earlier-original-review.json"
        self.fixture.write(prior, {"schemaVersion": 1, "documentKind": fixtures.remediation.ORIGINAL_REVIEW_KIND,
            "scope": fixtures.remediation.REVIEW_SCOPE, "reviewer": "assistant-visual-review", "humanVerified": False,
            "reviews": [copy.deepcopy(self.review["reviews"][0])]})
        self.review["reviews"][0]["reusedFrom"] = {"path": prior.name, "sha256": self.reference(prior)["sha256"]}
        self.refresh_review()
        with self.assertRaisesRegex(ValueError, "Reused original-quality review is absent"):
            self.execute()
        self.refresh_review(extra=[self.reference(prior)])
        result = self.execute()
        self.assertEqual(result["remediation_verification"]["reusedOriginalReviews"], 1)

    def test_existing_independent_path_still_requires_360_actual_passes(self):
        self.native = {}
        self.qa.pop("remediationReview")
        self.qa.pop("remediationEvidence")
        self.qa["evidence"] = [self.comparison_reference]
        self.qa["selectedPhotoHoldout"]["status"] = "passed"
        self.assertIsNone(self.execute()["remediation_verification"])
        self.assertEqual(self.calls, [])
        for changes in ({"status": "failed"}, {"checkedPhotos": 359}, {"preparedPhotos": 359}, {"humanVerified": True}):
            baseline = copy.deepcopy(self.qa["selectedPhotoHoldout"])
            self.qa["selectedPhotoHoldout"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.execute()
            self.qa["selectedPhotoHoldout"] = baseline


if __name__ == "__main__":
    unittest.main()
