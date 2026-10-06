#!/usr/bin/env python3
"""Integrate existing-catalog audit evidence; never create an admission allowlist.

All four yaw partitions must exactly cover the current side-pose source rows.
Occlusion reports remain unreviewed model candidates, including their review-only
rows. Neither a missing measurement nor an unflagged image is certified clean.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

REPOSITORY = "ugin-man/many-faces-beta"
DEFAULT_RUN_ID = 37363088388
DEFAULT_YAW_ARTIFACTS = {
    0: 11367154325, 1: 11368040945, 2: 11371746705, 3: 11410832352,
}
DEFAULT_OCCLUSION_ARTIFACT = 11367992673
DEFAULT_MODEL_SHA256 = "1bf7c6453bec2fb28e0830f3a76dceb9ffd020124f87b28da5355940a7bc6e48"


class AuditIntegrityError(ValueError):
    """The source or an audit does not provide internally consistent evidence."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AuditIntegrityError(message)


def integer(value: Any, label: str, minimum: int = 0) -> int:
    require(type(value) is int and value >= minimum, f"{label}: expected integer >= {minimum}")
    return value


def number(value: Any, label: str) -> float:
    require(type(value) in (int, float) and math.isfinite(value), f"{label}: expected finite number")
    return float(value)


def identity(value: Any, label: str) -> str:
    require(isinstance(value, str) and bool(value) and value == value.strip()
            and not any(ord(char) < 32 for char in value), f"{label}: invalid ID")
    return value


def digest_text(value: str, length: int, label: str) -> str:
    require(isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value) is not None,
            f"{label}: expected {length} lowercase hexadecimal characters")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON object key: {key}")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise AuditIntegrityError(f"Non-finite JSON constant: {value}")


