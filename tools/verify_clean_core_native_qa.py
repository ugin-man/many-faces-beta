#!/usr/bin/env python3
"""Bind a reviewed QA wrapper to a successful native GitHub Actions receipt.

Only GET requests are used. The pinned small summary archive is capped at
32 MiB; only its root qa-receipt.json is read. Manual photo-review and raw
comparison checks remain separate promotion gates. Uses the standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
from typing import Any
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib


REPOSITORY = "ugin-man/many-faces-beta"
BRANCH = "astra/realtime-hardening"
WORKFLOW_PATH = ".github/workflows/clean-core-v5-qa.yml"
BASELINE_COMMIT = "7b6f7f0d42c18e770379bd56577e9608ba2e9f9e"
API_ROOT = "https://api.github.com"
API_VERSION = "2026-03-10"
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_API_BYTES = 8 * 1024 * 1024
MAX_ZIP_MEMBERS = 256
MAX_RUN_ARTIFACTS = 1000
REDIRECT_CODES = frozenset((301, 302, 303, 307, 308))
IMMUTABLE_FIELDS = (
    "candidate", "baselineCommit", "fixedVideo", "facePositionSizeTracking",
    "physicalAdmission", "baselineVerification", "comparisonContract",
    "comparisonContractValidation", "comparisonReportSha256",
    "pendingNetworkCancellation", "virtualCamera", "outcomes",
    "requestSha256", "executionOrigin",
)
HOLDOUT_PREPARATION_FIELDS = (
    "preparedPhotos", "previouslyInspectedSha256",
    "previouslyInspectedImageCount", "sampleIndexSha256",
)
OUTCOME_FIELDS = (
    "request", "artifact", "dependencies", "sources", "physical",
    "holdout", "build", "browser", "integrity",
)


class VerificationError(ValueError):
    """A missing or inconsistent external provenance claim."""


def require(value: Any, message: str) -> None:
    if not value:
        raise VerificationError(message)


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def valid_sha(value: Any, length: int = 64) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(length) + "}", value) is not None


def positive_id(value: Any, label: str) -> int:
    require(type(value) is int and 0 < value <= 2**63 - 1, "Invalid " + label)
    return value


def strict_json(raw: bytes, label: str) -> dict[str, Any]:
    def pairs(rows: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in rows:
            require(key not in result, "Duplicate JSON key in " + label)
            result[key] = value
        return result

    def number(text: str) -> float:
        value = float(text)
        require(math.isfinite(value), "Nonfinite JSON number in " + label)
        return value

    def constant(_text: str) -> None:
        raise VerificationError("Nonfinite JSON constant in " + label)

    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                            parse_float=number, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError, OverflowError) as error:
        raise VerificationError("Invalid JSON in " + label) from error
    require(isinstance(result, dict), label + " must be a JSON object")
    return result


def canonical(value: Any) -> bytes:
    # Unlike Python's loose equality, this distinguishes true/1 and 1/1.0.
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def safe_relative(value: Any, label: str, directory: bool = False) -> str:
    require(isinstance(value, str) and value, "Missing " + label)
    require(not any(ord(char) < 32 or ord(char) == 127 for char in value)
            and "\\" not in value and ":" not in value, "Unsafe " + label)
    name = value[:-1] if directory and value.endswith("/") else value
    relative = PurePosixPath(name)
    require(name and name != "." and not relative.is_absolute()
            and ".." not in relative.parts and relative.as_posix() == name,
            "Unsafe " + label)
    return name


class NoAutomaticRedirect(urllib.request.HTTPRedirectHandler):
    """Keep every redirected request under the explicit no-credentials loop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubClient:
    def __init__(self, token: str, opener=None):
        require(isinstance(token, str) and token and
                all(0x21 <= ord(char) <= 0x7E for char in token),
                "GH_TOKEN is required and must not contain whitespace")
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoAutomaticRedirect())

    @staticmethod
    def checked_url(url: str) -> urllib.parse.SplitResult:
        require(isinstance(url, str) and not any(ord(char) < 32 for char in url),
                "Invalid download redirect URL")
        try:
            parsed = urllib.parse.urlsplit(url)
            allowed = (parsed.scheme == "https" and bool(parsed.hostname)
                       and parsed.username is None and parsed.password is None
                       and parsed.port in (None, 443) and not parsed.fragment)
        except ValueError as error:
            raise VerificationError("Invalid download redirect URL") from error
        require(allowed, "Download redirect must use HTTPS without URL credentials")
        return parsed

    @staticmethod
    def read_body(response, maximum: int) -> bytes:
        require(response.headers.get("Content-Encoding", "identity").lower() == "identity",
                "Unexpected encoded native response")
        length = response.headers.get("Content-Length")
        if length is not None:
            require(re.fullmatch(r"[0-9]+", length) is not None,
                    "Invalid native response Content-Length")
            require(int(length) <= maximum, "Native response exceeds its byte limit")
        payload = bytearray()
        try:
            while True:
                block = response.read(min(1024 * 1024, maximum + 1 - len(payload)))
                if not block:
                    break
                payload.extend(block)
                require(len(payload) <= maximum, "Native response exceeds its byte limit")
        except (urllib.error.URLError, OSError):
            raise VerificationError("Native GitHub response body could not be read") from None
        if length is not None:
            require(len(payload) == int(length), "Truncated native response")
        return bytes(payload)

    def get(self, url: str, *, maximum: int, redirects: bool = False) -> bytes:
        first = self.checked_url(url)
        require(first.netloc == "api.github.com", "Native requests must start at api.github.com")
        current = url
        for hop in range(6):
            self.checked_url(current)
            headers = {"User-Agent": "many-faces-native-qa-verification",
                       "Accept": "application/vnd.github+json",
                       "Accept-Encoding": "identity",
                       "X-GitHub-Api-Version": API_VERSION}
            request = urllib.request.Request(current, headers=headers, method="GET")
            # Never forward a Bearer token to a redirect target, including a
            # later redirect back to GitHub. NoAutomaticRedirect prevents the
            # standard opener from copying request headers behind this loop.
            if hop == 0:
                request.add_unredirected_header("Authorization", "Bearer " + self.token)
            try:
                response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error:
                if error.code not in REDIRECT_CODES:
                    error.close()
                    raise VerificationError(f"Native GitHub request failed with HTTP {error.code}") from None
                response = error
            except (urllib.error.URLError, OSError):
                # Presigned redirect URLs or server-echoed tokens must not leak
                # into logs through an exception's URL/body/reason text.
                raise VerificationError("Native GitHub network request failed") from None
            with response:
                status = response.getcode()
                if status in REDIRECT_CODES:
                    require(redirects, "Unexpected redirect for native GitHub metadata")
                    location = response.headers.get("Location")
                    require(isinstance(location, str) and location,
                            "Artifact redirect has no Location")
                    current = urllib.parse.urljoin(current, location)
                    self.checked_url(current)
                    continue
                require(status == 200, f"Native GitHub request failed with HTTP {status}")
                return self.read_body(response, maximum)
        raise VerificationError("Too many native artifact redirects")

    def json(self, endpoint: str) -> dict[str, Any]:
        return strict_json(self.get(API_ROOT + endpoint, maximum=MAX_API_BYTES), "native GitHub metadata")

    def archive(self, endpoint: str) -> bytes:
        return self.get(API_ROOT + endpoint, maximum=MAX_ARCHIVE_BYTES, redirects=True)


