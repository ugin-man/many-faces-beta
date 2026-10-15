#!/usr/bin/env python3
"""Bind a deny-only catalog replacement to a census of its added photographs.

``prepare`` and ``verify`` read both complete physical catalogs and the frozen
admission database. Their candidate directories must already have been restored
from independently authenticated native artifacts (including archive SHA-256).
The fixed reference below is the candidate evaluated by the preserved failed
360-photo holdout. This tool never changes that evaluation into a passing one.

``verify-index`` is the small promotion-side path. Its caller MUST obtain the
expected index SHA from an independently verified native QA artifact receipt;
passing a locally calculated hash is not native authentication. The command
checks that exact index and the complete original-image review census. It does
not claim to repeat the large catalog comparison or the separate mandatory
70,000-photo physical admission validator.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import math
import re
import shutil
import tempfile
import zlib
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path, PurePosixPath
from typing import Any

import clean_core_admission as admission
from clean_core_policy_v3 import classify_assignment, quantized_pose_cell
from clean_core_selection_review import SelectionReview, WinkExpressionReview


TARGET_TOTAL = 70000
MAX_PART_BYTES = 24 * 1024 * 1024
PAGE_SIZE = 36
INDEX_KIND = "clean-core-remediation-index"
REVIEW_KIND = "clean-core-remediation-image-review"
ORIGINAL_REVIEW_KIND = "clean-core-original-image-quality-review"
REVIEW_SCOPE = "full-original-image-quality"
REFERENCE = {
    "runId": 37491677036, "runAttempt": 1,
    "codeCommit": "c92fba37022b46bbf0f69b75bd7f011ae9d55297",
    "artifactId": 11426800117,
    "artifactName": "clean-core-v5-candidate-37491677036-1",
    "archiveSha256": "923b59d9b59ca4ba7ac54bb7660731d5fe89ac81495438f3ed098db705bd1f1c",
    "manifestSha256": "d8265b8077187e7c08e5e4b4a6c39d5999155f1ff0c02bff2160842b97cb5785",
    "generationReceiptSha256": "79c8f68790b11414cdb8b88e9ec2aeb2665d6747e99a7dd51690bb5824ec505f",
    "candidateAuditSha256": "531cda8f177fbdb973ddf70c164a737d14a28eba49a14b8df7f51e1cd901a436",
    "recordsSha256": "3abd7f470d7d553025704c7b0e6ec697d795e0b3fdf420ce9e8c230d28ffc852",
    "failedHoldoutSha256": "2d495d4ab7592936919fa770867714049d67a49168d0ad779d6c075b4f063d3c",
    "qaRunId": 37494402324,
    "sampleIndexSha256": "f543ad152cb192f559452144d2ad9a5887593cbd058efae21a89372ca76e7221",
    "sampleCount": 360, "counts": {"pass": 301, "deny": 27, "uncertain": 32},
}
SELECTION_PROGRAMS = (
    "tools/build_clean_core_v3.py", "tools/clean_core_policy_v2.py", "tools/clean_core_policy_v3.py",
    "tools/clean_core_selection_review.py", "tools/run_build_clean_core_v3_real_only.py",
    "tools/run_build_clean_core_v3_repair.py", "tools/validate_clean_core_admission.py",
    "tools/repack-live-pose-packs.mjs", "scripts/rebuild-clean-wink-support.mjs",
)
MEASUREMENTS = ("feature", "shape", "mesh", "projection", "layout")
INVENTORY_FIELDS = (
    "id", "encodedSha256", "sourceKey", "sourceCatalogId", "sourceId", "recordSha256",
    "sourceFeatureSha256", "measurementsSha256", "byteLength", "freshYaw", "freshPitch", "freshRoll",
    "poseCell", "cleanProfile", "cleanTier", "cleanPolicy", "cleanPurity", "cleanScore",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def equal(left: Any, right: Any) -> bool:
    """JSON equality that does not mistake False for 0 or True for 1."""
    return canonical(left) == canonical(right)


def digest_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def digest(value: Any, message: str) -> str:
    require(admission.valid_digest(value), message)
    return value


def integer(value: Any, minimum: int, maximum: int, message: str) -> int:
    require(type(value) is int and minimum <= value <= maximum, message)
    return value


def unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate remediation JSON key: " + key)
        result[key] = value
    return result


def invalid_constant(value: str) -> None:
    raise ValueError("Non-finite remediation JSON constant: " + value)


def parse(raw: bytes) -> dict:
    value = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    require(isinstance(value, dict), "A JSON object is required")
    return value


def child(root: Path, relative: str) -> Path:
    require(isinstance(relative, str) and bool(relative) and "\\" not in relative and "\0" not in relative,
            "Invalid remediation relative path")
    parts = PurePosixPath(relative)
    require(not parts.is_absolute() and all(part not in ("", ".", "..") for part in relative.split("/")),
            "Unsafe remediation relative path")
    root = root.resolve()
    current = root
    for part in parts.parts:
        current /= part
        require(not current.is_symlink(), "Symlink is not permitted in remediation evidence")
    require(current.resolve().is_relative_to(root), "Remediation path escapes its evidence root")
    return current


def read_json(path: Path, maximum: int = MAX_PART_BYTES) -> tuple[bytes, dict]:
    require(path.is_file() and not path.is_symlink(), "Missing or symlinked evidence file: " + str(path))
    require(0 < path.stat().st_size <= maximum, "Evidence JSON exceeds its bounded file size")
    raw = path.read_bytes()
    return raw, parse(raw)


def descriptor(path: Path, root: Path) -> dict:
    return {"path": path.relative_to(root).as_posix(), "sha256": admission.sha256_file(path), "bytes": path.stat().st_size}


def write_json(path: Path, value: dict) -> None:
    raw = canonical(value) + b"\n"
    require(len(raw) <= MAX_PART_BYTES, "Remediation JSON exceeds 24 MiB; do not truncate the added-image census")
    path.write_bytes(raw)


def review_for_catalog(catalog: Path, receipt_sha: str, records_sha: str) -> SelectionReview:
    path = child(catalog, "selection-review.json")
    _, document = read_json(path)
    previous = child(catalog, "selection-review-previous.json") if document.get("previousReviewSha256") is not None else None
    review = SelectionReview(path, receipt_sha, records_sha, previous)
    review.verify_catalog_files(catalog)
    return review


def load_candidate(root: Path, receipt: dict, receipt_sha: str, *, prior: bool, catalog_override: Path | None = None) -> dict:
    root = root.resolve()
    catalog = catalog_override.resolve() if catalog_override is not None else child(root, "catalog")
    manifest_raw, manifest = read_json(child(catalog, "manifest.json"))
    generation_raw, generation = read_json(child(root, "provenance/candidate-receipt.json"))
    selection_raw, selection = read_json(child(catalog, "clean-core-audit.json"))
    physical_raw, physical = read_json(child(catalog, "clean-admission-validation.json"))
    manifest_sha, generation_sha = digest_bytes(manifest_raw), digest_bytes(generation_raw)
    if prior:
        require(manifest_sha == REFERENCE["manifestSha256"] and generation_sha == REFERENCE["generationReceiptSha256"],
                "The reference must be the fixed c92 candidate; do not move the remediation baseline")
        require(generation.get("workflowRunId") == REFERENCE["runId"]
                and generation.get("workflowRunAttempt") == REFERENCE["runAttempt"]
                and generation.get("builtFromCommit") == REFERENCE["codeCommit"], "Fixed prior generation identity mismatch")
    require(type(generation.get("schemaVersion")) is int and generation["schemaVersion"] == 1
            and generation.get("artifactPurpose") == "physical-catalog-candidate-for-review", "Missing generation provenance")
    integer(generation.get("workflowRunId"), 1, 10**15, "Invalid candidate generation run ID")
    integer(generation.get("workflowRunAttempt"), 1, 10000, "Invalid candidate generation attempt")
    require(isinstance(generation.get("builtFromCommit"), str)
            and re.fullmatch(r"[0-9a-f]{40}", generation["builtFromCommit"]) is not None, "Invalid candidate generation code commit")
    require(generation.get("candidateManifestSha256") == manifest_sha
            and generation.get("candidateAuditSha256") == receipt_sha, "Candidate provenance describes other manifest/audit bytes")
    require(generation.get("targetTotal") == TARGET_TOTAL and type(generation.get("targetTotal")) is int,
            "The generation target must remain 70,000")
    require(all(type(manifest.get(key)) is int and manifest[key] == TARGET_TOTAL
                for key in ("totalFaces", "sourceFaces", "searchableFaces")), "Both physical catalogs must contain 70,000 photos")
    require(manifest.get("shardsContainGeometry") is True and type(manifest.get("poseStep")) is int
            and manifest["poseStep"] == 3, "Physical geometry/pose convention changed")
    stamp = {"schemaVersion": 2, "status": "complete", "policyId": receipt["policy"]["policyId"],
             "policySha256": receipt["policySha256"], "receiptSha256": receipt_sha,
             "recordsSha256": receipt["recordsSha256"], "attributeModelSha256": receipt["models"]["attributeSha256"],
             "faceModelSha256": receipt["models"]["faceSha256"], "selectedCount": TARGET_TOTAL,
             "runtimeExclusionOverlayRequired": False}
    require(equal(manifest.get("qualityAdmission"), stamp) and equal(selection.get("qualityAdmission"), stamp)
            and equal(physical.get("qualityAdmission"), stamp), "Catalog admission bindings differ from the frozen audit")
    require(selection.get("gatePassed") is True and selection.get("gateFailures") == []
            and type(selection.get("knownSyntheticFacesSelected")) is int
            and selection["knownSyntheticFacesSelected"] == 0, "Candidate selection did not pass its existing gates")
    require(physical.get("status") == "passed" and physical.get("manifestSha256") == manifest_sha
            and physical.get("catalogId") == manifest.get("catalogId"), "Missing matching complete physical validation")
    for field in ("physicalFaces", "uniqueEncodedImages"):
        require(type(physical.get(field)) is int and physical[field] == TARGET_TOTAL, "Incomplete physical photo validation")
    for field in ("allSelectedPhotosHavePassingAdmission", "allFreshMeasurementsMatch",
                  "allSelectedPhotosAbsentFromSelectionExclusions", "allSelectedWinkProfilesHaveReviewedEvidence",
                  "allSelectedProfilesHaveDeclaredEvidence"):
        require(physical.get(field) is True, "Physical admission check did not pass: " + field)
    require(physical.get("runtimeExclusionOverlayRequired") is False
            and generation.get("runtimeExclusionOverlayRequired") is False, "Runtime exclusion overlay cannot complete remediation")
    review = review_for_catalog(catalog, receipt_sha, receipt["recordsSha256"])
    wink = WinkExpressionReview(child(catalog, "wink-expression-review.json"), receipt_sha, receipt["recordsSha256"])
    for evidence, name in ((review, "selectionReview"), (wink, "winkExpressionReview")):
        require(equal(manifest.get(name), evidence.stamp()) and equal(selection.get(name), evidence.stamp())
                and equal(physical.get(name), evidence.stamp()), "Candidate review stamp does not match its exact file: " + name)
        require(generation.get(name + "Sha256") == evidence.sha256
                and selection.get(name + "Sha256") == evidence.sha256
                and physical.get(name + "Sha256") == evidence.sha256, "Candidate review digest mismatch: " + name)
    require(generation.get("previousSelectionReviewSha256") == review.document.get("previousReviewSha256"),
            "Candidate predecessor review binding mismatch")
    require(child(root, "provenance/catalog-selection-reviewed.json").read_bytes() == review.raw_bytes
            and child(root, "provenance/catalog-wink-expression-reviewed.json").read_bytes() == wink.raw_bytes,
            "Candidate provenance review copies changed")
    if review.previous_bytes is not None:
        require(child(root, "provenance/catalog-selection-reviewed-previous.json").read_bytes() == review.previous_bytes,
                "Candidate provenance predecessor copy changed")
    identity = manifest.get("selectionIdentity")
    require(isinstance(identity, dict) and equal(identity, selection.get("selectionIdentity"))
            and equal(identity, physical.get("selectionIdentity")), "Candidate selection identities differ")
    identity_sha = digest_bytes(canonical(identity))
    require(all(document.get("selectionIdentitySha256") == identity_sha for document in (manifest, selection, physical)),
            "Candidate selection identity digest mismatch")
    require(identity.get("candidateAuditSha256") == receipt_sha and identity.get("targetTotal") == TARGET_TOTAL
            and identity.get("additionalSelectionExclusionsSha256") == review.sha256
            and identity.get("winkExpressionReviewSha256") == wink.sha256, "Selection identity is not bound to its exact controls")
    require(manifest.get("catalogId") == "many-faces-clean-core-v5-" + identity_sha[:16] + "-pose-local-v1",
            "Catalog ID does not identify its actual pose-local selection")
    selector = generation.get("selection", {})
    require(selector.get("codeCommit") == generation["builtFromCommit"]
            and selector.get("additionalSelectionExclusionsSha256") == review.sha256
            and selector.get("previousAdditionalSelectionExclusionsSha256") == review.document.get("previousReviewSha256")
            and selector.get("winkExpressionReviewSha256") == wink.sha256
            and selector.get("selectionAuditSha256") == digest_bytes(selection_raw), "Generation selector bindings changed")
    require(child(root, "selection/audit.json").read_bytes() == selection_raw, "Candidate selection audit copies disagree")
    return {"root": root, "catalog": catalog, "manifest": manifest, "generation": generation,
            "selection": selection, "physical": physical, "review": review, "wink": wink,
            "binding": {"runId": generation["workflowRunId"], "runAttempt": generation["workflowRunAttempt"],
                        "codeCommit": generation["builtFromCommit"], "manifestSha256": manifest_sha,
                        "generationReceiptSha256": generation_sha, "selectionAuditSha256": digest_bytes(selection_raw),
                        "physicalValidationSha256": digest_bytes(physical_raw), "selectionIdentitySha256": identity_sha,
                        "selectionReviewSha256": review.sha256, "winkExpressionReviewSha256": wink.sha256}}


def common_gate(prior: dict, final: dict, receipt: dict, receipt_sha: str) -> dict:
    """Only exclusion evidence may differ; no model, policy or selector changes."""
    old, new = prior["generation"], final["generation"]
    inference = {key: value for key, value in old.get("inference", {}).items() if key != "reuseVerificationSha256"}
    require(equal(inference, {key: value for key, value in new.get("inference", {}).items() if key != "reuseVerificationSha256"}),
            "Inference provenance changed; this is not same-gate remediation")
    require(inference.get("mode") == "reused" and inference.get("newInferencePerformedInThisRun") is False
            and inference.get("auditRemergedInThisRun") is False, "Remediation must reuse the original complete inference")
    for field in ("recordsSha256", "analysisCodeSha256", "runnerCodeSha256", "policySha256", "controlsSha256", "models"):
        require(equal(inference.get(field), receipt.get(field)), "Generation inference differs from the original receipt: " + field)
    require(inference.get("candidateAuditSha256") == receipt_sha
            and inference.get("sourceCandidateRows") == receipt["recordCount"], "Inference audit/coverage mismatch")
    fields = ("ffhqSourceCommit", "targetTotal", "auditPartitions", "visibilityMaxScore", "sourceManifestSha256",
              "attributeModelSha256", "faceModelSha256", "priorYawEvidenceSha256", "reviewedVisibilitySha256",
              "winkExpressionReviewSha256", "winkExpressionReview", "candidateAuditSha256")
    generation_gate = {field: old[field] for field in fields}
    require(equal(generation_gate, {field: new.get(field) for field in fields}), "General admission, source, or review policy changed")
    require(equal(old["sourceManifestSha256"], {source["label"]: source["manifestSha256"] for source in receipt["sources"]}),
            "Generation sources differ from the original audited source manifests")
    code = old["selection"].get("codeFilesSha256")
    require(isinstance(code, dict) and set(code) == set(SELECTION_PROGRAMS)
            and equal(code, new["selection"].get("codeFilesSha256")), "Classification or packing code changed")
    project = Path(__file__).resolve().parents[1]
    require(equal(code, {name: admission.sha256_file(project / name) for name in SELECTION_PROGRAMS}),
            "Running selector/physical-validator files differ from the frozen generation policy")
    identities = [{key: value for key, value in candidate["manifest"]["selectionIdentity"].items()
                   if key != "additionalSelectionExclusionsSha256"} for candidate in (prior, final)]
    require(equal(*identities), "Selection parameters, profile minima, or evidence tiers changed")
    require(equal(identities[0].get("selectionCodeSha256"),
                  {Path(name).name: value for name, value in code.items()
                   if Path(name).name in identities[0].get("selectionCodeSha256", {})}), "Selector identity code bindings differ")
    selected_fields = ("policyVersion", "minimums", "poseCellMinimums", "backgroundMinimums",
                       "backgroundPoseCellMinimums", "limits", "profileEvidenceTiers")
    requirements = {field: prior["selection"][field] for field in selected_fields}
    require(equal(requirements, {field: final["selection"].get(field) for field in selected_fields}),
            "Expression or pose coverage requirements changed")
    manifest_fields = ("schemaVersion", "poseStep", "bounds", "outputSize", "shapeVersion", "featureSchema", "featureLength",
                       "shardsContainGeometry", "indexFiles")
    geometry = {field: prior["manifest"][field] for field in manifest_fields}
    require(equal(geometry, {field: final["manifest"].get(field) for field in manifest_fields}), "Physical feature or geometry schema changed")
    require(prior["wink"].raw_bytes == final["wink"].raw_bytes, "Wink expression review changed during same-policy remediation")
    old_rows = {row["encodedSha256"]: row for row in prior["review"].document["reviews"]}
    new_rows = {row["encodedSha256"]: row for row in final["review"].document["reviews"]}
    require(old_rows.keys() < new_rows.keys(), "Remediation requires additional exact-image denials")
    require(all(equal(row, new_rows[key]) for key, row in old_rows.items()), "A prior denial was removed or rewritten")
    return {"inference": inference, "generation": generation_gate, "selectionCodeSha256": code,
            "selectionIdentityWithoutAdditionalDenials": identities[0], "requirements": requirements, "geometry": geometry,
            "candidateAuditSha256": receipt_sha, "recordsSha256": receipt["recordsSha256"]}


def positive_counts(value: Any) -> dict:
    require(isinstance(value, dict), "Missing physical coverage map")
    require(all(isinstance(key, str) and type(count) is int and count >= 0 for key, count in value.items()),
            "Invalid physical coverage map")
    return {key: count for key, count in value.items() if count}


def inventory(candidate: dict, receipt: dict, database) -> dict[str, dict]:
    """Read each exact payload and its audited record; retain no mesh in RAM."""
    catalog, manifest = candidate["catalog"], candidate["manifest"]
    candidate["review"].validate_audit_records(database)
    candidate["wink"].validate_audit_records(database)
    rows, ids, keys, shards = {}, set(), set(), set()
    profiles, sources, tiers = Counter(), Counter(), Counter()
    profile_cells, tier_profiles = defaultdict(set), defaultdict(Counter)
    with admission.PackedImageReader(catalog) as reader:
        for cell, declaration in manifest["cells"].items():
            count = 0
            for name in declaration.get("shards") or [declaration.get("shard")]:
                require(name not in shards, "Duplicate manifest shard")
                shards.add(name)
                _, shard = read_json(child(catalog / "shards", name))
                require(shard.get("cell") == cell and isinstance(shard.get("items"), list), "Shard header disagrees with its manifest cell")
                for entry in shard["items"]:
                    image_sha = digest(entry.get("admissionSha256"), "Missing selected encoded-image SHA")
                    identity = entry.get("id")
                    require(isinstance(identity, str) and bool(identity) and identity not in ids, "Missing or duplicate selected photo ID")
                    key = admission.source_key(entry.get("admissionSourceCatalogId", ""), entry.get("admissionSourceId", ""))
                    require(image_sha not in rows and key not in keys, "Duplicate encoded photo or selected source identity")
                    require(not candidate["review"].excludes(image_sha), "A known denied image remains in the physical catalog")
                    original = database.execute("SELECT encoded_sha256,source_feature_sha256,decision,record_sha256,record_z "
                                                "FROM records WHERE source_key=?", (key,)).fetchone()
                    require(original is not None and original[0] == image_sha and original[2] == "pass",
                            "Selected photo has no exact passing source record")
                    raw = zlib.decompress(original[4])
                    require(digest_bytes(raw) == original[3], "Selected admission record hash changed")
                    record = parse(raw)
                    require(record.get("sourceKey") == key and record.get("encodedSha256") == image_sha
                            and record.get("sourceCatalogId") == entry["admissionSourceCatalogId"]
                            and record.get("sourceId") == entry["admissionSourceId"]
                            and record.get("sourceFeatureSha256") == original[1] and record.get("decision") == "pass",
                            "Selected record/source identity mismatch")
                    require(record.get("policySha256") == receipt["policySha256"] == entry.get("admissionPolicySha256")
                            and all(record.get("checks", {}).get(check) == "pass" for check in admission.REQUIRED_CHECKS),
                            "Selected record has a changed policy or unresolved gate")
                    require(all(equal(entry.get(field), record.get(field)) for field in MEASUREMENTS), "Fresh selected measurements changed")
                    feature = record.get("feature")
                    require(isinstance(feature, list) and len(feature) == 55
                            and all(type(number) in (int, float) and math.isfinite(number) for number in feature),
                            "Fresh feature is incomplete or non-finite")
                    for axis in ("freshYaw", "freshPitch", "freshRoll"):
                        require(type(record.get(axis)) in (int, float) and math.isfinite(record[axis]), "Missing finite fresh pose")
                    require(quantized_pose_cell(feature, 3)[0] == cell, "Photo is stored in the wrong fresh pose cell")
                    assignment = classify_assignment(feature, record.get("projection"), allow_observed_wink=candidate["wink"].side_for(image_sha))
                    require(assignment is not None and entry.get("cleanProfile") == assignment[0].name
                            and entry.get("cleanTier") == assignment[1], "Selected expression differs from unchanged fresh evidence")
                    require(entry.get("cleanPolicy") == manifest["selectionIdentity"]["policyVersion"]
                            and assignment[1] in manifest["selectionIdentity"]["profileEvidenceTiers"].get(assignment[0].name, []),
                            "Selected expression uses another policy or evidence tier")
                    if assignment[0].name in ("winkLeft", "winkRight"):
                        side = "left" if assignment[0].name == "winkLeft" else "right"
                        require(equal(entry.get("winkExpressionEvidence"), candidate["wink"].evidence_for(image_sha, side)),
                                "Selected wink lacks its same-side exact original review")
                    else:
                        require("winkExpressionEvidence" not in entry, "Non-wink photo carries spurious wink evidence")
                    require(not entry.get("image"), "The final physical catalog must use exact packed source bytes")
                    integer(entry.get("offset"), 0, 2**63 - 1, "Invalid physical image offset")
                    integer(entry.get("length"), 1, MAX_PART_BYTES, "Invalid physical image length")
                    child(catalog / "packs", entry.get("pack"))
                    payload = reader.read(entry)
                    require(len(payload) == entry["length"] == record.get("byteLength")
                            and digest_bytes(payload) == image_sha, "Selected image bytes or length differ from the frozen record")
                    row = {"id": identity, "encodedSha256": image_sha, "sourceKey": key,
                           "sourceCatalogId": record["sourceCatalogId"], "sourceId": record["sourceId"],
                           "recordSha256": original[3], "sourceFeatureSha256": original[1],
                           "measurementsSha256": digest_bytes(canonical({field: record[field] for field in MEASUREMENTS})),
                           "byteLength": len(payload), "freshYaw": record["freshYaw"], "freshPitch": record["freshPitch"],
                           "freshRoll": record["freshRoll"], "poseCell": cell,
                           **{field: entry.get(field) for field in ("cleanProfile", "cleanTier", "cleanPolicy", "cleanPurity", "cleanScore")},
                           "sourceLabel": record.get("sourceLabel", ""), "name": str(entry.get("name", "")),
                           "faceAttributes": dict(zip(admission.ATTRIBUTE_NAMES, admission.validate_attribute_scores(record.get("faceAttributes", [])))),
                           "fullAttributes": dict(zip(admission.ATTRIBUTE_NAMES, admission.validate_attribute_scores(record.get("fullAttributes", [])))),
                           "_imageReference": {field: entry[field] for field in ("id", "pack", "offset", "length")}}
                    require(assignment[1] != "observed" or row["cleanPurity"] == 0, "Observed expression must not claim isolated purity")
                    rows[image_sha], count = row, count + 1
                    ids.add(identity)
                    keys.add(key)
                    profiles[row["cleanProfile"]] += 1
                    tiers[row["cleanTier"]] += 1
                    sources[row["sourceCatalogId"]] += 1
                    profile_cells[row["cleanProfile"]].add(cell)
                    tier_profiles[row["cleanTier"]][row["cleanProfile"]] += 1
            require(type(declaration.get("count")) is int and count == declaration["count"], "Manifest pose-cell count differs from actual rows")
    require(len(rows) == TARGET_TOTAL, "The complete physical inventory does not contain exactly 70,000 unique images")
    for document, profile_field, cell_field in ((candidate["selection"], "selectedProfiles", "selectedProfilePoseCells"),
                                               (candidate["physical"], "selectedProfiles", "selectedProfilePoseCells"),
                                               (manifest["stats"]["cleanCore"], "profileCounts", "profilePoseCells")):
        require(positive_counts(document.get(profile_field)) == dict(profiles)
                and positive_counts(document.get(cell_field)) == {key: len(value) for key, value in profile_cells.items()},
                "Physical expression/pose inventory differs from its coverage evidence")
    require(positive_counts(candidate["selection"].get("selectedSources")) == dict(sources)
            and positive_counts(candidate["physical"].get("selectedSources")) == dict(sources)
            and positive_counts(candidate["selection"].get("selectedTiers")) == dict(tiers), "Physical source/evidence-tier counts disagree")
    for tier, field in (("strict", "strictProfiles"), ("observed", "observedProfiles")):
        require(positive_counts(candidate["physical"].get(field)) == dict(tier_profiles[tier])
                and positive_counts(candidate["selection"].get(field)) == dict(tier_profiles[tier]), "Strict/observed physical profile counts differ")
    for count_field, cell_field in (("minimums", "poseCellMinimums"), ("backgroundMinimums", "backgroundPoseCellMinimums")):
        for name, minimum in candidate["selection"][count_field].items():
            integer(minimum, 0, TARGET_TOTAL, "Invalid profile coverage minimum")
            require(profiles[name] >= minimum, "Final physical profile minimum failed: " + name)
        for name, minimum in candidate["selection"][cell_field].items():
            integer(minimum, 0, TARGET_TOTAL, "Invalid pose-cell coverage minimum")
            require(len(profile_cells[name]) >= minimum, "Final physical pose-cell minimum failed: " + name)
    return rows


def compact(row: dict) -> dict:
    return {key: row[key] for key in INVENTORY_FIELDS}


def inventory_bytes(rows: dict[str, dict]) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0, compresslevel=6) as stream:
        for key in sorted(rows):
            stream.write(canonical(compact(rows[key])) + b"\n")
    return buffer.getvalue()


def failed_holdout(path: Path, prior: dict, final_rows: dict, prior_rows: dict, review: SelectionReview) -> tuple[dict, list, list]:
    raw, report = read_json(path)
    require(digest_bytes(raw) == REFERENCE["failedHoldoutSha256"], "The original failed holdout bytes changed")
    require(report.get("schemaVersion") == 1 and report.get("documentKind") == "clean-core-selected-photo-holdout-visual-review"
            and report.get("status") == "failed-requires-preselection-remediation"
            and report.get("humanVerified") is False and report.get("reviewer") == "assistant-visual-review",
            "Original holdout must remain an honestly attributed failed evaluation")
    for field, expected in (("candidateRunId", REFERENCE["runId"]), ("qaRunId", REFERENCE["qaRunId"]),
                            ("manifestSha256", REFERENCE["manifestSha256"]), ("sampleIndexSha256", REFERENCE["sampleIndexSha256"]),
                            ("candidateAuditSha256", REFERENCE["candidateAuditSha256"]), ("recordsSha256", REFERENCE["recordsSha256"]),
                            ("sampleCount", REFERENCE["sampleCount"]), ("counts", REFERENCE["counts"])):
        require(equal(report.get(field), expected), "Original failed holdout binding mismatch: " + field)
    rows = report.get("reviews")
    require(isinstance(rows, list) and len(rows) == REFERENCE["sampleCount"], "Incomplete original failed holdout")
    seen, samples, counts, resolution, carry = set(), set(), Counter(), [], []
    for row in rows:
        sha = digest(row.get("encodedSha256"), "Missing original holdout image SHA")
        sample, decision = row.get("sample"), row.get("decision")
        require(sha not in seen and isinstance(sample, str) and sample not in samples, "Duplicate original holdout sample")
        require(decision in ("pass", "deny", "uncertain") and row.get("pixelChangesApplied") is False, "Invalid original holdout decision")
        old = prior_rows.get(sha)
        require(old is not None, "Original holdout photo is absent from the fixed reference inventory")
        for field in ("id", "sourceKey", "sourceCatalogId", "sourceId", "byteLength", "freshYaw", "freshPitch", "cleanProfile", "cleanTier"):
            require(equal(row.get(field), old[field]), "Original holdout source/profile/pose binding differs: " + field)
        retained = sha in final_rows
        if decision != "pass":
            require(not retained and sha in review.denied, "A former deny/uncertain image was not excluded before final selection")
        detail = {"sample": sample, "encodedSha256": sha, "sourceCatalogId": old["sourceCatalogId"], "sourceId": old["sourceId"],
                  "originalDecision": decision, "presentInFinal": retained, "originalViewedOriginal": row.get("viewedOriginal") is True}
        resolution.append(detail)
        if decision == "pass" and retained:
            carry.append({**detail, "carriedReviewScope": "original-failed-holdout-visual-screen",
                          "supplementalOriginalReview": False})
        seen.add(sha)
        samples.add(sample)
        counts[decision] += 1
    require(equal(dict(counts), REFERENCE["counts"]), "Original failed holdout decision counts differ")
    binding = {"sha256": digest_bytes(raw), "qaRunId": report["qaRunId"], "candidateRunId": report["candidateRunId"],
               "candidateManifestSha256": prior["binding"]["manifestSha256"], "sampleIndexSha256": report["sampleIndexSha256"],
               "sampleCount": report["sampleCount"], "counts": report["counts"], "status": report["status"]}
    return binding, resolution, carry


def compute_difference(prior_candidate: Path, final_candidate: Path, candidate_audit: Path,
                       failed_report: Path, selection_review: Path, *, final_catalog: Path | None = None) -> tuple[dict, dict, dict, dict]:
    receipt_raw, receipt = read_json(candidate_audit)
    receipt_sha = digest_bytes(receipt_raw)
    require(receipt_sha == REFERENCE["candidateAuditSha256"] and receipt.get("recordsSha256") == REFERENCE["recordsSha256"],
            "Remediation must use the exact original complete audit and database")
    # This read-only helper verifies the actual database hash, metadata and
    # complete counts once. It does not restore sources or run model inference.
    from review_clean_core_selection import read_evidence
    checked_receipt, database = read_evidence(candidate_audit)
    with closing(database):
        require(equal(receipt, checked_receipt), "Candidate audit changed while opening its database")
        require(receipt.get("allCandidateRowsAccounted") is True and receipt.get("runtimeExclusionOverlayRequired") is False,
                "The original audit is incomplete or relies on runtime exclusions")
        prior = load_candidate(prior_candidate, receipt, receipt_sha, prior=True)
        final = load_candidate(final_candidate, receipt, receipt_sha, prior=False, catalog_override=final_catalog)
        gate = common_gate(prior, final, receipt, receipt_sha)
        require(selection_review.read_bytes() == final["review"].raw_bytes, "Supplied cumulative selection review differs from the final catalog")
        old_rows = inventory(prior, receipt, database)
        new_rows = inventory(final, receipt, database)
    removed, added, retained = set(old_rows) - set(new_rows), set(new_rows) - set(old_rows), set(old_rows) & set(new_rows)
    require(0 < len(added) == len(removed) <= TARGET_TOTAL, "Remediation requires a nonempty complete replenishment delta")
    for sha in retained:
        require(equal(compact(old_rows[sha]), compact(new_rows[sha])), "A retained image changed source, record, feature, profile or pose")
    failed, resolution, carry = failed_holdout(failed_report, prior, new_rows, old_rows, final["review"])
    base = {"schemaVersion": 1, "documentKind": INDEX_KIND, "mode": "remediation", "status": "pending-original-review",
            "independentHoldoutPassed": False, "humanVerified": False,
            "nativeCandidateArchiveAuthenticationRequired": True,
            "prior": {**prior["binding"], **{key: REFERENCE[key] for key in ("artifactId", "artifactName", "archiveSha256")}},
            "final": final["binding"], "failedHoldout": failed,
            "candidateAuditSha256": receipt_sha, "recordsSha256": receipt["recordsSha256"],
            "selectionReviewSha256": final["review"].sha256, "selectionReview": final["review"].stamp(),
            "commonGateSha256": digest_bytes(canonical(gate)), "commonGate": gate,
            "counts": {"priorPhotos": len(old_rows), "finalPhotos": len(new_rows), "retainedPhotos": len(retained),
                       "removedPhotos": len(removed), "addedPhotos": len(added)},
            "removed": [compact(old_rows[sha]) for sha in sorted(removed)],
            "failedSampleResolution": resolution, "retainedSampleCarry": carry,
            "allKnownExcludedAbsent": not (final["review"].denied & set(new_rows)),
            "allPriorDenyAndUncertainAbsent": True,
            "reviewRule": "Every added exact encoded image requires a full original-image quality pass; no sampling or contact-only approval.",
            "limitation": "The failed holdout is preserved. This is a complete replacement-image census, not a fresh independent passing holdout or a zero-defect guarantee.",
            "separateFullPhysicalAdmissionValidationRequired": True}
    return base, old_rows, new_rows, final


def inventory_files(old_rows: dict, new_rows: dict) -> list[tuple[str, bytes, dict]]:
    files = []
    for name, rows in (("prior-inventory.jsonl.gz", old_rows), ("final-inventory.jsonl.gz", new_rows)):
        raw = inventory_bytes(rows)
        require(len(raw) <= MAX_PART_BYTES, "Complete inventory exceeds 24 MiB; do not truncate it")
        files.append((name, raw, {"path": name, "sha256": digest_bytes(raw), "bytes": len(raw), "rows": len(rows)}))
    return files


def prepare(prior_candidate: Path, final_candidate: Path, candidate_audit: Path, failed_report: Path,
            selection_review: Path, output: Path, *, final_catalog: Path | None = None) -> dict:
    require(not output.exists(), "Remediation output already exists; preserve earlier evidence")
    output.parent.mkdir(parents=True, exist_ok=True)
    base, old_rows, new_rows, final = compute_difference(prior_candidate, final_candidate, candidate_audit, failed_report, selection_review,
                                                       final_catalog=final_catalog)
    added = [{**copy.deepcopy(new_rows[sha]), "bucket": "remediation-added"} for sha in sorted(set(new_rows) - set(old_rows))]
    files = inventory_files(old_rows, new_rows)
    stage = Path(tempfile.mkdtemp(prefix=".remediation-", dir=output.parent))
    try:
        from review_clean_core_selection import extract_and_render
        pages = extract_and_render(final["catalog"], stage, added)
        for number, page in enumerate(pages, 1):
            page_rows = added[(number - 1) * PAGE_SIZE:number * PAGE_SIZE]
            page_index = stage / f"page-index-{number:02d}.json"
            write_json(page_index, {"schemaVersion": 1, "documentKind": "clean-core-remediation-originals-page",
                                   "mode": "remediation", "finalManifestSha256": base["final"]["manifestSha256"],
                                   "samples": page_rows})
            page["index"] = descriptor(page_index, stage)
            page["contact"] = descriptor(stage / page["path"], stage)
            page["images"] = [descriptor(stage / row["imagePath"], stage) for row in page_rows]
            page["uncompressedBytes"] = sum(item["bytes"] for item in [page["index"], page["contact"], *page["images"]])
            require(page["uncompressedBytes"] <= MAX_PART_BYTES,
                    "An original-image page exceeds 24 MiB; keep the census pending and use smaller bounded archive parts")
        for name, raw, _ in files:
            (stage / name).write_bytes(raw)
        base.update(added=added, pages=pages, inventoryFiles=[item[2] for item in files])
        write_json(stage / "remediation-index.json", base)
        # Original failed evidence stays byte-for-byte, failed, and separately
        # named. It is never rewritten as a successful remediation review.
        (stage / "original-failed-holdout.json").write_bytes(failed_report.read_bytes())
        require(admission.sha256_file(stage / "original-failed-holdout.json") == REFERENCE["failedHoldoutSha256"],
                "Original failed report changed during preparation")
        index_sha = admission.sha256_file(stage / "remediation-index.json")
        result = preparation_summary(base, index_sha)
        write_json(stage / "visual-review-preparation.json", result)
        stage.rename(output)
        return result
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def preparation_summary(index: dict, index_sha: str) -> dict:
    return {"schemaVersion": 1, "mode": "remediation", "status": "pending-original-review", "indexSha256": index_sha,
            "addedPhotos": index["counts"]["addedPhotos"], "removedPhotos": index["counts"]["removedPhotos"],
            "retainedPhotos": index["counts"]["retainedPhotos"], "priorManifestSha256": index["prior"]["manifestSha256"],
            "finalManifestSha256": index["final"]["manifestSha256"], "failedHoldoutSha256": index["failedHoldout"]["sha256"],
            "candidateAuditSha256": index["candidateAuditSha256"], "recordsSha256": index["recordsSha256"],
            "selectionReviewSha256": index["selectionReviewSha256"], "commonGateSha256": index["commonGateSha256"],
            "pageCount": len(index["pages"]), "independentHoldoutPassed": False,
            "allAddedOriginalsExtracted": True, "allAddedOriginalsReviewed": False,
            "allKnownExcludedAbsent": index["allKnownExcludedAbsent"], "humanVerified": False}


def validate_index(index: dict, expected_final_manifest_sha256: str) -> None:
    require(type(index.get("schemaVersion")) is int and index["schemaVersion"] == 1
            and index.get("documentKind") == INDEX_KIND and index.get("mode") == "remediation"
            and index.get("status") == "pending-original-review", "Invalid prepared remediation index")
    require(index.get("independentHoldoutPassed") is False and index.get("humanVerified") is False
            and index.get("separateFullPhysicalAdmissionValidationRequired") is True, "Remediation cannot claim an independent or human-verified pass")
    require(index.get("prior", {}).get("manifestSha256") == REFERENCE["manifestSha256"]
            and index.get("prior", {}).get("generationReceiptSha256") == REFERENCE["generationReceiptSha256"]
            and index.get("final", {}).get("manifestSha256") == digest(expected_final_manifest_sha256, "Expected final manifest digest is required"),
            "Prepared remediation index describes another candidate")
    require(index.get("candidateAuditSha256") == REFERENCE["candidateAuditSha256"]
            and index.get("recordsSha256") == REFERENCE["recordsSha256"], "Prepared remediation index changed admission evidence")
    failed = index.get("failedHoldout", {})
    require(failed.get("sha256") == REFERENCE["failedHoldoutSha256"]
            and failed.get("status") == "failed-requires-preselection-remediation"
            and failed.get("sampleIndexSha256") == REFERENCE["sampleIndexSha256"]
            and equal(failed.get("counts"), REFERENCE["counts"]) and failed.get("sampleCount") == REFERENCE["sampleCount"],
            "Prepared index rewrites or replaces the failed holdout")
    require(index.get("allKnownExcludedAbsent") is True and index.get("allPriorDenyAndUncertainAbsent") is True,
            "Prepared index did not remove all known bad or uncertain images")
    require(index.get("commonGateSha256") == digest_bytes(canonical(index.get("commonGate"))), "Prepared same-policy digest mismatch")
    counts = index.get("counts", {})
    added_count = integer(counts.get("addedPhotos"), 1, TARGET_TOTAL, "Invalid added-image census size")
    require(type(counts.get("removedPhotos")) is int and counts["removedPhotos"] == added_count
            and counts.get("priorPhotos") == TARGET_TOTAL and counts.get("finalPhotos") == TARGET_TOTAL
            and type(counts.get("retainedPhotos")) is int and counts["retainedPhotos"] == TARGET_TOTAL - added_count,
            "Incomplete or inconsistent prepared physical difference")
    sets = {}
    for field in ("added", "removed"):
        rows = index.get(field)
        require(isinstance(rows, list) and len(rows) == added_count, "Prepared delta was truncated or supplemented")
        seen, keys = set(), set()
        for row in rows:
            sha = digest(row.get("encodedSha256"), "Missing prepared image digest")
            key = admission.source_key(row.get("sourceCatalogId", ""), row.get("sourceId", ""))
            require(sha not in seen and key not in keys and row.get("sourceKey") == key, "Duplicate or altered prepared source identity")
            for name in ("recordSha256", "sourceFeatureSha256", "measurementsSha256"):
                digest(row.get(name), "Missing prepared image evidence: " + name)
            integer(row.get("byteLength"), 1, MAX_PART_BYTES, "Missing complete prepared original image")
            seen.add(sha)
            keys.add(key)
        sets[field] = seen
    require(not (sets["added"] & sets["removed"]), "An added photo also appears in removed photos")
    additions = index["added"]
    require([row.get("sample") for row in additions] == [f"H{number:03d}" for number in range(1, added_count + 1)],
            "Missing or repeated prepared original sample ID")
    require(all(row.get("bucket") == "remediation-added" and row.get("assistantReviewStatus") == "pending" for row in additions),
            "Prepared originals cannot assert their own completed reviews")
    pages = index.get("pages")
    require(isinstance(pages, list) and len(pages) == (added_count + PAGE_SIZE - 1) // PAGE_SIZE
            and [sample for page in pages for sample in page.get("samples", [])] == [row["sample"] for row in additions],
            "Original-image pages do not cover the entire added census")
    inventories = index.get("inventoryFiles")
    require(isinstance(inventories, list) and len(inventories) == 2
            and {item.get("path") for item in inventories} == {"prior-inventory.jsonl.gz", "final-inventory.jsonl.gz"},
            "Missing full inventory bindings")
    for item in inventories:
        digest(item.get("sha256"), "Invalid full inventory digest")
        integer(item.get("bytes"), 1, MAX_PART_BYTES, "Invalid full inventory size")
        require(item.get("rows") == TARGET_TOTAL, "Incomplete full inventory binding")
    resolution = index.get("failedSampleResolution")
    require(isinstance(resolution, list) and len(resolution) == REFERENCE["sampleCount"], "Missing old-sample dispositions")
    require(Counter(row.get("originalDecision") for row in resolution) == REFERENCE["counts"], "Old sample decisions changed")
    require(len({row.get("encodedSha256") for row in resolution}) == REFERENCE["sampleCount"], "Repeated old-sample resolution")
    for row in resolution:
        if row["originalDecision"] != "pass":
            require(row.get("presentInFinal") is False and row.get("encodedSha256") in sets["removed"],
                    "An original deny/uncertain was not included in the complete removals")


def original_review_document(path: Path, expected_sha: str, row: dict) -> None:
    """A reuse assertion must point to explicit full-quality original evidence.

    This deliberately does not reinterpret older wink-side/visibility-only or
    contact-sheet decisions as comprehensive original-image approval.
    """
    raw, document = read_json(path)
    require(digest_bytes(raw) == digest(expected_sha, "Reused review requires an exact document digest"), "Reused review bytes changed")
    require(document.get("documentKind") in (REVIEW_KIND, ORIGINAL_REVIEW_KIND)
            and type(document.get("schemaVersion")) is int and document["schemaVersion"] == 1
            and document.get("scope") == REVIEW_SCOPE and document.get("reviewer") == "assistant-visual-review"
            and document.get("humanVerified") is False, "Reused evidence is not an explicit full-original-image quality review")
    prior_rows = document.get("reviews")
    require(isinstance(prior_rows, list), "Missing reused original-image review rows")
    matches = [item for item in prior_rows if item.get("encodedSha256") == row["encodedSha256"]]
    require(len(matches) == 1, "Reused original review has missing or ambiguous image evidence")
    prior = matches[0]
    require(prior.get("decision") == "pass" and prior.get("viewedOriginal") is True and prior.get("pixelChangesApplied") is False
            and isinstance(prior.get("reason"), str) and bool(prior["reason"].strip()) and prior.get("reusedFrom") is None,
            "Reuse requires a direct original-image pass, not contact-only, uncertain, or chained claims")
    require(prior.get("sourceCatalogId") == row["sourceCatalogId"] and prior.get("sourceId") == row["sourceId"],
            "Reused review source does not match the added image")


def validate_reviews(index: dict, index_sha: str, review_paths: list[Path]) -> dict:
    """Caller must first authenticate and validate this native-bound index."""
    require(bool(review_paths), "Every added original remains pending until reviewed")
    expected = {row["encodedSha256"]: row for row in index["added"]}
    covered, files, reused_files, reused = set(), [], [], 0
    file_hashes = set()
    for path in review_paths:
        raw, document = read_json(path)
        file_sha = digest_bytes(raw)
        require(file_sha not in file_hashes, "Duplicate supplemental review file")
        file_hashes.add(file_sha)
        require(type(document.get("schemaVersion")) is int and document["schemaVersion"] == 1
                and document.get("documentKind") == REVIEW_KIND and document.get("scope") == REVIEW_SCOPE
                and document.get("reviewer") == "assistant-visual-review" and document.get("humanVerified") is False,
                "Supplemental review must declare its full original-image quality scope and assistant attribution")
        require(document.get("remediationIndexSha256") == index_sha
                and document.get("finalManifestSha256") == index["final"]["manifestSha256"], "Supplemental review describes another index/candidate")
        rows = document.get("reviews")
        require(isinstance(rows, list) and bool(rows), "Empty supplemental review")
        for row in rows:
            sha = digest(row.get("encodedSha256"), "Supplemental review requires an exact image digest")
            require(sha in expected and sha not in covered, "Unexpected or duplicate supplemental image review")
            original = expected[sha]
            require(all(row.get(field) == original[field] for field in ("sample", "sourceCatalogId", "sourceId")),
                    "Supplemental review sample or source ID differs from its prepared exact original")
            require(row.get("decision") == "pass", "A supplemental deny/uncertain prevents remediation completion")
            require(row.get("viewedOriginal") is True and row.get("pixelChangesApplied") is False
                    and isinstance(row.get("reason"), str) and bool(row["reason"].strip()),
                    "Each added image needs an explicit unmodified original-image quality review")
            reuse = row.get("reusedFrom")
            if reuse is not None:
                require(isinstance(reuse, dict), "Invalid reused original-review reference")
                prior_path = child(path.parent, reuse.get("path"))
                original_review_document(prior_path, reuse.get("sha256"), row)
                reused_files.append({"path": reuse["path"], "sha256": reuse["sha256"], "encodedSha256": sha})
                reused += 1
            covered.add(sha)
        files.append({"path": path.name, "sha256": file_sha, "reviewedPhotos": len(rows)})
    require(covered == set(expected), "Supplemental original review does not cover every added photo")
    return {"schemaVersion": 1, "documentKind": "clean-core-remediation-verification", "mode": "remediation", "status": "complete",
            "indexSha256": index_sha, "finalManifestSha256": index["final"]["manifestSha256"],
            "priorManifestSha256": index["prior"]["manifestSha256"], "failedHoldoutSha256": index["failedHoldout"]["sha256"],
            "failedHoldout": index["failedHoldout"], "candidateAuditSha256": index["candidateAuditSha256"],
            "recordsSha256": index["recordsSha256"], "selectionReviewSha256": index["selectionReviewSha256"],
            "commonGateSha256": index["commonGateSha256"], "addedPhotos": len(expected), "reviewedPhotos": len(covered),
            "reusedOriginalReviews": reused, "newOriginalReviews": len(covered) - reused,
            "reviewFiles": files, "reusedReviewFiles": reused_files, "allAddedOriginalsReviewed": True, "allAddedPhotosPassed": True,
            "allKnownExcludedAbsent": True, "allPriorDenyAndUncertainAbsent": True,
            "independentHoldoutPassed": False, "reviewer": "assistant-visual-review", "humanVerified": False,
            "separateFullPhysicalAdmissionValidationRequired": True}


def verify_index(index_path: Path, native_index_sha256: str, final_manifest_sha256: str,
                 review_paths: list[Path], output: Path | None = None) -> dict:
    raw, index = read_json(index_path)
    index_sha = digest_bytes(raw)
    require(index_sha == digest(native_index_sha256, "A caller-authenticated native index digest is required"),
            "Remediation index differs from the native QA artifact anchor")
    validate_index(index, final_manifest_sha256)
    result = validate_reviews(index, index_sha, review_paths)
    result.update(nativeIndexAuthentication="required-external-caller-precondition", fullCatalogDifferenceRevalidated=False)
    if output is not None:
        output.mkdir(parents=True, exist_ok=True)
        require(not (output / "remediation-verification.json").exists(), "Preserve existing remediation verification evidence")
        write_json(output / "remediation-verification.json", result)
    return result


def verify(prior_candidate: Path, final_candidate: Path, candidate_audit: Path, failed_report: Path,
           selection_review: Path, index_path: Path, review_paths: list[Path], output: Path | None = None,
           *, final_catalog: Path | None = None) -> dict:
    base, old_rows, new_rows, _ = compute_difference(prior_candidate, final_candidate, candidate_audit, failed_report, selection_review,
                                                   final_catalog=final_catalog)
    raw, index = read_json(index_path)
    index_sha = digest_bytes(raw)
    validate_index(index, base["final"]["manifestSha256"])
    require(all(equal(index.get(key), value) for key, value in base.items()), "Prepared remediation facts differ from the full catalog recomputation")
    files = inventory_files(old_rows, new_rows)
    require(equal(index.get("inventoryFiles"), [item[2] for item in files]), "Prepared inventories differ from the full physical inventories")
    for name, raw_inventory, _ in files:
        require(child(index_path.parent, name).read_bytes() == raw_inventory, "Prepared complete inventory file changed")
    expected_added = sorted(set(new_rows) - set(old_rows))
    require([row["encodedSha256"] for row in index["added"]] == expected_added, "Prepared additions differ from the exact fixed-baseline delta")
    for row in index["added"]:
        require(equal(compact(row), compact(new_rows[row["encodedSha256"]])), "Prepared added source/profile/pose evidence changed")
        image = child(index_path.parent, row.get("imagePath"))
        require(image.is_file() and image.stat().st_size == row["byteLength"]
                and admission.sha256_file(image) == row["encodedSha256"], "Missing, incomplete, or modified extracted original")
    for page in index["pages"]:
        for item in [page["index"], page["contact"], *page["images"]]:
            path = child(index_path.parent, item["path"])
            require(equal(descriptor(path, index_path.parent), item), "Prepared page evidence changed")
    result = validate_reviews(index, index_sha, review_paths)
    result.update(nativeIndexAuthentication="full-physical-difference-recomputed", fullCatalogDifferenceRevalidated=True)
    if output is not None:
        output.mkdir(parents=True, exist_ok=True)
        require(not (output / "remediation-verification.json").exists(), "Preserve existing remediation verification evidence")
        write_json(output / "remediation-verification.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "verify", "verify-index"):
        command = commands.add_parser(name)
        command.add_argument("--out", type=Path, required=True)
        if name != "verify-index":
            command.add_argument("--prior-candidate", type=Path, required=True)
            command.add_argument("--final-candidate", type=Path, required=True)
            command.add_argument("--final-catalog", type=Path, help="Optional served copy; provenance stays under --final-candidate")
            command.add_argument("--candidate-audit", type=Path, required=True)
            command.add_argument("--failed-holdout", type=Path, required=True)
            command.add_argument("--selection-review", type=Path, required=True)
        if name != "prepare":
            command.add_argument("--index", type=Path, required=True)
            command.add_argument("--review", type=Path, action="append", required=True)
        if name == "verify-index":
            command.add_argument("--native-index-sha256", required=True)
            command.add_argument("--final-manifest-sha256", required=True)
    args = parser.parse_args()
    if args.command == "verify-index":
        result = verify_index(args.index, args.native_index_sha256, args.final_manifest_sha256, args.review, args.out)
    else:
        inputs = (args.prior_candidate, args.final_candidate, args.candidate_audit, args.failed_holdout, args.selection_review)
        if args.command == "prepare":
            result = prepare(*inputs, args.out, final_catalog=args.final_catalog)
        else:
            result = verify(*inputs, args.index, args.review, args.out, final_catalog=args.final_catalog)
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