def read_json(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    require(path.is_file(), f"Required evidence/source file is missing: {path}")
    raw = path.read_bytes()
    try:
        payload = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AuditIntegrityError(f"Invalid JSON in {path}: {exc}") from exc
    require(isinstance(payload, dict), f"{path}: expected a JSON object")
    return payload, {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}


def source_path(root: Path, directory: str, name: Any) -> Path:
    require(isinstance(name, str) and bool(name) and Path(name).name == name
            and name not in (".", "..") and "\\" not in name,
            f"Unsafe {directory} source filename: {name!r}")
    path = (root / directory / name).resolve()
    require(path.is_relative_to(root.resolve()) and path.is_file(), f"Missing or unsafe source: {path}")
    return path


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def partition_for_id(image_id: str) -> int:
    return int(hashlib.sha256(image_id.encode("utf-8")).hexdigest()[:8], 16) % 4


def inspect_source(root: Path, expected_faces: int) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    manifest, manifest_record = read_json(root / "manifest.json")
    require(manifest.get("schemaVersion") == 3 and manifest.get("featureLength") == 55,
            "Current source must use catalog schema 3 and featureLength 55")
    catalog_id = identity(manifest.get("catalogId"), "catalogId")
    for field in ("totalFaces", "sourceFaces", "searchableFaces"):
        require(integer(manifest.get(field), field) == expected_faces,
                f"Current source {field} does not equal {expected_faces}")
    cells = manifest.get("cells")
    require(isinstance(cells, dict) and bool(cells), "Source has no pose cells")
    entries: dict[str, dict[str, Any]] = {}
    shard_records: list[dict[str, Any]] = []
    ranges: dict[Path, list[tuple[int, int, str]]] = {}
    whole_images: set[Path] = set()
    seen_shards: set[Path] = set()
    for cell, metadata in sorted(cells.items()):
        require(isinstance(metadata, dict), f"Invalid source cell {cell}")
        names = metadata.get("shards", [metadata.get("shard")])
        require(isinstance(names, list) and bool(names), f"No shards in cell {cell}")
        cell_count = 0
        for name in names:
            path = source_path(root, "shards", name)
            require(path not in seen_shards, f"Source shard referenced more than once: {name}")
            seen_shards.add(path)
            shard, record = read_json(path)
            record["path"] = str(path.relative_to(root.resolve()))
            shard_records.append(record)
            require(shard.get("cell") == cell, f"Shard {name} has the wrong cell")
            rows = shard.get("items")
            require(isinstance(rows, list), f"Shard {name} has no item list")
            for entry in rows:
                require(isinstance(entry, dict), f"Invalid entry in {name}")
                image_id = identity(entry.get("id"), f"{name} entry")
                require(image_id not in entries, f"Duplicate source ID: {image_id}")
                feature = entry.get("feature")
                require(isinstance(feature, list) and len(feature) == 55, f"Invalid feature for {image_id}")
                for index, value in enumerate(feature):
                    number(value, f"{image_id}.feature[{index}]")
                entries[image_id] = {"storedYaw": float(feature[0]) * 90, "name": entry.get("name", "")}
                if entry.get("image"):
                    require(not entry.get("pack"), f"Ambiguous image storage: {image_id}")
                    image_path = source_path(root, "images", entry["image"])
                    require(image_path not in whole_images and image_path.stat().st_size > 0,
                            f"Duplicate or empty source image: {image_id}")
                    whole_images.add(image_path)
                else:
                    pack_path = source_path(root, "packs", entry.get("pack"))
                    offset = integer(entry.get("offset"), f"{image_id}.offset")
                    length = integer(entry.get("length"), f"{image_id}.length", 1)
                    ranges.setdefault(pack_path, []).append((offset, length, image_id))
                cell_count += 1
        require(cell_count == integer(metadata.get("count"), f"{cell}.count"), f"Source cell count mismatch: {cell}")
    require(len(entries) == expected_faces, f"Source contains {len(entries)} IDs, expected {expected_faces}")
    image_records = []
    for path, image_ranges in sorted(ranges.items()):
        cursor = 0
        for offset, length, image_id in sorted(image_ranges):
            require(offset == cursor, f"Noncontiguous or overlapping image range: {image_id}")
            cursor += length
            require(cursor <= path.stat().st_size, f"Image range exceeds pack boundary: {image_id}")
        require(cursor == path.stat().st_size, f"Unreferenced trailing bytes in {path.name}")
        image_records.append({"path": str(path.relative_to(root.resolve())), "bytes": cursor,
                              "sha256": file_hash(path), "imageCount": len(image_ranges)})
    for path in sorted(whole_images):
        image_records.append({"path": str(path.relative_to(root.resolve())), "bytes": path.stat().st_size,
                              "sha256": file_hash(path), "imageCount": 1})
    fingerprint_input = {"manifestSha256": manifest_record["sha256"], "shards": shard_records,
                         "imageFiles": image_records}
    fingerprint = hashlib.sha256(json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {
        "catalogId": catalog_id, "sourceImageCount": len(entries),
        "manifest": manifest_record, "manifestSha256": manifest_record["sha256"],
        "sourceFingerprintSha256": fingerprint, "shards": shard_records, "imageFiles": image_records,
        "uniqueIdsVerified": True, "physicalRangeCoverageVerified": True,
        "fingerprintScope": "Current referenced manifest, shards and image bytes at integration time",
    }, entries


def artifact_reference(run_id: int, artifact_id: int) -> dict[str, Any]:
    integer(run_id, "run ID", 1)
    integer(artifact_id, "artifact ID", 1)
    return {"runId": run_id, "artifactId": artifact_id,
            "runUrl": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}",
            "artifactApiUrl": f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact_id}"}


def merge_yaw(audit_dir: Path, entries: dict[str, dict[str, Any]], run_id: int,
              artifact_ids: dict[int, int]) -> dict[str, Any]:
    require(set(artifact_ids) == set(range(4)), "Exactly four yaw artifact references are required")
    require(len(set(artifact_ids.values())) == 4, "Yaw artifact IDs must be unique")
    expected = {part: {image_id for image_id, entry in entries.items()
                       if abs(entry["storedYaw"]) >= 12 and partition_for_id(image_id) == part}
                for part in range(4)}
    partitions = []
    contradictions = []
    unresolved = []
    all_seen: set[str] = set()
    for part in range(4):
        payload, reference = read_json(audit_dir / f"yaw-{part}.json")
        rows, reported = payload.get("audit"), payload.get("contradictions")
        require(isinstance(rows, list) and isinstance(reported, list), f"Yaw {part}: missing row lists")
        require(integer(payload.get("samples"), f"Yaw {part} samples") == len(rows), f"Yaw {part}: sample count mismatch")
        for key, value in (("part", part), ("parts", 4)):
            if key in payload:
                require(type(payload[key]) is int and payload[key] == value, f"Yaw {part}: incorrect {key}")
        seen: dict[str, dict[str, Any]] = {}
        computed: dict[str, dict[str, Any]] = {}
        part_unresolved = []
        for row in rows:
            require(isinstance(row, dict), f"Yaw {part}: malformed row")
            image_id = identity(row.get("id"), f"Yaw {part}")
            require(image_id in expected[part], f"Yaw {part}: unknown, frontal or wrong-partition ID: {image_id}")
            require(image_id not in seen and image_id not in all_seen, f"Duplicate yaw ID: {image_id}")
            stored = number(row.get("storedYaw"), f"{image_id}.storedYaw")
            require(math.isclose(stored, entries[image_id]["storedYaw"], rel_tol=0, abs_tol=1e-9),
                    f"Stored yaw disagrees with current source: {image_id}")
            error = row.get("error")
            if "error" in row:
                require(isinstance(error, str) and bool(error.strip()), f"Invalid error row: {image_id}")
                require(row.get("freshYaw") is None, f"Error row also claims a fresh yaw: {image_id}")
            else:
                require("freshYaw" in row, f"Missing yaw measurement: {image_id}")
            fresh = row.get("freshYaw")
            if fresh is not None:
                fresh = number(fresh, f"{image_id}.freshYaw")
            contradiction = fresh is not None and abs(fresh) >= 8 and stored * fresh < 0 and abs(stored - fresh) >= 20
            if not error or "contradiction" in row:
                require(type(row.get("contradiction")) is bool and row["contradiction"] == contradiction,
                        f"Contradiction flag disagrees with measured rule: {image_id}")
            compact = {"id": image_id, "partition": part, "storedYaw": stored, "freshYaw": fresh}
            if fresh is None or error:
                item = {**compact, "reason": "measurement_error" if error else "no_fresh_yaw"}
                if error:
                    item["error"] = error
                part_unresolved.append(item)
            if contradiction:
                computed[image_id] = row
                contradictions.append(compact)
            seen[image_id] = row
        missing = expected[part] - set(seen)
        require(not missing, f"Yaw {part}: missing {len(missing)} expected IDs; first={sorted(missing)[:3]}")
        reported_ids: set[str] = set()
        for row in reported:
            require(isinstance(row, dict), f"Yaw {part}: malformed contradiction row")
            image_id = identity(row.get("id"), f"Yaw {part} contradiction")
            require(image_id not in reported_ids, f"Duplicate reported contradiction: {image_id}")
            require(image_id in computed and row == computed[image_id],
                    f"Reported contradiction differs from measured audit: {image_id}")
            reported_ids.add(image_id)
        require(reported_ids == set(computed), f"Yaw {part}: contradiction list omits measured contradictions")
        all_seen.update(seen)
        unresolved.extend(part_unresolved)
        partitions.append({"partition": part, "expectedRows": len(expected[part]), "auditedRows": len(rows),
                           "contradictionCount": len(computed), "unresolvedCount": len(part_unresolved),
                           "evidence": {**reference, **artifact_reference(run_id, artifact_ids[part])}})
    return {
        "scope": "Current source IDs with abs(storedYaw) >= 12 degrees",
        "partitionRule": "int(sha256(UTF-8 ID).hexdigest()[:8], 16) % 4",
        "contradictionRule": "freshYaw != null; abs(freshYaw) >= 8; storedYaw * freshYaw < 0; abs(storedYaw - freshYaw) >= 20",
        "expectedSidePoseImageCount": sum(map(len, expected.values())), "auditedSidePoseImageCount": len(all_seen),
        "idCoverageComplete": True, "measurementsComplete": not unresolved,
        "resolvedWithoutContradictionCount": len(all_seen) - len(contradictions) - len(unresolved),
        "contradictionCount": len(contradictions), "unresolvedCount": len(unresolved),
        "partitions": partitions, "contradictions": sorted(contradictions, key=lambda row: row["id"]),
        "unresolved": sorted(unresolved, key=lambda row: row["id"]),
    }


def merge_occlusion(path: Path, source: dict[str, Any], entries: dict[str, dict[str, Any]],
                    model_sha256: str, run_id: int, artifact_id: int) -> dict[str, Any]:
    payload, reference = read_json(path)
    require(type(payload.get("schemaVersion")) is int and payload["schemaVersion"] == 1, "Occlusion schema mismatch")
    require(payload.get("catalogId") == source["catalogId"], "Occlusion catalog ID mismatch")
    require(integer(payload.get("catalogFaces"), "Occlusion catalogFaces") == len(entries), "Occlusion source count mismatch")
    require(payload.get("model") == "FaceAttribNet", "Unexpected occlusion model")
    require(digest_text(payload.get("modelSha256"), 64, "Occlusion model hash") == model_sha256,
            "Occlusion model hash differs from the expected model")
    require(payload.get("ordinaryEyeglassesAllowed") is True and payload.get("facePaintNotExcludedByPolicy") is True,
            "Occlusion policy must allow transparent eyeglasses and face paint")
    thresholds = payload.get("thresholdPolicy")
    require(isinstance(thresholds, dict), "Missing reported occlusion thresholds")
    hard = number(thresholds.get("hard"), "Occlusion hard threshold")
    corroborated = number(thresholds.get("titleCorroborated"), "Occlusion title threshold")
    require(0 <= corroborated <= hard <= 1, "Invalid reported occlusion threshold range")
    candidates: dict[str, dict[str, Any]] = {}
    list_counts = {}
    reasons: Counter[str] = Counter()
    for list_name in ("excluded", "review90"):
        rows = payload.get(list_name)
        require(isinstance(rows, list), f"Occlusion {list_name} must be a list")
        seen: set[str] = set()
        for row in rows:
            require(isinstance(row, dict), f"Malformed occlusion {list_name} row")
            image_id = identity(row.get("id"), f"Occlusion {list_name}")
            require(image_id in entries, f"Unknown occlusion ID: {image_id}")
            require(image_id not in seen, f"Duplicate occlusion {list_name} ID: {image_id}")
            seen.add(image_id)
            candidate = candidates.setdefault(image_id, {"id": image_id, "reviewStatus": "unreviewed", "reportedIn": []})
            candidate["reportedIn"].append(list_name)
            if list_name == "excluded":
                reason = row.get("reason")
                require(reason in {"sunglasses", "face_mask", "decode_error"}, f"Unknown occlusion candidate reason: {reason}")
                reasons[reason] += 1
                candidate["reportedCandidateReason"] = reason
                if reason == "decode_error":
                    require(isinstance(row.get("error"), str) and bool(row["error"]), "Decode error has no detail")
                    candidate["error"] = row["error"]
                    candidate["measurementUnresolved"] = True
                    continue
            require(not candidate.get("measurementUnresolved"), f"Decode failure also has successful scores: {image_id}")
            scores = {key + "Score": number(row.get(key), f"{image_id}.{key}") for key in ("mask", "sunglasses")}
            require(all(0 <= value <= 1 for value in scores.values()), f"Model output outside expected range: {image_id}")
            if "modelOutputs" in candidate:
                require(candidate["modelOutputs"] == scores, f"Conflicting model outputs across occlusion lists: {image_id}")
            candidate["modelOutputs"] = scores
            if "yaw" in row:
                yaw = number(row["yaw"], f"{image_id}.occlusionYaw")
                require(math.isclose(yaw, round(entries[image_id]["storedYaw"], 2), rel_tol=0, abs_tol=1e-9),
                        f"Occlusion yaw disagrees with source: {image_id}")
        list_counts[list_name] = len(seen)
    for candidate in candidates.values():
        candidate.setdefault("reportedCandidateReason", "score_review")
    return {
        "evidence": {**reference, **artifact_reference(run_id, artifact_id)}, "model": payload["model"],
        "modelSha256": model_sha256, "reportedCatalogFaces": len(entries),
        "reportedThresholdPolicy": thresholds, "reportedFlaggedCount": list_counts["excluded"],
        "reportedScoreReviewCount": list_counts["review90"], "uniqueReviewCandidateCount": len(candidates),
        "reportedCandidateReasonCounts": dict(sorted(reasons.items())),
        "modelOutputMeaning": "Model scores are not calibrated visual labels or a measured dataset error rate.",
        "reviewStatus": "unreviewed", "automaticExclusionsApplied": False,
        "ordinaryEyeglassesAllowed": True, "facePaintAllowed": True,
        "unlistedImagesCertifiedClean": False,
        "candidates": [candidates[key] for key in sorted(candidates)],
    }


def merge_audits(catalog_root: Path, audit_dir: Path, *, audit_source_commit: str,
                 inspected_code_commit: str, expected_faces: int = 70000,
                 model_sha256: str = DEFAULT_MODEL_SHA256, run_id: int = DEFAULT_RUN_ID,
                 yaw_artifacts: dict[int, int] | None = None,
                 occlusion_artifact: int = DEFAULT_OCCLUSION_ARTIFACT) -> dict[str, Any]:
    digest_text(audit_source_commit, 40, "Audit source commit")
    digest_text(inspected_code_commit, 40, "Inspected code commit")
    digest_text(model_sha256, 64, "Expected attribute model hash")
    integer(expected_faces, "Expected source count", 1)
    source, entries = inspect_source(catalog_root.resolve(), expected_faces)
    # Validate every yaw partition before incorporating the occlusion report.
    yaw = merge_yaw(audit_dir, entries, run_id,
                    DEFAULT_YAW_ARTIFACTS if yaw_artifacts is None else yaw_artifacts)
    occlusion = merge_occlusion(audit_dir / "occlusion.json", source, entries,
                                model_sha256, run_id, occlusion_artifact)
    return {
        "schemaVersion": 1, "documentKind": "existing-catalog-quality-audit-evidence",
        "auditSourceCommit": audit_source_commit, "inspectedCodeCommit": inspected_code_commit,
        "evidenceIntegrationComplete": True, "admissionAllowlist": False,
        "completeCandidateCertification": False, "mayCertifyReplacementCandidates": False,
        "humanVisualReviewComplete": False, "automaticExclusionsApplied": False,
        "limitations": [
            "Historical audits contain no per-image byte hashes. The source fingerprint binds the current files, not independently the historical inference inputs.",
            "Equality of catalog files between the stated commits must be verified separately.",
            "Null or failed yaw measurements remain unresolved; coverage completeness does not turn them into passes.",
            "Occlusion candidates require visual review. Images absent from the candidate lists are not certified clean.",
            "This evidence covers the existing catalog only and must not certify unexamined replacement candidates.",
        ],
        "source": source, "yaw": yaw, "occlusion": occlusion,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=Path("public/seed-catalog"))
    parser.add_argument("--audit-dir", type=Path, default=Path("work/catalog-quality/existing"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--audit-source-commit", required=True)
    parser.add_argument("--inspected-code-commit", required=True)
    parser.add_argument("--model-sha256", default=DEFAULT_MODEL_SHA256)
    parser.add_argument("--run-id", type=int, default=DEFAULT_RUN_ID)
    parser.add_argument("--yaw-artifact", action="append", default=[], metavar="PART=ARTIFACT_ID")
    parser.add_argument("--occlusion-artifact", type=int, default=DEFAULT_OCCLUSION_ARTIFACT)
    args = parser.parse_args()
    artifacts = dict(DEFAULT_YAW_ARTIFACTS)
    try:
        for item in args.yaw_artifact:
            part, separator, artifact = item.partition("=")
            require(bool(separator), "--yaw-artifact must use PART=ARTIFACT_ID")
            artifacts[int(part)] = int(artifact)
        output = args.out.resolve()
        protected = {args.audit_dir.resolve() / name for name in ("occlusion.json", *(f"yaw-{part}.json" for part in range(4)))}
        require(output not in protected and not output.is_relative_to(args.catalog.resolve()),
                "Output must not overwrite a source catalog or input audit")
        receipt = merge_audits(args.catalog, args.audit_dir, audit_source_commit=args.audit_source_commit,
                               inspected_code_commit=args.inspected_code_commit, model_sha256=args.model_sha256,
                               run_id=args.run_id, yaw_artifacts=artifacts, occlusion_artifact=args.occlusion_artifact)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(receipt, handle, ensure_ascii=False, indent=2, allow_nan=False)
                handle.write("\n")
            os.replace(temporary, output)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
    except (AuditIntegrityError, OSError, ValueError) as exc:
        parser.exit(2, f"Audit integration failed: {exc}\n")
    print(json.dumps({"output": str(output), "sourceImages": receipt["source"]["sourceImageCount"],
                      "yawRows": receipt["yaw"]["auditedSidePoseImageCount"],
                      "yawContradictions": receipt["yaw"]["contradictionCount"],
                      "yawUnresolved": receipt["yaw"]["unresolvedCount"],
                      "occlusionFlaggedCandidates": receipt["occlusion"]["reportedFlaggedCount"],
                      "occlusionReviewCandidates": receipt["occlusion"]["uniqueReviewCandidateCount"],
                      "admissionAllowlist": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