def validate_run(run: dict[str, Any], pins: dict[str, Any], code: str,
                 repository: str) -> dict[str, Any]:
    require(run.get("id") == pins["runId"] and type(run.get("id")) is int,
            "Native QA run ID differs")
    require(run.get("run_attempt") == pins["runAttempt"] and type(run.get("run_attempt")) is int,
            "Native QA run attempt differs")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "Pinned native QA attempt has not completed successfully")
    head_commit = run.get("head_commit")
    require(isinstance(head_commit, dict) and run.get("head_sha") == code and head_commit.get("id") == code,
            "Native QA ran different application code")
    require(run.get("head_branch") == BRANCH and run.get("path") == WORKFLOW_PATH,
            "Native QA used a different branch or workflow")
    require(run.get("event") in ("push", "workflow_dispatch"), "Unexpected native QA event")
    repo, head_repo = run.get("repository"), run.get("head_repository")
    require(isinstance(repo, dict) and isinstance(head_repo, dict)
            and repo.get("full_name") == repository and head_repo.get("full_name") == repository,
            "Native QA belongs to another repository or fork")
    repository_id = positive_id(repo.get("id"), "native repository ID")
    require(type(head_repo.get("id")) is int and head_repo["id"] == repository_id,
            "Native QA head repository ID differs")
    return {"id": run["id"], "run_attempt": run["run_attempt"], "head_sha": code,
            "head_branch": run["head_branch"], "path": run["path"], "event": run["event"],
            "status": run["status"], "conclusion": run["conclusion"],
            "repository": {"id": repository_id, "full_name": repository},
            "head_repository": {"id": repository_id, "full_name": repository}}


