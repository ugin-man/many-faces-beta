"""Execute the actual QA packaging heredoc against tiny synthetic evidence.

Only the comparison-contract subprocess is stubbed. These are stdlib packaging
integration tests, not native browser, model-inference, 70k admission or visual
review results. The genuine comparison validator has its own behavioral tests.
"""
import contextlib
import copy
import gzip
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
PROJECT = TESTS.parent
sys.path.insert(0, str(TESTS))
from test_verify_clean_core_native_qa import native_receipt, remediation_native_receipt


def packaging_python():
    """Extract the named real step without a YAML dependency or a code copy."""
    path = PROJECT / ".github/workflows/clean-core-v5-qa.yml"
    lines = path.read_text().splitlines()
    marker = "      - name: Package factual reports and bounded review artifacts"
    if lines.count(marker) != 1:
        raise AssertionError("The real QA packaging step is missing or ambiguous")
    start = lines.index(marker) + 1
    end = next((index for index in range(start, len(lines)) if lines[index].startswith("      - name:")), len(lines))
    step = lines[start:end]
    beginnings = [index for index, line in enumerate(step) if line == "          python - <<'PY'"]
    if len(beginnings) != 1:
        raise AssertionError("Expected one actual Python packaging heredoc")
    begin = beginnings[0] + 1
    finish = next((index for index in range(begin, len(step)) if step[index] == "          PY"), None)
    if finish is None or any(line and not line.startswith(" " * 10) for line in step[begin:finish]):
        raise AssertionError("The actual packaging heredoc has an unexpected terminator or indentation")
    return "\n".join(line[10:] if line else "" for line in step[begin:finish]) + "\n"


