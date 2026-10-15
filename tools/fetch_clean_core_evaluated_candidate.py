#!/usr/bin/env python3
"""Fetch the one previously evaluated c92 candidate for a remediation comparison.

The CLI has no pin overrides. Only canonical GitHub Actions GET endpoints are
authenticated. The complete archive is streamed and independently hash-checked
before inspecting every ZIP member and extracting catalog/provenance/selection.
This retrieves prior evidence; it does not perform or replace physical admission
validation, visual review, browser QA, or publication.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib


REPOSITORY = "ugin-man/many-faces-beta"
REPOSITORY_ID = 1340833640
BRANCH = "astra/realtime-hardening"
WORKFLOW_PATH = ".github/workflows/clean-core-v5-candidate.yml"
WORKFLOW_ID = 376379082
RUN_ID = 37491677036
RUN_ATTEMPT = 1
CODE_COMMIT = "c92fba37022b46bbf0f69b75bd7f011ae9d55297"
ARTIFACT_ID = 11426800117
ARTIFACT_NAME = "clean-core-v5-candidate-37491677036-1"
ARCHIVE_BYTES = 3428205738
ARCHIVE_SHA256 = "923b59d9b59ca4ba7ac54bb7660731d5fe89ac81495438f3ed098db705bd1f1c"
MANIFEST_SHA256 = "d8265b8077187e7c08e5e4b4a6c39d5999155f1ff0c02bff2160842b97cb5785"
GENERATION_RECEIPT_SHA256 = "79c8f68790b11414cdb8b88e9ec2aeb2665d6747e99a7dd51690bb5824ec505f"
API_ROOT = "https://api.github.com/repos/" + REPOSITORY
API_VERSION = "2026-03-10"
MAX_API_BYTES = 2 * 1024**2
MAX_JSON_BYTES = 24 * 1024**2
MAX_MEMBERS = 100000
MAX_EXPANDED_BYTES = 10 * 1024**3
MAX_REDIRECTS = 5
MAX_DOWNLOAD_SECONDS = 1800
CHUNK_BYTES = 1024**2
SELECTED_ROOTS = frozenset(("catalog", "provenance", "selection"))
REDIRECT_CODES = frozenset((301, 302, 303, 307, 308))


class FetchError(RuntimeError):
    """A safe diagnostic message, never a credential or presigned URL."""


def require(value, message):
    if not value:
        raise FetchError(message)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "JSON contains a repeated key")
            result[key] = value
        return result

    def nonfinite(_value):
        raise FetchError("JSON contains a nonfinite number")

    def finite_float(value):
        number = float(value)
        require(math.isfinite(number), "JSON contains a nonfinite number")
        return number

    try:
        result = json.loads(raw, object_pairs_hook=unique, parse_constant=nonfinite, parse_float=finite_float)
    except (ValueError, UnicodeError, RecursionError):
        raise FetchError("Invalid candidate metadata JSON") from None
    require(isinstance(result, dict), "Candidate metadata must be a JSON object")
    return result


def pins():
    return {"repository": REPOSITORY, "runId": RUN_ID, "runAttempt": RUN_ATTEMPT,
            "codeCommit": CODE_COMMIT, "artifactId": ARTIFACT_ID, "artifactName": ARTIFACT_NAME,
            "archiveBytes": ARCHIVE_BYTES, "archiveSha256": ARCHIVE_SHA256,
            "manifestSha256": MANIFEST_SHA256, "generationReceiptSha256": GENERATION_RECEIPT_SHA256}


class NoAutomaticRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubClient:
    def __init__(self, token, opener=None):
        require(isinstance(token, str) and token and all(0x21 <= ord(c) <= 0x7e for c in token),
                "GH_TOKEN is required and must not contain whitespace")
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoAutomaticRedirect())

    @staticmethod
    def checked_url(url):
        require(isinstance(url, str) and bool(url) and not any(ord(c) <= 32 or ord(c) == 127 for c in url),
                "Invalid artifact redirect URL")
        try:
            parsed = urllib.parse.urlsplit(url)
            safe = (parsed.scheme == "https" and bool(parsed.hostname) and parsed.port in (None, 443)
                    and parsed.username is None and parsed.password is None and not parsed.fragment)
        except ValueError:
            raise FetchError("Invalid artifact redirect URL") from None
        require(safe, "Artifact redirects must use HTTPS without URL credentials")
        return parsed

    @contextmanager
    def response(self, url, *, redirects=False):
        require(self.checked_url(url).netloc == "api.github.com", "Requests must start at api.github.com")
        current = url
        for hop in range(MAX_REDIRECTS + 1):
            self.checked_url(current)
            headers = {"User-Agent": "many-faces-fixed-evaluated-candidate",
                       "Accept-Encoding": "identity"}
            if hop == 0:
                headers.update({"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION})
            request = urllib.request.Request(current, headers=headers, method="GET")
            if hop == 0:
                request.add_unredirected_header("Authorization", "Bearer " + self.token)
            try:
                response = self.opener.open(request, timeout=60)
            except urllib.error.HTTPError as error:
                if error.code not in REDIRECT_CODES:
                    code = error.code
                    error.close()
                    raise FetchError(f"GitHub request failed with HTTP {code}") from None
                response = error
            except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
                raise FetchError("GitHub network request failed") from None
            with response:
                status = response.getcode()
                if status in REDIRECT_CODES:
                    require(redirects, "Unexpected redirect for GitHub metadata")
                    location = response.headers.get("Location")
                    require(isinstance(location, str) and location, "Artifact redirect has no Location")
                    require(not any(ord(c) <= 32 or ord(c) == 127 for c in location), "Invalid artifact redirect URL")
                    try:
                        current = urllib.parse.urljoin(current, location)
                    except ValueError:
                        raise FetchError("Invalid artifact redirect URL") from None
                    self.checked_url(current)
                    continue
                require(status == 200, "GitHub response did not return HTTP 200")
                yield response
                return
        raise FetchError("Too many artifact redirects")

    @staticmethod
    def stream(response, output, *, maximum, exact=None):
        require(response.headers.get("Content-Encoding", "identity").lower() == "identity",
                "Unexpected encoded response body")
        length = response.headers.get("Content-Length")
        if length is not None:
            require(isinstance(length, str) and len(length) <= 20 and re.fullmatch(r"[0-9]+", length) is not None,
                    "Invalid response Content-Length")
            length = int(length)
            require(length <= maximum and (exact is None or length == exact),
                    "Response Content-Length differs from its bound")
        start, size, digest = time.monotonic(), 0, hashlib.sha256()
        while True:
            require(time.monotonic() - start <= MAX_DOWNLOAD_SECONDS, "Candidate download exceeded its time limit")
            try:
                block = response.read(min(CHUNK_BYTES, maximum + 1 - size))
            except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
                raise FetchError("GitHub response body could not be read") from None
            require(isinstance(block, bytes), "Invalid response body")
            if not block:
                break
            size += len(block)
            require(size <= maximum, "Response body exceeded its byte limit")
            digest.update(block)
            output.write(block)
        require((length is None or size == length) and (exact is None or size == exact),
                "Response body was truncated or has the wrong size")
        return {"bytes": size, "sha256": digest.hexdigest()}

    def json(self, endpoint):
        require(endpoint.startswith("/actions/"), "Unexpected GitHub metadata endpoint")
        output = io.BytesIO()
        with self.response(API_ROOT + endpoint) as response:
            self.stream(response, output, maximum=MAX_API_BYTES)
        return strict_json(output.getvalue())

    def download(self, path):
        created = False
        try:
            with self.response(f"{API_ROOT}/actions/artifacts/{ARTIFACT_ID}/zip", redirects=True) as response:
                with Path(path).open("xb") as output:
                    created = True
                    result = self.stream(response, output, maximum=ARCHIVE_BYTES, exact=ARCHIVE_BYTES)
            require(result["sha256"] == ARCHIVE_SHA256, "Complete archive SHA256 differs from its fixed GitHub digest")
            return result
        except Exception:
            if created:
                Path(path).unlink(missing_ok=True)
            raise


def validate_run(run):
    for key, expected in (("id", RUN_ID), ("run_attempt", RUN_ATTEMPT), ("workflow_id", WORKFLOW_ID)):
        require(type(run.get(key)) is int and run[key] == expected, "Candidate run identity differs: " + key)
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "The fixed candidate generation attempt did not succeed")
    require(run.get("head_sha") == CODE_COMMIT and isinstance(run.get("head_commit"), dict)
            and run["head_commit"].get("id") == CODE_COMMIT, "The candidate used different source code")
    require(run.get("head_branch") == BRANCH and run.get("path") == WORKFLOW_PATH,
            "The candidate used another branch or workflow")
    require(run.get("event") in ("push", "workflow_dispatch"), "Unexpected candidate workflow event")
    for key in ("repository", "head_repository"):
        repo = run.get(key)
        require(isinstance(repo, dict) and repo.get("full_name") == REPOSITORY
                and type(repo.get("id")) is int and repo["id"] == REPOSITORY_ID,
                "The candidate belongs to another repository or fork")
    return {key: run[key] for key in ("id", "run_attempt", "workflow_id", "head_sha", "head_branch",
                                     "path", "event", "status", "conclusion")}


def validate_artifact(artifact):
    for key, expected in (("id", ARTIFACT_ID), ("size_in_bytes", ARCHIVE_BYTES)):
        require(type(artifact.get(key)) is int and artifact[key] == expected, "Candidate artifact identity differs: " + key)
    require(artifact.get("name") == ARTIFACT_NAME and artifact.get("expired") is False
            and artifact.get("digest") == "sha256:" + ARCHIVE_SHA256, "Candidate artifact is expired or has a different digest/name")
    endpoint = f"{API_ROOT}/actions/artifacts/{ARTIFACT_ID}"
    require(artifact.get("url") == endpoint and artifact.get("archive_download_url") == endpoint + "/zip",
            "Candidate artifact URLs are not canonical")
    origin = artifact.get("workflow_run")
    require(isinstance(origin, dict), "Candidate artifact lacks its originating workflow")
    for key, expected in (("id", RUN_ID), ("repository_id", REPOSITORY_ID), ("head_repository_id", REPOSITORY_ID)):
        require(type(origin.get(key)) is int and origin[key] == expected, "Candidate artifact origin differs: " + key)
    require(origin.get("head_sha") == CODE_COMMIT and origin.get("head_branch") == BRANCH,
            "Candidate artifact origin differs from the fixed source/branch")
    return {key: artifact[key] for key in ("id", "name", "size_in_bytes", "digest", "expired", "url", "archive_download_url", "workflow_run")}


def checked_members(archive):
    members = archive.infolist()
    require(0 < len(members) <= MAX_MEMBERS, "Candidate ZIP has too many members or is empty")
    seen, total = {}, 0
    for member in members:
        original = member.orig_filename
        name = member.filename[:-1] if member.is_dir() else member.filename
        path = PurePosixPath(name)
        require(original == member.filename and name and len(name) <= 4096
                and not any(ord(c) < 32 or ord(c) == 127 for c in name)
                and "\\" not in name and ":" not in name and not path.is_absolute()
                and ".." not in path.parts and path.as_posix() == name and name not in seen,
                "Unsafe or repeated candidate ZIP path")
        kind = stat.S_IFMT(member.external_attr >> 16)
        require(kind in (0, stat.S_IFREG, stat.S_IFDIR)
                and (kind == 0 or (kind == stat.S_IFDIR) == member.is_dir()),
                "Candidate ZIP contains a nonregular or inconsistent entry")
        require(not member.flag_bits & (1 | 64) and member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                "Candidate ZIP contains encryption or unsupported compression")
        require(member.file_size >= 0 and member.compress_size >= 0
                and (not member.is_dir() or member.file_size == 0), "Invalid candidate ZIP member size")
        total += member.file_size
        require(total <= MAX_EXPANDED_BYTES, "Candidate ZIP exceeds its expanded byte limit")
        seen[name] = member
    for name, member in seen.items():
        for parent in PurePosixPath(name).parents:
            require(str(parent) not in seen or seen[str(parent)].is_dir(), "Candidate ZIP contains a file/directory path collision")
        # Opening checks local filenames/headers and overlapping compressed
        # ranges without decompressing the skipped multi-gigabyte database.
        with archive.open(member):
            pass
    required = ("catalog/manifest.json", "catalog/clean-core-audit.json",
                "provenance/candidate-receipt.json", "selection/audit.json")
    require(all(name in seen and not seen[name].is_dir() for name in required),
            "Candidate ZIP is missing required catalog/provenance/selection files")
    return seen, total


def extract_candidate(archive_path, destination):
    """Called only after download() has verified all fixed archive bytes."""
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members, expanded = checked_members(archive)
            destination.mkdir()
            selected, skipped = [], []
            for name, member in members.items():
                parts = PurePosixPath(name).parts
                if parts[0] not in SELECTED_ROOTS:
                    skipped.append({"path": name, "bytes": member.file_size, "directory": member.is_dir()})
                    continue
                target = destination.joinpath(*parts)
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                count, digest = 0, hashlib.sha256()
                with archive.open(member) as source, target.open("xb") as output:
                    while True:
                        block = source.read(min(CHUNK_BYTES, member.file_size + 1 - count))
                        if not block:
                            break
                        count += len(block)
                        require(count <= member.file_size, "Extracted ZIP member exceeds its declared size")
                        digest.update(block)
                        output.write(block)
                require(count == member.file_size, "Extracted ZIP member was truncated")
                selected.append({"path": name, "bytes": count, "sha256": digest.hexdigest()})
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, EOFError, ValueError, NotImplementedError, zlib.error):
        raise FetchError("Candidate ZIP could not be safely extracted") from None
    return {"zipMemberCount": len(members), "declaredExpandedBytes": expanded,
            "allMemberPathsModesLocalHeadersChecked": True, "selectedRoots": sorted(SELECTED_ROOTS),
            "extractedFiles": selected, "extractedBytes": sum(x["bytes"] for x in selected),
            "skippedMembers": skipped, "skippedMemberPayloadsDecompressed": False}


def validate_content(root):
    def document(relative, expected):
        path = root / relative
        require(path.is_file() and 0 < path.stat().st_size <= MAX_JSON_BYTES, "Required candidate JSON is missing or too large")
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == expected, "Extracted candidate file differs from its fixed SHA256: " + relative)
        return strict_json(raw)

    manifest = document("catalog/manifest.json", MANIFEST_SHA256)
    generation = document("provenance/candidate-receipt.json", GENERATION_RECEIPT_SHA256)
    for key, expected in (("schemaVersion", 1), ("workflowRunId", RUN_ID), ("workflowRunAttempt", RUN_ATTEMPT), ("targetTotal", 70000)):
        require(type(generation.get(key)) is int and generation[key] == expected, "Generation receipt identity differs: " + key)
    require(generation.get("builtFromCommit") == CODE_COMMIT
            and generation.get("artifactPurpose") == "physical-catalog-candidate-for-review"
            and generation.get("candidateManifestSha256") == MANIFEST_SHA256
            and generation.get("runtimeExclusionOverlayRequired") is False and generation.get("published") is False,
            "Generation receipt is not the fixed unpublished candidate")
    require(all(type(manifest.get(k)) is int and manifest[k] == 70000 for k in ("totalFaces", "sourceFaces", "searchableFaces")),
            "The evaluated candidate manifest must declare exactly 70000 physical searchable photos")
    stamp = manifest.get("qualityAdmission")
    require(isinstance(stamp, dict) and type(stamp.get("schemaVersion")) is int and stamp["schemaVersion"] == 2
            and stamp.get("status") == "complete" and type(stamp.get("selectedCount")) is int and stamp["selectedCount"] == 70000
            and stamp.get("runtimeExclusionOverlayRequired") is False
            and re.fullmatch(r"[0-9a-f]{64}", str(stamp.get("receiptSha256", ""))) is not None
            and stamp["receiptSha256"] == generation.get("candidateAuditSha256"), "Evaluated candidate admission stamp is incomplete or unbound")
    selection = generation.get("selection")
    audit_sha = sha256_file(root / "selection/audit.json")
    require(isinstance(selection, dict) and selection.get("codeCommit") == CODE_COMMIT
            and selection.get("selectionAuditSha256") == audit_sha
            and sha256_file(root / "catalog/clean-core-audit.json") == audit_sha,
            "Evaluated candidate selection audit copies or provenance differ")
    return {"manifestSha256": MANIFEST_SHA256, "generationReceiptSha256": GENERATION_RECEIPT_SHA256,
            "selectionAuditSha256": audit_sha, "manifestDeclaredPhysicalFaces": 70000,
            "physicalCatalogRevalidatedByThisDownloader": False}


def safe_new_path(path):
    path = Path(os.path.abspath(path))
    require(not path.exists() and not path.is_symlink(), "Output path already exists; refusing to overwrite it")
    for parent in path.parents:
        require(not parent.is_symlink() and (not parent.exists() or parent.is_dir()), "Output path has a symlink or non-directory ancestor")
    return path


def write_report(path, report):
    raw = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode()
    require(len(raw) <= MAX_JSON_BYTES, "Candidate retrieval report exceeds its size bound")
    handle, temporary = tempfile.mkstemp(prefix="candidate-report-", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as output:
            output.write(raw)
        # Publish complete JSON with no overwrite, including a racing symlink.
        os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def fetch_candidate(out, report_path, client):
    out, report_path = safe_new_path(out), safe_new_path(report_path)
    require(out != report_path and out not in report_path.parents and report_path not in out.parents,
            "Candidate and report paths must be separate")
    out.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    stage, published = "metadata", False
    try:
        run = validate_run(client.json(f"/actions/runs/{RUN_ID}/attempts/{RUN_ATTEMPT}"))
        artifact = validate_artifact(client.json(f"/actions/artifacts/{ARTIFACT_ID}"))
        with tempfile.TemporaryDirectory(prefix="evaluated-candidate-", dir=out.parent) as scratch:
            scratch = Path(scratch)
            archive_path, staged = scratch / "prior.zip", scratch / "candidate"
            stage = "complete-archive-download"
            downloaded = client.download(archive_path)
            require(downloaded == {"bytes": ARCHIVE_BYTES, "sha256": ARCHIVE_SHA256}, "Download did not return the verified fixed archive")
            require(archive_path.stat().st_size == ARCHIVE_BYTES, "Verified archive file size changed before extraction")
            stage = "zip-validation-and-extraction"
            extraction = extract_candidate(archive_path, staged)
            stage = "fixed-content-bindings"
            content = validate_content(staged)
            archive_path.unlink()
            result = {"schemaVersion": 1, "documentKind": "clean-core-fixed-evaluated-candidate-retrieval",
                      "status": "passed", "verifiedAtUTC": datetime.now(timezone.utc).isoformat(),
                      "pins": pins(), "nativeRun": run, "nativeArtifact": artifact,
                      "completeArchiveSha256VerifiedBeforeExtraction": True, "archiveRemoved": True,
                      "archiveBytes": downloaded["bytes"], "archiveSha256": downloaded["sha256"],
                      "authenticationForwardedToRedirects": False, "safeExtraction": True,
                      "extraction": extraction, **content}
            stage = "materialize-verified-output"
            safe_new_path(out)
            staged.rename(out)
            published = True
        stage = "report"
        write_report(report_path, result)
        return result
    except Exception as error:
        if published:
            shutil.rmtree(out)
        message = str(error) if isinstance(error, FetchError) else "Candidate retrieval failed; incomplete output was removed"
        if not report_path.exists():
            write_report(report_path, {"schemaVersion": 1, "documentKind": "clean-core-fixed-evaluated-candidate-retrieval",
                                      "status": "failed", "stage": stage, "pins": pins(), "error": message})
        raise FetchError(message) from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="New directory for the fixed prior candidate")
    parser.add_argument("--report", type=Path, required=True, help="New JSON verification report")
    args = parser.parse_args(argv)
    try:
        result = fetch_candidate(args.out, args.report, GitHubClient(os.environ.get("GH_TOKEN", "")))
    except FetchError as error:
        # Details in a safe report when possible; never print raw network
        # exceptions, Authorization, response bodies, or signed storage URLs.
        print("Fixed evaluated candidate retrieval failed: " + str(error), file=sys.stderr)
        return 1
    except OSError:
        print("Fixed evaluated candidate retrieval failed while writing local evidence.", file=sys.stderr)
        return 1
    print(json.dumps({"status": result["status"], "runId": RUN_ID, "artifactId": ARTIFACT_ID,
                      "archiveSha256": result["archiveSha256"], "manifestSha256": result["manifestSha256"],
                      "extractedFiles": len(result["extraction"]["extractedFiles"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