def pinned_artifact(client: GitHubClient, repository: str, pins: dict[str, Any],
                    run: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    total: int | None = None
    page = 1
    while total is None or len(rows) < total:
        result = client.json(f"/repos/{repository}/actions/runs/{pins['runId']}/artifacts?per_page=100&page={page}")
        count, items = result.get("total_count"), result.get("artifacts")
        require(type(count) is int and 0 <= count <= MAX_RUN_ARTIFACTS,
                "Native QA artifact count is invalid or excessive")
        require(isinstance(items, list) and len(items) <= 100
                and all(isinstance(item, dict) for item in items), "Invalid native artifact list")
        if total is None:
            total = count
        require(count == total, "Native artifact list changed during verification")
        require(items or len(rows) == total, "Native artifact pagination is incomplete")
        rows.extend(items)
        require(len(rows) <= total, "Native artifact count differs from its list")
        page += 1
    ids = [positive_id(row.get("id"), "listed artifact ID") for row in rows]
    require(len(ids) == len(set(ids)), "Duplicate native artifact ID across pages")
    matches = [row for row in rows if row.get("id") == pins["artifactId"]]
    named = [row for row in rows if row.get("name") == pins["artifactName"]]
    require(len(matches) == 1 and len(named) == 1 and matches[0] is named[0],
            "Pinned summary artifact ID/name is missing or ambiguous in its run")
    artifact = matches[0]
    require(artifact.get("expired") is False, "Pinned native QA summary artifact has expired")
    size = positive_id(artifact.get("size_in_bytes"), "summary archive size")
    require(size <= MAX_ARCHIVE_BYTES, "Pinned summary archive exceeds 32 MiB")
    require(artifact.get("digest") == "sha256:" + pins["archiveSha256"],
            "Wrapper archive SHA differs from GitHub's independent artifact digest")
    endpoint = f"{API_ROOT}/repos/{repository}/actions/artifacts/{pins['artifactId']}"
    require(artifact.get("url") == endpoint and artifact.get("archive_download_url") == endpoint + "/zip",
            "Native artifact URLs do not identify the canonical artifact endpoint")
    workflow = artifact.get("workflow_run")
    require(isinstance(workflow, dict), "Summary artifact has no workflow-run identity")
    expected = {"id": pins["runId"], "repository_id": run["repository"]["id"],
                "head_repository_id": run["head_repository"]["id"],
                "head_branch": BRANCH, "head_sha": run["head_sha"]}
    for field, value in expected.items():
        require(field in workflow and canonical(workflow[field]) == canonical(value),
                "Summary artifact workflow identity differs: " + field)
    return {field: artifact[field] for field in (
        "id", "name", "size_in_bytes", "url", "archive_download_url", "expired",
        "digest", "workflow_run", "created_at", "updated_at", "expires_at",
    ) if field in artifact}


def read_summary_receipt(archive: bytes, maximum: int = MAX_ARCHIVE_BYTES) -> bytes:
    require(0 < len(archive) <= maximum, "Summary ZIP exceeds its byte limit or is empty")
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            members = zipped.infolist()
            require(0 < len(members) <= MAX_ZIP_MEMBERS, "Summary ZIP member count is invalid or excessive")
            names: set[str] = set()
            total = 0
            receipt = None
            for member in members:
                require(member.filename == member.orig_filename, "Truncated ZIP member name")
                name = safe_relative(member.filename, "ZIP member path", member.is_dir())
                require(name not in names, "Duplicate ZIP member path")
                names.add(name)
                kind = stat.S_IFMT(member.external_attr >> 16)
                require(kind in (0, stat.S_IFDIR if member.is_dir() else stat.S_IFREG),
                        "ZIP contains a symlink or nonregular entry")
                require(not member.flag_bits & 0x41, "Encrypted ZIP entries are forbidden")
                require(member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        "Unsupported summary ZIP compression")
                require(0 <= member.file_size <= maximum and 0 <= member.compress_size <= maximum,
                        "ZIP entry exceeds its byte limit")
                total += member.file_size
                require(total <= maximum, "Summary ZIP expands beyond its byte limit")
                if name == "qa-receipt.json":
                    require(not member.is_dir() and member.filename == "qa-receipt.json",
                            "QA receipt must be a regular file at ZIP root")
                    receipt = member
            require(receipt is not None, "Summary ZIP is missing root qa-receipt.json")
            with zipped.open(receipt) as source:
                raw = source.read(maximum + 1)
            require(len(raw) == receipt.file_size and 0 < len(raw) <= maximum,
                    "QA receipt is empty, truncated or oversized")
            return raw
    except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, OSError, EOFError, zlib.error) as error:
        raise VerificationError("Invalid summary ZIP or receipt bytes") from error