def encoded_png(number):
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xffffffff)
    pixels = b"\0" + bytes((number % 256, number // 256, 127)) * 2
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels * 2)) + chunk(b"IEND", b""))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, bytes):
        path.write_bytes(value)
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class QARemediationPackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = packaging_python()
        cls.code = compile(cls.source, str(PROJECT / ".github/workflows/clean-core-v5-qa.yml") + ":packaging", "exec")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cases = 0

    def fixture(self, *, mode="remediation", count=37):
        self.cases += 1
        work = self.root / f"case-{self.cases}"
        reports = work / "reports"
        native = remediation_native_receipt() if mode == "remediation" else native_receipt()
        pins = copy.deepcopy(native["candidate"])
        contract = copy.deepcopy(native["comparisonContract"])
        request = {"visualReview": {"mode": "remediation"}} if mode == "remediation" else {
            "previouslyInspected": {"sha256": "f" * 64}}
        write(work / "verified-request.json", {"request": request, "requestSha256": "b" * 64})
        write(work / "candidate-pins.json", pins)
        write(reports / "candidate-pins.json", pins)
        write(reports / "browser/launcher-report.json", {"passed": True, "mode": "admitted"})
        comparison = {"passed": True, "comparisonContract": contract, "fixtureSha256": native["fixedVideo"]["fixtureSha256"],
                      "baselineSource": native["baselineVerification"]["source"],
                      "comparison": {"sameAcquiredFrames": True, "sameTimeline": True, "selectedIdChanges": 20},
                      "trials": [
                          {"name": "baseline", "passed": False, "initialPresentationPassed": False, "remainingChecksPassed": True,
                           "knownInitialFailure": native["baselineVerification"]["knownInitialFailure"],
                           "initialRecovery": native["baselineVerification"]["initialRecovery"]},
                          {"name": "candidate", "passed": True, "initialPresentationPassed": True, "video": {"plannedFrames": 466}},
                      ]}
        write(reports / "browser/admitted-catalog/report.json", comparison)
        physical = {**copy.deepcopy(native["physicalAdmission"]),
                    "allSelectedProfilesHaveDeclaredEvidence": True, "allSelectedPhotosAbsentFromSelectionExclusions": True,
                    "allSelectedWinkProfilesHaveReviewedEvidence": True,
                    **{key: pins[key] for key in ("selectionReviewSha256", "selectionIdentitySha256", "winkExpressionReviewSha256")}}
        write(reports / "physical-admission.json", physical)
        write(reports / "browser/cancellation/cancellation.json", {"passed": True, "cancelToIdleMs": 10})
        write(reports / "browser/fullscreen/report.json", {"passed": True, "camera": {"phase": "running", "catalogTotal": 70000}})
        write(reports / "integrity.json", {"status": "passed", "fixtureOnly": True})
        # The archive must stay under reports and must not pick up candidate
        # packs, the admission DB, model bytes, or the large camera fixture.
        write(work / "candidate/catalog/packs/not-a-report.bin", b"not a report")
        write(work / "candidate/admission/records.sqlite", b"not a report")
        write(work / "models/attribute.onnx", b"not a report")
        write(reports / "fixtures/camera.y4m", b"not a report")
        review_root = work / ("remediation" if mode == "remediation" else "holdout")
        rows = []
        for number in range(1, count + 1):
            payload = encoded_png(number)
            sample = f"H{number:03d}"
            image_path = f"images/{sample}.png"
            row = {"sample": sample, "encodedSha256": sha(payload), "sourceCatalogId": "synthetic-packaging-fixture",
                   "sourceId": f"photo-{number}", "imagePath": image_path, "byteLength": len(payload),
                   "assistantReviewStatus": "pending", "bucket": "remediation-added" if mode == "remediation" else "random-control"}
            rows.append(row)
            write(review_root / image_path, payload)
        pages = []
        for start in range(0, count, 36):
            number = start // 36 + 1
            page_rows = rows[start:start + 36]
            contact = f"contact-{number:02d}.png"
            write(review_root / contact, encoded_png(1000 + number))
            page = {"path": contact, "samples": [row["sample"] for row in page_rows]}
            if mode == "remediation":
                path = f"page-index-{number:02d}.json"
                write(review_root / path, {"mode": "remediation", "samples": page_rows, "finalManifestSha256": pins["manifestSha256"]})
                raw = (review_root / path).read_bytes()
                page["index"] = {"path": path, "sha256": sha(raw), "bytes": len(raw)}
            pages.append(page)
        inventory_payloads = {}
        if mode == "remediation":
            inventories = []
            for name in ("prior-inventory.jsonl.gz", "final-inventory.jsonl.gz"):
                # Tiny complete synthetic inventory bytes for this packaging
                # fixture, not the actual 70,000-photo catalog inventory.
                raw = gzip.compress(b'{"fixture":true,"encodedSha256":"' + b"a" * 64 + b'"}\n', mtime=0)
                inventory_payloads[name] = raw
                write(review_root / name, raw)
                write(reports / "remediation-inventories" / name, raw)
                inventories.append({"path": name, "sha256": sha(raw), "bytes": len(raw), "rows": 1})
            index = {"schemaVersion": 1, "documentKind": "clean-core-remediation-index", "mode": "remediation",
                     "status": "pending-original-review", "independentHoldoutPassed": False,
                     "allKnownExcludedAbsent": True, "allPriorDenyAndUncertainAbsent": True,
                     "final": {"manifestSha256": pins["manifestSha256"]}, "selectionReviewSha256": pins["selectionReviewSha256"],
                     "added": rows, "pages": pages, "inventoryFiles": inventories}
            index_path = review_root / "remediation-index.json"
            write(index_path, index)
            index_sha = sha(index_path.read_bytes())
            preparation = {"mode": "remediation", "allAddedOriginalsExtracted": True, "allAddedOriginalsReviewed": False,
                           "addedPhotos": count, "indexSha256": index_sha, "finalManifestSha256": pins["manifestSha256"]}
            write(review_root / "visual-review-preparation.json", preparation)
            write(reports / "remediation-index.json", index_path.read_bytes())
            write(reports / "visual-review-preparation.json", preparation)
            failed = {"status": "failed", "counts": {"pass": 301, "deny": 27, "uncertain": 32}, "fixtureOnly": True}
            write(review_root / "original-failed-holdout.json", failed)
            write(reports / "original-failed-holdout.json", (review_root / "original-failed-holdout.json").read_bytes())
        else:
            index = {"sampleCount": count, "targetSamples": count, "seed": 20261007, "samples": rows, "pages": pages,
                     "manifestSha256": pins["manifestSha256"], "previouslyInspectedSha256": "f" * 64,
                     "previouslyInspectedImageCount": 1617, "assistantReviewStatus": "pending", "humanVerified": False}
            index_path = review_root / "sample-index.json"
            write(index_path, index)
            index_sha = sha(index_path.read_bytes())
        environment = {"QA_ROOT": str(work), "GITHUB_RUN_ID": "999000", "GITHUB_RUN_ATTEMPT": "1",
                       "GITHUB_REPOSITORY": "ugin-man/many-faces-beta", "GITHUB_SHA": "1" * 40,
                       "BASELINE_COMMIT": native["baselineCommit"], "RUNNER_OS": "Linux",
                       **{key.upper() + "_OUTCOME": "success" for key in native["outcomes"]}}
        return {"work": work, "reports": reports, "reviewRoot": review_root, "index": index, "indexPath": index_path,
                "indexSha256": index_sha, "rows": rows, "pins": pins, "contract": contract, "native": native,
                "environment": environment, "inventories": inventory_payloads}

    def execute(self, fixture, *, contract_failure=False):
        mock_options = {"side_effect": subprocess.CalledProcessError(1, ["node"], stderr="fixture contract failure")} if contract_failure else {
            "return_value": json.dumps(fixture["contract"])}
        output = io.StringIO()
        with patch.dict(os.environ, fixture["environment"], clear=False), patch("subprocess.check_output", **mock_options) as command:
            with contextlib.redirect_stdout(output):
                exec(self.code, {"__name__": "__main__"})
        command.assert_called_once_with(
            ["node", "scripts/clean-catalog-comparison-contract.mjs", str(fixture["reports"] / "browser/admitted-catalog/report.json")],
            text=True, stderr=subprocess.PIPE, timeout=30)
        return json.loads(output.getvalue().strip())

    def receipt(self, fixture):
        return json.loads((fixture["work"] / "bundles/summary/qa-receipt.json").read_bytes())

    def bundle_index(self, fixture):
        return json.loads((fixture["work"] / "bundles/summary/bundle-index.json").read_bytes())

    def test_real_packaging_binds_nine_native_preparation_fields_and_keeps_failed_360(self):
        fixture = self.fixture()
        result = self.execute(fixture)
        receipt = self.receipt(fixture)
        expected = copy.deepcopy(fixture["native"]["visualReviewPreparation"])
        expected.update(addedPhotos=37, indexSha256=fixture["indexSha256"])
        self.assertEqual(receipt["visualReviewPreparation"], expected)
        self.assertEqual(len(receipt["visualReviewPreparation"]), 9)
        self.assertEqual(receipt["selectedPhotoHoldout"], fixture["native"]["selectedPhotoHoldout"])
        self.assertTrue(receipt["automatedChecksPassed"])
        self.assertFalse(receipt["passed"])
        self.assertFalse(receipt["promotionReady"])
        self.assertEqual(receipt["status"], "automated-checks-passed-visual-review-pending")
        self.assertEqual(result["visualReviewMode"], "remediation")
        self.assertEqual(result["originalsPrepared"], 37)
        self.assertEqual(result["originalPages"], 2)
        self.assertEqual(receipt["baselineVerification"]["status"], "known-initial-drawing-failure")
        self.assertFalse(receipt["baselineVerification"]["baselinePassed"])
        self.assertEqual(receipt["remediationEvidence"], {"path": "reports/remediation-index.json", "sha256": fixture["indexSha256"]})

    def test_every_added_original_and_both_page_indexes_keep_exact_hashes_and_scope(self):
        fixture = self.fixture(count=73)
        self.execute(fixture)
        bundles = fixture["work"] / "bundles"
        complete = []
        for number, page in enumerate(fixture["index"]["pages"], 1):
            directory = bundles / f"holdout-{number:02d}"
            wrapper = json.loads((directory / "page-index.json").read_bytes())
            self.assertEqual(wrapper["mode"], "remediation")
            self.assertEqual(wrapper["reviewIndexSha256"], fixture["indexSha256"])
            self.assertEqual(wrapper["remediationIndexSha256"], fixture["indexSha256"])
            self.assertEqual(wrapper["manifestSha256"], fixture["pins"]["manifestSha256"])
            self.assertNotIn("sampleIndexSha256", wrapper)
            self.assertEqual((directory / page["index"]["path"]).read_bytes(),
                             (fixture["reviewRoot"] / page["index"]["path"]).read_bytes())
            self.assertEqual(wrapper["page"], page)
            for row in wrapper["samples"]:
                raw = (directory / row["imagePath"]).read_bytes()
                self.assertEqual(raw, (fixture["reviewRoot"] / row["imagePath"]).read_bytes())
                self.assertEqual(sha(raw), row["encodedSha256"])
                self.assertEqual(len(raw), row["byteLength"])
                complete.append(row)
        self.assertEqual(complete, fixture["rows"])
        self.assertEqual(len({row["encodedSha256"] for row in complete}), 73)
        self.assertEqual((bundles / "summary/remediation-index.json").read_bytes(), fixture["indexPath"].read_bytes())
        self.assertEqual(sha((bundles / "summary/remediation-index.json").read_bytes()), self.receipt(fixture)["visualReviewPreparation"]["indexSha256"])

    def test_complete_gz_inventories_are_in_the_report_archive_without_large_nonreports(self):
        fixture = self.fixture(count=2)
        self.execute(fixture)
        work = fixture["work"]
        bundle = self.bundle_index(fixture)
        archive = bundle["reportArchive"]
        parts = []
        for number, item in enumerate(archive["parts"], 1):
            payload = (work / f"bundles/reports-{number:02d}" / item["path"]).read_bytes()
            self.assertEqual(sha(payload), item["sha256"])
            self.assertEqual(len(payload), item["bytes"])
            parts.append(payload)
        payload = b"".join(parts)
        self.assertEqual(sha(payload), archive["sha256"])
        self.assertEqual(payload, (work / archive["path"]).read_bytes())
        listed = json.loads((work / "bundles/summary/report-files.json").read_bytes())
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as packed:
            names = packed.getnames()
            self.assertEqual(names, [entry["path"] for entry in listed])
            for entry in listed:
                raw = packed.extractfile(entry["path"]).read()
                self.assertEqual(sha(raw), entry["sha256"])
                self.assertEqual(len(raw), entry["bytes"])
            for name, raw in fixture["inventories"].items():
                path = "reports/remediation-inventories/" + name
                self.assertIn(path, names)
                self.assertEqual(packed.extractfile(path).read(), raw)
                self.assertEqual(gzip.decompress(raw).count(b"\n"), 1)
            self.assertFalse(any("fixtures/" in name or name.endswith((".sqlite", ".onnx", ".bin", ".y4m")) for name in names))
        self.assertFalse(bundle["containsCandidateCatalogOrAdmissionDatabase"])

    def test_missing_preparation_or_any_failed_required_stage_stays_automatically_incomplete(self):
        missing = self.fixture(count=2)
        (missing["reviewRoot"] / "visual-review-preparation.json").unlink()
        self.assertFalse(self.execute(missing)["automatedChecksPassed"])
        self.assertFalse(self.receipt(missing)["automatedChecksPassed"])
        for stage in fixture_stages():
            fixture = self.fixture(count=2)
            fixture["environment"][stage.upper() + "_OUTCOME"] = "failure"
            with self.subTest(stage=stage):
                self.assertFalse(self.execute(fixture)["automatedChecksPassed"])
                self.assertFalse(self.receipt(fixture)["automatedChecksPassed"])
                self.assertEqual(self.receipt(fixture)["selectedPhotoHoldout"]["status"], "failed")

    def test_missing_or_changed_native_index_copy_or_preparation_sha_cannot_pass(self):
        for change in ("missing-copy", "changed-copy", "changed-index", "wrong-preparation-sha"):
            fixture = self.fixture(count=2)
            if change == "missing-copy":
                (fixture["reports"] / "remediation-index.json").unlink()
            elif change == "changed-copy":
                write(fixture["reports"] / "remediation-index.json", {"forged": True})
            elif change == "changed-index":
                changed = copy.deepcopy(fixture["index"])
                changed["note"] = "changed after preparation"
                write(fixture["indexPath"], changed)
            else:
                path = fixture["reviewRoot"] / "visual-review-preparation.json"
                changed = json.loads(path.read_bytes())
                changed["indexSha256"] = "0" * 64
                write(path, changed)
            with self.subTest(change=change):
                self.assertFalse(self.execute(fixture)["automatedChecksPassed"])
                self.assertFalse(self.receipt(fixture)["automatedChecksPassed"])

    def test_missing_original_or_changed_encoded_bytes_fail_before_that_page_is_uploadable(self):
        for change in ("missing", "modified"):
            fixture = self.fixture(count=2)
            path = fixture["reviewRoot"] / fixture["rows"][0]["imagePath"]
            if change == "missing":
                path.unlink()
            else:
                write(path, b"modified encoded original")
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "Missing holdout|original hash changed"):
                self.execute(fixture)
            self.assertFalse((fixture["work"] / "bundles/holdout-01").exists())
            self.assertTrue((fixture["work"] / "bundles/summary/qa-receipt.json").is_file())

    def test_more_than_ten_pages_fails_explicitly_without_sampling_or_uploading_ten(self):
        fixture = self.fixture(count=361)
        self.assertEqual(len(fixture["index"]["pages"]), 11)
        with self.assertRaisesRegex(ValueError, "exceeds ten bounded pages.*without sampling or truncation"):
            self.execute(fixture)
        self.assertEqual(len(list((fixture["reviewRoot"] / "images").iterdir())), 361)
        self.assertEqual(list((fixture["work"] / "bundles").glob("holdout-*")), [])
        receipt = self.receipt(fixture)
        self.assertEqual(receipt["visualReviewPreparation"]["addedPhotos"], 361)
        self.assertFalse(receipt["passed"])
        self.assertFalse(receipt["promotionReady"])

    def test_legacy_independent_360_path_remains_compatible_and_pending(self):
        fixture = self.fixture(mode="independent", count=360)
        result = self.execute(fixture)
        receipt = self.receipt(fixture)
        self.assertTrue(receipt["automatedChecksPassed"])
        self.assertNotIn("visualReviewPreparation", receipt)
        self.assertNotIn("remediationEvidence", receipt)
        self.assertEqual(receipt["selectedPhotoHoldout"]["status"], "pending")
        self.assertEqual(receipt["selectedPhotoHoldout"]["preparedPhotos"], 360)
        self.assertEqual(receipt["selectedPhotoHoldout"]["checkedPhotos"], 0)
        self.assertEqual(receipt["selectedPhotoHoldout"]["sampleIndexSha256"], fixture["indexSha256"])
        self.assertEqual(result["visualReviewMode"], "independent-holdout")
        self.assertEqual(result["originalPages"], 10)
        count = 0
        for page in sorted((fixture["work"] / "bundles").glob("holdout-*")):
            value = json.loads((page / "page-index.json").read_bytes())
            self.assertEqual(value["mode"], "independent-holdout")
            self.assertEqual(value["sampleIndexSha256"], fixture["indexSha256"])
            self.assertNotIn("remediationIndexSha256", value)
            count += len(value["samples"])
        self.assertEqual(count, 360)

    def test_failed_contract_or_candidate_initial_presentation_is_not_hidden_by_new_mode(self):
        failed_contract = self.fixture(count=2)
        self.assertFalse(self.execute(failed_contract, contract_failure=True)["automatedChecksPassed"])
        self.assertEqual(self.receipt(failed_contract)["comparisonContractValidation"]["status"], "not-passed")
        self.assertIn("fixture contract failure", self.receipt(failed_contract)["comparisonContractValidation"]["error"])
        fixture = self.fixture(count=2)
        path = fixture["reports"] / "browser/admitted-catalog/report.json"
        report = json.loads(path.read_bytes())
        report["trials"][1]["initialPresentationPassed"] = False
        write(path, report)
        self.assertFalse(self.execute(fixture)["automatedChecksPassed"])
        self.assertFalse(self.receipt(fixture)["facePositionSizeTracking"]["initialPresentationPassed"])
        self.assertEqual(self.receipt(fixture)["fixedVideo"]["status"], "not-passed")

    def test_report_archive_allows_only_the_two_named_gz_inventories(self):
        fixture = self.fixture(count=2)
        write(fixture["reports"] / "unbound-inventory.jsonl.gz", gzip.compress(b"unbound binary"))
        with self.assertRaisesRegex(ValueError, "Unexpected binary in the report-only archive"):
            self.execute(fixture)


def fixture_stages():
    return tuple(native_receipt()["outcomes"])


if __name__ == "__main__":
    unittest.main()
