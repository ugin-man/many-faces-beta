"""Small ZIPs and fake networks only; these tests are not native candidate QA."""
from __future__ import annotations

import copy
from email.message import Message
import hashlib
import http.client
import io
import json
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import fetch_clean_core_evaluated_candidate as fetch

TOKEN = "test-token-never-forwarded"
SIGNED = "https://storage.example.invalid/candidate.zip?signature=do-not-log"
RUN_URL = f"{fetch.API_ROOT}/actions/runs/{fetch.RUN_ID}/attempts/{fetch.RUN_ATTEMPT}"
ARTIFACT_URL = f"{fetch.API_ROOT}/actions/artifacts/{fetch.ARTIFACT_ID}"
DOWNLOAD_URL = ARTIFACT_URL + "/zip"


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def entry(name, raw=b"fixture", *, kind=stat.S_IFREG, compression=zipfile.ZIP_STORED):
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = (kind | 0o644) << 16
    info.compress_type = compression
    return info, raw


def zipped(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, raw in entries:
            archive.writestr(name, raw)
    return output.getvalue()


class Fixture:
    def __init__(self, *, manifest_change=None, generation_change=None, extras=(), omit=()):
        # Deliberately tiny fabricated content. Only in-memory test patches
        # replace the archive/content hashes; the real CLI has no overrides.
        self.selection = encode({"fixtureOnly": True, "notAPhysicalCatalog": True})
        manifest = {"catalogId": "offline-fixture-only", "totalFaces": 70000, "sourceFaces": 70000,
                    "searchableFaces": 70000,
                    "qualityAdmission": {"schemaVersion": 2, "status": "complete", "selectedCount": 70000,
                                         "runtimeExclusionOverlayRequired": False, "receiptSha256": "a" * 64}}
        if manifest_change:
            manifest_change(manifest)
        self.manifest = encode(manifest)
        generation = {"schemaVersion": 1, "artifactPurpose": "physical-catalog-candidate-for-review",
                      "workflowRunId": fetch.RUN_ID, "workflowRunAttempt": fetch.RUN_ATTEMPT,
                      "builtFromCommit": fetch.CODE_COMMIT, "targetTotal": 70000,
                      "runtimeExclusionOverlayRequired": False, "published": False,
                      "candidateManifestSha256": digest(self.manifest), "candidateAuditSha256": "a" * 64,
                      "selection": {"codeCommit": fetch.CODE_COMMIT, "selectionAuditSha256": digest(self.selection)}}
        if generation_change:
            generation_change(generation)
        self.generation = encode(generation)
        self.entries = [
            entry("catalog/", b"", kind=stat.S_IFDIR),
            entry("catalog/manifest.json", self.manifest),
            entry("catalog/clean-core-audit.json", self.selection),
            entry("catalog/packs/faces.bin", b"sample-image-bytes\x00\xff"),
            entry("provenance/candidate-receipt.json", self.generation),
            entry("provenance/source.json", encode({"fixture": True})),
            entry("selection/audit.json", self.selection),
            entry("admission/records.sqlite", b"not-real-db" * 20000, compression=zipfile.ZIP_DEFLATED),
            entry("wink-support/v1/catalog.json", b"not extracted"),
            entry("catalog-backup/ignored.bin", b"not a selected prefix"),
        ]
        self.entries = [item for item in self.entries if item[0].filename not in omit] + list(extras)
        self.raw = zipped(self.entries)

    def overrides(self):
        return {"ARCHIVE_BYTES": len(self.raw), "ARCHIVE_SHA256": digest(self.raw),
                "MANIFEST_SHA256": digest(self.manifest), "GENERATION_RECEIPT_SHA256": digest(self.generation)}


def run_metadata():
    repo = {"id": fetch.REPOSITORY_ID, "full_name": fetch.REPOSITORY}
    return {"id": fetch.RUN_ID, "run_attempt": fetch.RUN_ATTEMPT, "workflow_id": fetch.WORKFLOW_ID,
            "status": "completed", "conclusion": "success", "head_sha": fetch.CODE_COMMIT,
            "head_commit": {"id": fetch.CODE_COMMIT}, "head_branch": fetch.BRANCH, "path": fetch.WORKFLOW_PATH,
            "event": "push", "repository": copy.deepcopy(repo), "head_repository": copy.deepcopy(repo)}


def artifact_metadata():
    return {"id": fetch.ARTIFACT_ID, "name": fetch.ARTIFACT_NAME, "size_in_bytes": fetch.ARCHIVE_BYTES,
            "digest": "sha256:" + fetch.ARCHIVE_SHA256, "expired": False, "url": ARTIFACT_URL,
            "archive_download_url": DOWNLOAD_URL,
            "workflow_run": {"id": fetch.RUN_ID, "repository_id": fetch.REPOSITORY_ID,
                             "head_repository_id": fetch.REPOSITORY_ID, "head_sha": fetch.CODE_COMMIT,
                             "head_branch": fetch.BRANCH}}


class Response(io.BytesIO):
    def __init__(self, raw=b"", *, status=200, headers=None, fault=None):
        super().__init__(raw)
        self.status = status
        self.headers = Message()
        for key, value in ({"Content-Length": str(len(raw))} if headers is None else headers).items():
            self.headers[key] = str(value)
        self.fault = fault
        self.read_sizes = []

    def getcode(self):
        return self.status

    def read(self, size=-1):
        self.read_sizes.append(size)
        if self.fault:
            raise self.fault
        # Exercise many partial reads, without allocating the real 3.4 GB ZIP.
        return super().read(min(size, 8192) if size >= 0 else size)


class Opener:
    def __init__(self, routes):
        self.routes = {url: value if isinstance(value, list) else [value] for url, value in routes.items()}
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if request.full_url not in self.routes or not self.routes[request.full_url]:
            raise AssertionError("Unexpected fake request: " + request.full_url)
        value = self.routes[request.full_url].pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


def change_path(document, dotted, value):
    parts = dotted.split(".")
    current = document
    for key in parts[:-1]:
        current = current[key]
    current[parts[-1]] = value


class EvaluatedCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.counter = 0

    def exercise(self, fixture=None, *, fails=False, run_change=None, artifact_change=None,
                 body=None, download_response=None, metadata_raw=None, redirects=None, limits=None):
        fixture = fixture or Fixture()
        self.counter += 1
        base = self.root / str(self.counter)
        out, report = base / "prior", base / "reports/evidence.json"
        with mock.patch.multiple(fetch, **{**fixture.overrides(), **(limits or {})}):
            run, artifact = run_metadata(), artifact_metadata()
            if run_change:
                change_path(run, *run_change)
            if artifact_change:
                change_path(artifact, *artifact_change)
            body = fixture.raw if body is None else body
            raw_response = download_response or Response(body)
            routes = {RUN_URL: Response(encode(run) if metadata_raw is None else metadata_raw),
                      ARTIFACT_URL: Response(encode(artifact)), DOWNLOAD_URL: Response(status=302, headers={"Location": SIGNED}),
                      SIGNED: raw_response}
            if redirects:
                routes.update(redirects)
            opener = Opener(routes)
            if fails:
                with self.assertRaises(fetch.FetchError):
                    fetch.fetch_candidate(out, report, fetch.GitHubClient(TOKEN, opener))
                self.assertFalse(out.exists())
            else:
                fetch.fetch_candidate(out, report, fetch.GitHubClient(TOKEN, opener))
                self.assertTrue(out.is_dir())
            result = json.loads(report.read_text())
            self.assertEqual(result["status"], "failed" if fails else "passed")
            self.assertEqual(list(base.rglob("*.zip")), [])
            self.assertFalse(any(p.name.startswith("evaluated-candidate-") for p in base.iterdir()))
            self.assertNotIn(TOKEN, report.read_text())
            self.assertNotIn("signature=", report.read_text())
        return result, out, opener

    def test_production_pins_are_exact_and_not_cli_options(self):
        self.assertEqual(fetch.RUN_ID, 37491677036)
        self.assertEqual(fetch.RUN_ATTEMPT, 1)
        self.assertEqual(fetch.CODE_COMMIT, "c92fba37022b46bbf0f69b75bd7f011ae9d55297")
        self.assertEqual(fetch.ARTIFACT_ID, 11426800117)
        self.assertEqual(fetch.ARTIFACT_NAME, "clean-core-v5-candidate-37491677036-1")
        self.assertEqual(fetch.ARCHIVE_BYTES, 3428205738)
        self.assertEqual(fetch.ARCHIVE_SHA256, "923b59d9b59ca4ba7ac54bb7660731d5fe89ac81495438f3ed098db705bd1f1c")
        self.assertEqual(fetch.MANIFEST_SHA256, "d8265b8077187e7c08e5e4b4a6c39d5999155f1ff0c02bff2160842b97cb5785")
        self.assertEqual(fetch.GENERATION_RECEIPT_SHA256, "79c8f68790b11414cdb8b88e9ec2aeb2665d6747e99a7dd51690bb5824ec505f")
        with mock.patch("sys.stderr", new=io.StringIO()), self.assertRaises(SystemExit) as error:
            fetch.main(["--out", "unused", "--report", "unused.json", "--run-id", "1"])
        self.assertEqual(error.exception.code, 2)

    def test_complete_success_keeps_only_three_roots_and_binds_each_extracted_file(self):
        fixture = Fixture()
        result, out, opener = self.exercise(fixture)
        self.assertEqual({p.name for p in out.iterdir()}, {"catalog", "provenance", "selection"})
        self.assertEqual((out / "selection/audit.json").read_bytes(), fixture.selection)
        self.assertEqual((out / "catalog/clean-core-audit.json").read_bytes(), fixture.selection)
        for item in result["extraction"]["extractedFiles"]:
            raw = (out / item["path"]).read_bytes()
            self.assertEqual((len(raw), digest(raw)), (item["bytes"], item["sha256"]))
        self.assertTrue(result["completeArchiveSha256VerifiedBeforeExtraction"])
        self.assertTrue(result["archiveRemoved"])
        self.assertFalse(result["physicalCatalogRevalidatedByThisDownloader"])
        self.assertFalse(result["extraction"]["skippedMemberPayloadsDecompressed"])
        self.assertTrue(all(r.get_method() == "GET" for r in opener.requests))
        self.assertEqual([r.full_url for r in opener.requests], [RUN_URL, ARTIFACT_URL, DOWNLOAD_URL, SIGNED])

    def test_authentication_is_removed_on_every_redirect_even_back_to_github(self):
        fixture = Fixture()
        second = "https://other.example.invalid/file?signature=another"
        back = fetch.API_ROOT + "/actions/unsigned-fixture"
        redirects = {SIGNED: Response(status=307, headers={"Location": second}),
                     second: Response(status=303, headers={"Location": back}), back: Response(fixture.raw)}
        _result, _out, opener = self.exercise(fixture, redirects=redirects)
        for request in opener.requests[:3]:
            self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        for request in opener.requests[3:]:
            headers = {key.lower(): value for key, value in request.header_items()}
            self.assertFalse({"authorization", "cookie", "referer"} & headers.keys())
        self.assertEqual(opener.requests[-1].full_url, back)

    def test_real_http_error_redirect_is_handled_without_forwarding_token(self):
        headers = Message()
        headers["Location"] = SIGNED
        redirect = urllib.error.HTTPError(DOWNLOAD_URL, 302, "Found", headers, io.BytesIO())
        _result, _out, opener = self.exercise(redirects={DOWNLOAD_URL: redirect})
        self.assertIsNone(opener.requests[-1].get_header("Authorization"))

    def test_run_identity_changes_fail_before_any_archive_request(self):
        changes = [("id", 1), ("run_attempt", True), ("run_attempt", 2), ("workflow_id", 1),
                   ("status", "in_progress"), ("conclusion", "failure"), ("head_sha", "b" * 40),
                   ("head_commit.id", "b" * 40), ("head_branch", "main"), ("path", ".github/workflows/other.yml"),
                   ("repository.full_name", "other/repo"), ("repository.id", 1), ("head_repository.id", 2),
                   ("head_repository.full_name", "other/fork"), ("event", "pull_request")]
        for change in changes:
            with self.subTest(change=change):
                result, _out, opener = self.exercise(fails=True, run_change=change)
                self.assertEqual(result["stage"], "metadata")
                self.assertEqual([r.full_url for r in opener.requests], [RUN_URL])

    def test_artifact_origin_size_digest_and_urls_are_all_bound(self):
        changes = [("id", 2), ("name", "replacement"), ("size_in_bytes", 1), ("expired", 0),
                   ("expired", True), ("digest", "sha256:" + "e" * 64), ("url", SIGNED),
                   ("archive_download_url", SIGNED), ("workflow_run.id", 1), ("workflow_run.repository_id", 1),
                   ("workflow_run.head_repository_id", 1), ("workflow_run.head_branch", "main"),
                   ("workflow_run.head_sha", "a" * 40)]
        for change in changes:
            with self.subTest(change=change):
                result, _out, opener = self.exercise(fails=True, artifact_change=change)
                self.assertEqual(result["stage"], "metadata")
                self.assertNotIn(DOWNLOAD_URL, [r.full_url for r in opener.requests])

    def test_metadata_rejects_duplicate_keys_nonfinite_values_arrays_and_oversize(self):
        for raw in [b'{"id":1,"id":2}', b'{"bad":NaN}', b'{"bad":Infinity}', b'{"bad":1e999}', b'[]', b'not-json']:
            with self.subTest(raw=raw):
                self.exercise(fails=True, metadata_raw=raw)
        self.exercise(fails=True, metadata_raw=b" " * 100, limits={"MAX_API_BYTES": 50})

    def test_metadata_redirect_is_never_followed(self):
        _result, _out, opener = self.exercise(fails=True, redirects={RUN_URL: Response(status=302, headers={"Location": SIGNED})})
        self.assertEqual(len(opener.requests), 1)

    def test_unsafe_storage_redirects_stop_before_network_followup(self):
        locations = ["http://storage.example.invalid/file", "https://user:password@storage.example.invalid/file",
                     "https://storage.example.invalid:444/file", "https://storage.example.invalid/file#fragment",
                     "https://[broken", "https://storage.example.invalid/\nsecret", "file:///tmp/payload", ""]
        for location in locations:
            with self.subTest(location=location):
                _result, _out, opener = self.exercise(fails=True, redirects={DOWNLOAD_URL: Response(status=302, headers={"Location": location})})
                self.assertEqual(len(opener.requests), 3)

    def test_redirect_loops_are_bounded_and_unsigned(self):
        repeated = [Response(status=302, headers={"Location": SIGNED}) for _ in range(fetch.MAX_REDIRECTS + 1)]
        _result, _out, opener = self.exercise(fails=True, redirects={SIGNED: repeated})
        self.assertEqual(len(opener.requests), 2 + fetch.MAX_REDIRECTS + 1)
        self.assertTrue(all(r.get_header("Authorization") is None for r in opener.requests[3:]))

    def test_download_rejects_oversize_truncation_encoding_and_bad_headers(self):
        fixture = Fixture()
        responses = [Response(fixture.raw + b"extra", headers={}), Response(fixture.raw[:-1], headers={}),
                     Response(fixture.raw, headers={"Content-Length": str(len(fixture.raw) + 1)}),
                     Response(fixture.raw, headers={"Content-Length": "-1"}),
                     Response(fixture.raw, headers={"Content-Length": "9" * 100}),
                     Response(fixture.raw, headers={"Content-Encoding": "gzip"}),
                     Response(fixture.raw, status=206)]
        for response in responses:
            with self.subTest(headers=str(response.headers), status=response.status):
                result, _out, _opener = self.exercise(fixture, fails=True, download_response=response)
                self.assertEqual(result["stage"], "complete-archive-download")

    def test_bytes_changed_even_in_skipped_database_fail_before_zip_inspection(self):
        fixture = Fixture()
        changed = bytearray(fixture.raw)
        with zipfile.ZipFile(io.BytesIO(changed)) as archive:
            info = archive.getinfo("admission/records.sqlite")
            start = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
        changed[start] ^= 1
        with mock.patch.object(fetch, "extract_candidate", wraps=fetch.extract_candidate) as extract:
            result, _out, _opener = self.exercise(fixture, fails=True, body=bytes(changed))
            extract.assert_not_called()
        self.assertIn("SHA256", result["error"])

    def test_network_errors_cannot_leak_token_signed_url_or_response_body(self):
        for error in (urllib.error.URLError(TOKEN + " " + SIGNED), http.client.IncompleteRead(TOKEN.encode(), 100)):
            failure = Response(headers={}, fault=error)
            result, _out, _opener = self.exercise(fails=True, download_response=failure)
            self.assertEqual(result["error"], "GitHub response body could not be read")
        error = urllib.error.HTTPError(SIGNED, 403, TOKEN, Message(), io.BytesIO(TOKEN.encode()))
        result, _out, _opener = self.exercise(fails=True, redirects={SIGNED: error})
        self.assertEqual(result["error"], "GitHub request failed with HTTP 403")

    def test_all_member_paths_are_checked_including_skipped_prefixes(self):
        names = ["../escape", "/absolute", "catalog/../escape", "admission/../../escape", "catalog//double",
                 "catalog/./dot", "catalog\\windows", "C:/drive", "admission/control\nname"]
        for name in names:
            with self.subTest(name=name):
                result, _out, _opener = self.exercise(Fixture(extras=[entry(name)]), fails=True)
                self.assertEqual(result["stage"], "zip-validation-and-extraction")

    def test_duplicate_and_parent_file_collisions_are_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            fixtures = [Fixture(extras=[entry("catalog/manifest.json", b"duplicate")]),
                        Fixture(extras=[entry("catalog/packs", b"parent file")]),
                        Fixture(extras=[entry("admission", b"skipped parent file")])]
        for fixture in fixtures:
            self.exercise(fixture, fails=True)

    def test_nonregular_or_inconsistent_modes_are_rejected_even_when_skipped(self):
        extras = [entry("admission/link", b"/etc/passwd", kind=stat.S_IFLNK),
                  entry("catalog/pipe", b"", kind=stat.S_IFIFO),
                  entry("admission/not-directory", b"", kind=stat.S_IFDIR),
                  entry("catalog/not-regular/", b"", kind=stat.S_IFREG)]
        for extra in extras:
            self.exercise(Fixture(extras=[extra]), fails=True)

    def test_nul_filename_and_skipped_local_header_mismatch_are_rejected(self):
        fixture = Fixture(extras=[entry("admission/nameX.bin")])
        fixture.raw = fixture.raw.replace(b"nameX.bin", b"name\x00.bin")
        self.exercise(fixture, fails=True)
        fixture = Fixture()
        raw = bytearray(fixture.raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            offset = archive.getinfo("admission/records.sqlite").header_offset + 30
        raw[offset] = ord("b")
        fixture.raw = bytes(raw)
        self.exercise(fixture, fails=True)

    def test_encrypted_and_unsupported_compression_entries_are_rejected(self):
        fixture = Fixture(extras=[entry("admission/encrypted.bin")])
        raw = bytearray(fixture.raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            offset = archive.getinfo("admission/encrypted.bin").header_offset
        struct.pack_into("<H", raw, offset + 6, 1)
        name = b"admission/encrypted.bin"
        central_name = raw.rfind(name)
        struct.pack_into("<H", raw, central_name - 46 + 8, 1)
        fixture.raw = bytes(raw)
        self.exercise(fixture, fails=True)
        self.exercise(Fixture(extras=[entry("admission/compressed.bin", compression=zipfile.ZIP_BZIP2)]), fails=True)

    def test_expansion_and_member_limits_include_skipped_database(self):
        fixture = Fixture()
        self.exercise(fixture, fails=True, limits={"MAX_EXPANDED_BYTES": 10000})
        self.exercise(fixture, fails=True, limits={"MAX_MEMBERS": len(fixture.entries) - 1})

    def test_streaming_zip64_headers_and_response_without_length_are_supported(self):
        class NonSeekable(io.BytesIO):
            def seek(self, *args):
                raise OSError("fixture stream is not seekable")

        fixture = Fixture()
        output = NonSeekable()
        with zipfile.ZipFile(output, "w", allowZip64=True) as archive:
            for info, raw in fixture.entries:
                with archive.open(info, "w", force_zip64=True) as member:
                    member.write(raw)
        fixture.raw = output.getvalue()
        with zipfile.ZipFile(io.BytesIO(fixture.raw)) as archive:
            self.assertTrue(any(info.flag_bits & 8 for info in archive.infolist()))
        result, _out, _opener = self.exercise(fixture, download_response=Response(fixture.raw, headers={}))
        self.assertEqual(result["status"], "passed")

    def test_report_creation_is_complete_and_never_overwrites_an_existing_file(self):
        path = self.root / "report.json"
        fetch.write_report(path, {"status": "passed", "fixtureOnly": True})
        original = path.read_bytes()
        with self.assertRaises(FileExistsError):
            fetch.write_report(path, {"status": "replacement"})
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(json.loads(original), {"status": "passed", "fixtureOnly": True})
        self.assertEqual(list(self.root.glob("candidate-report-*")), [])

    def test_selected_file_crc_failure_rolls_back_partial_extraction(self):
        fixture = Fixture()
        raw = bytearray(fixture.raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            info = archive.getinfo("catalog/packs/faces.bin")
            offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
        raw[offset] ^= 1
        fixture.raw = bytes(raw)  # Fake archive pin permits reaching the internal CRC check.
        result, _out, _opener = self.exercise(fixture, fails=True)
        self.assertEqual(result["stage"], "zip-validation-and-extraction")

    def test_all_required_prefix_payloads_must_be_present(self):
        for path in ("catalog/manifest.json", "catalog/clean-core-audit.json", "provenance/candidate-receipt.json", "selection/audit.json"):
            with self.subTest(path=path):
                self.exercise(Fixture(omit=[path]), fails=True)

    def test_manifest_and_generation_raw_bytes_remain_independently_pinned(self):
        for target in ("catalog/manifest.json", "provenance/candidate-receipt.json"):
            fixture = Fixture()
            fixture.entries = [(info, raw + b" " if info.filename == target else raw) for info, raw in fixture.entries]
            fixture.raw = zipped(fixture.entries)
            result, _out, _opener = self.exercise(fixture, fails=True)
            self.assertEqual(result["stage"], "fixed-content-bindings")

    def test_receipt_semantics_cannot_be_replaced_by_a_success_shaped_small_fixture(self):
        mutations = [("schemaVersion", True), ("workflowRunId", 1), ("workflowRunAttempt", 2),
                     ("builtFromCommit", "b" * 40), ("published", True), ("targetTotal", 69999),
                     ("candidateAuditSha256", "b" * 64), ("runtimeExclusionOverlayRequired", True),
                     ("selection.selectionAuditSha256", "b" * 64), ("selection.codeCommit", "b" * 40)]
        for dotted, value in mutations:
            with self.subTest(field=dotted):
                fixture = Fixture(generation_change=lambda doc: change_path(doc, dotted, value))
                self.exercise(fixture, fails=True)

    def test_physical_manifest_count_and_complete_stamp_are_required(self):
        for dotted, value in [("totalFaces", 69999), ("sourceFaces", 69999), ("searchableFaces", 69999),
                              ("qualityAdmission.status", "pending"), ("qualityAdmission.schemaVersion", True),
                              ("qualityAdmission.selectedCount", 69999), ("qualityAdmission.runtimeExclusionOverlayRequired", True)]:
            with self.subTest(field=dotted):
                self.exercise(Fixture(manifest_change=lambda doc: change_path(doc, dotted, value)), fails=True)

    def test_selection_copy_mismatch_is_detected(self):
        fixture = Fixture()
        fixture.entries = [(info, b"different copy" if info.filename == "catalog/clean-core-audit.json" else raw) for info, raw in fixture.entries]
        fixture.raw = zipped(fixture.entries)
        self.exercise(fixture, fails=True)

    def test_existing_paths_and_symlink_ancestors_are_never_overwritten(self):
        existing = self.root / "existing"
        existing.mkdir()
        sentinel = existing / "user.txt"
        sentinel.write_text("keep")
        link = self.root / "link"
        link.symlink_to(existing, target_is_directory=True)
        dangling = self.root / "dangling"
        dangling.symlink_to(self.root / "missing")
        report = self.root / "existing-report.json"
        report.write_text("keep report")
        paths = [(existing, self.root / "a.json"), (link / "output", self.root / "b.json"),
                 (dangling, self.root / "c.json"), (self.root / "new", report),
                 (self.root / "inside", self.root / "inside/report.json")]
        opener = Opener({})
        for out, report_path in paths:
            with self.subTest(out=out), self.assertRaises(fetch.FetchError):
                fetch.fetch_candidate(out, report_path, fetch.GitHubClient(TOKEN, opener))
        self.assertEqual(opener.requests, [])
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual(report.read_text(), "keep report")

    def test_token_validation_and_noncanonical_initial_url_never_make_requests(self):
        for token in ("", "with space", "line\nfeed", "unicode-☃"):
            with self.subTest(token=token), self.assertRaises(fetch.FetchError):
                fetch.GitHubClient(token, Opener({}))
        opener = Opener({})
        with self.assertRaises(fetch.FetchError):
            with fetch.GitHubClient(TOKEN, opener).response(SIGNED):
                self.fail("Unexpected network response")
        self.assertEqual(opener.requests, [])


if __name__ == "__main__":
    unittest.main()