def validate_native_receipt(wrapper: dict[str, Any], native: dict[str, Any],
                            pins: dict[str, Any], code: str, repository: str) -> None:
    require(type(native.get("schemaVersion")) is int and native["schemaVersion"] == 1
            and native.get("documentKind") == "clean-core-v5-candidate-qa",
            "Unsupported native QA receipt schema")
    require(native.get("automatedChecksPassed") is True
            and native.get("status") == "automated-checks-passed-visual-review-pending"
            and native.get("passed") is False, "Native QA did not pass its automated checks")
    require(wrapper.get("automatedChecksPassed") is True, "QA wrapper lost the native automated-check result")
    origin = native.get("executionOrigin")
    require(isinstance(origin, dict) and origin.get("kind") == "github-actions"
            and origin.get("repository") == repository and origin.get("codeCommit") == code,
            "Native QA execution origin differs")
    require(type(origin.get("workflowRunId")) is int and origin["workflowRunId"] == pins["runId"]
            and type(origin.get("workflowRunAttempt")) is int
            and origin["workflowRunAttempt"] == pins["runAttempt"], "Native receipt run/attempt differs")
    native_candidate = native.get("candidate")
    require(isinstance(native_candidate, dict) and native_candidate.get("codeCommit") == code,
            "Native receipt candidate code differs")
    require(native.get("baselineCommit") == BASELINE_COMMIT, "Native QA used another baseline")
    outcomes = native.get("outcomes")
    require(isinstance(outcomes, dict) and set(outcomes) == set(OUTCOME_FIELDS)
            and all(value == "success" for value in outcomes.values()),
            "A required native QA stage did not succeed")
    require(valid_sha(native.get("requestSha256")) and valid_sha(native.get("comparisonReportSha256")),
            "Native QA request/comparison digest is missing")
    for field in IMMUTABLE_FIELDS:
        require(field in wrapper and field in native, "Missing native QA field: " + field)
        require(canonical(wrapper[field]) == canonical(native[field]),
                "QA wrapper changed native field: " + field)
    prepared, reviewed = native.get("selectedPhotoHoldout"), wrapper.get("selectedPhotoHoldout")
    require(isinstance(prepared, dict) and isinstance(reviewed, dict), "Missing prepared holdout binding")
    require(type(prepared.get("preparedPhotos")) is int and prepared["preparedPhotos"] == 360,
            "Native QA did not prepare the complete 360-photo holdout")
    require(valid_sha(prepared.get("previouslyInspectedSha256")) and valid_sha(prepared.get("sampleIndexSha256")),
            "Native holdout preparation digests are missing")
    require(type(prepared.get("previouslyInspectedImageCount")) is int
            and prepared["previouslyInspectedImageCount"] >= 0,
            "Native previously-inspected image count is invalid")
    for field in HOLDOUT_PREPARATION_FIELDS:
        require(field in reviewed and canonical(reviewed[field]) == canonical(prepared[field]),
                "QA wrapper changed native holdout preparation: " + field)
    comparison_sha = native["comparisonReportSha256"]
    for label, reference in (("native", native.get("comparisonEvidence")),
                             ("wrapper", wrapper.get("comparisonEvidence"))):
        require(isinstance(reference, dict) and set(reference) == {"path", "sha256"}
                and reference.get("sha256") == comparison_sha, "Wrong " + label + " comparison evidence SHA")
        name = safe_relative(reference.get("path"), label + " comparison evidence path")
        if label == "native":
            require(name == "reports/browser/admitted-catalog/report.json", "Unexpected native comparison path")
        else:
            require(PurePosixPath(name).parts[0] == "data" and name.endswith(".json"),
                    "Reviewed comparison evidence must name a committed data JSON path")


def bounded_file(path: Path) -> bytes:
    require(path.is_file() and not path.is_symlink(), "QA wrapper is missing or is a symlink")
    require(path.stat().st_size <= MAX_ARCHIVE_BYTES, "QA wrapper exceeds 32 MiB")
    raw = path.read_bytes()
    require(len(raw) <= MAX_ARCHIVE_BYTES, "QA wrapper changed beyond its byte limit")
    return raw


def save_evidence(directory: Path, name: str, raw: bytes, qa_path: Path) -> Path:
    for parent in (directory, *directory.parents):
        require(not parent.is_symlink(), "Native evidence directory contains a symlink")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    require(target.resolve() != qa_path.resolve(), "Evidence output would overwrite the QA wrapper")
    require(not target.is_symlink(), "Native evidence output is a symlink")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".native-qa-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw)
        os.replace(temporary, target)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return target


def verify(qa_path: Path, repository: str, evidence_dir: Path,
           client: GitHubClient) -> dict[str, Any]:
    require(repository == REPOSITORY, "Unexpected repository")
    wrapper_bytes = bounded_file(qa_path)
    wrapper = strict_json(wrapper_bytes, "QA wrapper")
    require(type(wrapper.get("schemaVersion")) is int and wrapper["schemaVersion"] == 1
            and wrapper.get("documentKind") == "clean-core-v5-candidate-qa",
            "Unsupported reviewed QA wrapper schema")
    pins = wrapper.get("nativeExecution")
    require(isinstance(pins, dict), "QA wrapper must pin nativeExecution")
    for name in ("runId", "runAttempt", "artifactId"):
        positive_id(pins.get(name), "native " + name)
    for name in ("archiveSha256", "qaReceiptSha256"):
        require(valid_sha(pins.get(name)), "Missing native " + name)
    require(pins.get("artifactName") == f"clean-core-v5-qa-summary-{pins['runId']}-{pins['runAttempt']}",
            "Native summary artifact name must identify the exact run attempt")
    candidate = wrapper.get("candidate")
    require(isinstance(candidate, dict) and valid_sha(candidate.get("codeCommit"), 40)
            and valid_sha(candidate.get("manifestSha256")), "Invalid QA candidate identity")
    code = candidate["codeCommit"]
    run_endpoint = f"/repos/{repository}/actions/runs/{pins['runId']}/attempts/{pins['runAttempt']}"
    run = validate_run(client.json(run_endpoint), pins, code, repository)
    artifact = pinned_artifact(client, repository, pins, run)
    archive_endpoint = f"/repos/{repository}/actions/artifacts/{pins['artifactId']}/zip"
    archive = client.archive(archive_endpoint)
    require(len(archive) == artifact["size_in_bytes"], "Native summary archive size differs from GitHub metadata")
    archive_sha = sha256(archive)
    require(archive_sha == pins["archiveSha256"] and "sha256:" + archive_sha == artifact["digest"],
            "Downloaded archive SHA differs from its independent GitHub digest")
    receipt_bytes = read_summary_receipt(archive)
    require(sha256(receipt_bytes) == pins["qaReceiptSha256"], "Native QA receipt SHA differs")
    native = strict_json(receipt_bytes, "native QA receipt")
    validate_native_receipt(wrapper, native, pins, code, repository)
    require(bounded_file(qa_path) == wrapper_bytes, "Reviewed QA wrapper changed during verification")
    evidence_dir = evidence_dir.absolute()
    metadata = {"schemaVersion": 1, "source": "GitHub REST API", "apiVersion": API_VERSION,
                "runEndpoint": API_ROOT + run_endpoint, "run": run, "artifact": artifact,
                "archiveEndpoint": API_ROOT + archive_endpoint,
                "archiveSha256": archive_sha, "qaReceiptSha256": sha256(receipt_bytes)}
    metadata_bytes = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    receipt_path = save_evidence(evidence_dir, "native-qa-receipt.json", receipt_bytes, qa_path)
    metadata_path = save_evidence(evidence_dir, "native-qa-source-metadata.json", metadata_bytes, qa_path)
    result = {
        "schemaVersion": 1, "documentKind": "clean-core-v5-native-qa-verification", "status": "verified",
        "repository": repository, "workflowPath": WORKFLOW_PATH, "branch": BRANCH,
        "runId": pins["runId"], "runAttempt": pins["runAttempt"], "codeCommit": code,
        "artifactId": pins["artifactId"], "artifactName": pins["artifactName"],
        "archiveSha256": archive_sha, "qaReceiptSha256": sha256(receipt_bytes),
        "comparisonReportSha256": native["comparisonReportSha256"], "wrapperSha256": sha256(wrapper_bytes),
        "matchedFields": list(IMMUTABLE_FIELDS),
        "matchedHoldoutFields": list(HOLDOUT_PREPARATION_FIELDS),
        "preparedHoldout": {field: native["selectedPhotoHoldout"][field]
                            for field in HOLDOUT_PREPARATION_FIELDS},
        "evidence": {"receipt": {"path": str(receipt_path), "sha256": sha256(receipt_bytes)},
                     "metadata": {"path": str(metadata_path), "sha256": sha256(metadata_bytes)}},
    }
    result_bytes = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    save_evidence(evidence_dir, "native-qa-verification.json", result_bytes, qa_path)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qa", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify(args.qa, args.repository, args.evidence_dir,
                        GitHubClient(os.environ.get("GH_TOKEN", "")))
    except (VerificationError, OSError, ValueError) as error:
        print("Native QA verification failed: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
