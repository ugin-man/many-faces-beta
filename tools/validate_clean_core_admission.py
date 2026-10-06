#!/usr/bin/env python3
"""Verify that every physical selected photo has matching admission evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from clean_core_admission import AdmissionAudit, PackedImageReader, iter_catalog_entries, safe_child, sha256_file, source_key
from clean_core_policy_v3 import (BACKGROUND_PRIORITY, STRICT_PROFILE_PRIORITY, OBSERVED_PROFILE_PRIORITY,
                                  POLICY_VERSION, PROFILE_EVIDENCE_TIERS, classify_assignment, quantized_pose_cell)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def final_entries(catalog: Path, manifest: dict):
    """Check each actual shard assignment, not only aggregate cell totals."""
    seen_shards = set()
    for cell, declaration in manifest["cells"].items():
        count = 0
        for name in declaration.get("shards") or [declaration.get("shard")]:
            require(name not in seen_shards, "Repeated physical shard reference")
            seen_shards.add(name)
            shard = json.loads(safe_child(catalog / "shards", name).read_text(encoding="utf-8"))
            require(shard.get("cell") == cell, "Physical shard cell differs from manifest")
            for entry in shard["items"]:
                require(quantized_pose_cell(entry["feature"], 3)[0] == cell, "Photo stored in the wrong physical pose cell")
                count += 1
                yield entry
        require(count == declaration["count"], "Physical shard count differs from manifest")


def release_requirements() -> dict:
    # Import the same natural-photograph release configuration as the builder.
    # It applies the real-only overrides after the older repair wrapper.
    import run_build_clean_core_v3_real_only  # noqa: F401
    import clean_core_policy_v3 as policy
    return {"minimums": dict(policy.PROFILE_MINIMUMS), "poseCellMinimums": dict(policy.PROFILE_POSE_CELL_MINIMUMS),
            "backgroundMinimums": dict(policy.BACKGROUND_MINIMUMS),
            "backgroundPoseCellMinimums": dict(policy.BACKGROUND_POSE_CELL_MINIMUMS),
            "profileEvidenceTiers": {name: list(tiers) for name, tiers in policy.PROFILE_EVIDENCE_TIERS.items()}}


def validate_evidence_totals(selection: dict, stats: dict, counts: dict, cells: dict) -> dict:
    """Never report naturally coexpressed observations as isolated profiles."""
    declared = {name: list(tiers) for name, tiers in PROFILE_EVIDENCE_TIERS.items()}
    require(selection.get("profileEvidenceTiers") == stats.get("profileEvidenceTiers") == declared,
            "Declared expression evidence tiers differ from the release policy")
    require(selection.get("policyVersion") == stats.get("policyVersion") == POLICY_VERSION,
            "Expression selection policy version differs")
    for tier, profiles in counts.items():
        for name, count in profiles.items():
            require(not count or tier in PROFILE_EVIDENCE_TIERS.get(name, ()),
                    "Physical coverage uses an undeclared evidence tier: " + name)
    tier_totals = {tier: sum(values.values()) for tier, values in counts.items() if sum(values.values())}
    require(selection.get("selectedTiers") == stats.get("tierCounts") == tier_totals,
            "Total evidence-tier counts differ from physical selected entries")
    result = {"profileEvidenceTiers": declared}
    for tier, names, audit_count, manifest_count, cell_field in (
        ("strict", STRICT_PROFILE_PRIORITY, "strictProfiles", "strictProfileCounts", "strictProfilePoseCells"),
        ("observed", OBSERVED_PROFILE_PRIORITY, "observedProfiles", "observedProfileCounts", "observedProfilePoseCells"),
    ):
        expected_counts = {name: counts.get(tier, {}).get(name, 0) for name in names}
        expected_cells = {name: len(cells.get(tier, {}).get(name, set())) for name in names}
        require(selection.get(audit_count) == stats.get(manifest_count) == expected_counts,
                "Isolated/observed profile counts differ from actual evidence tiers: " + tier)
        require(selection.get(cell_field) == stats.get(cell_field) == expected_cells,
                "Isolated/observed pose breadth differs from actual evidence tiers: " + tier)
        result[audit_count], result[cell_field] = expected_counts, expected_cells
    return result


def validate_selection_identity(manifest: dict, selection_audit: dict, receipt_sha256: str, target: int) -> dict:
    from build_clean_core_v3 import selection_identity, selection_identity_sha256

    identity = manifest.get("selectionIdentity")
    require(isinstance(identity, dict), "Missing classification/selection identity")
    preselect = identity.get("preselectMultiplier")
    require(type(preselect) is int and preselect >= 1, "Invalid selection preselection parameter")
    require(identity.get("additionalSelectionExclusionsSha256") is None,
            "Additional selection exclusions require the bound deny-only review validator")
    expected = selection_identity(receipt_sha256, target, preselect)
    require(identity == selection_audit.get("selectionIdentity") == expected,
            "Selection policy, program, parameters or admission receipt differ")
    digest = selection_identity_sha256(expected)
    require(manifest.get("selectionIdentitySha256") == selection_audit.get("selectionIdentitySha256") == digest,
            "Selection identity digest mismatch")
    catalog_id = "many-faces-clean-core-v5-" + digest[:16]
    require(manifest.get("catalogId") in (catalog_id, catalog_id + "-pose-local-v1"),
            "Catalog identity is not bound to its actual classification and selection policy")
    return {"selectionIdentity": expected, "selectionIdentitySha256": digest}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--candidate-audit", required=True, type=Path)
    parser.add_argument("--face-attribute-model", required=True, type=Path)
    parser.add_argument("--source", action="append", required=True, metavar="LABEL=PATH")
    parser.add_argument("--target-total", default=70000, type=int)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    require(args.target_total >= 70000, "The physical target must remain at least 70,000")
    catalog = args.catalog.resolve()
    manifest = json.loads((catalog / "manifest.json").read_text(encoding="utf-8"))
    stamp = manifest.get("qualityAdmission", {})
    selection_audit = json.loads((catalog / "clean-core-audit.json").read_text(encoding="utf-8"))
    require(selection_audit.get("gatePassed") is True and not selection_audit.get("gateFailures"), "Physical selection audit did not pass")
    require(selection_audit.get("knownSyntheticFacesSelected") == 0, "Real-photograph audit did not pass")
    requirements = release_requirements()
    selected_identity = validate_selection_identity(manifest, selection_audit, sha256_file(args.candidate_audit), args.target_total)
    for key, expected in requirements.items():
        require(selection_audit.get(key) == expected, "Selection release requirements differ from configured real-only policy: " + key)
    for key in ("totalFaces", "sourceFaces", "searchableFaces"):
        require(manifest.get(key) == args.target_total, f"Incorrect final {key}")
    require(stamp.get("schemaVersion") == 2 and stamp.get("status") == "complete", "Missing completed admission stamp")
    require(stamp.get("selectedCount") == args.target_total, "Admission selected count mismatch")
    require(stamp.get("runtimeExclusionOverlayRequired") is False, "Catalog must not rely on runtime exclusions")
    require(manifest.get("poseStep") == 3 and manifest.get("shardsContainGeometry") is True, "Incorrect physical search geometry")
    selected_keys = set()
    for entry in final_entries(catalog, manifest):
        selected_keys.add(source_key(entry.get("admissionSourceCatalogId", ""), entry.get("admissionSourceId", "")))
    require(len(selected_keys) == args.target_total, "Missing or repeated admitted source IDs")
    with AdmissionAudit(args.candidate_audit, args.face_attribute_model, args.source) as audit:
        expected_stamp = {
            "policyId": audit.policy.document()["policyId"], "policySha256": audit.policy.sha256,
            "receiptSha256": sha256_file(args.candidate_audit), "recordsSha256": audit.receipt["recordsSha256"],
            "attributeModelSha256": audit.receipt["models"]["attributeSha256"],
            "faceModelSha256": audit.receipt["models"]["faceSha256"],
        }
        for key, value in expected_stamp.items():
            require(stamp.get(key) == value, "Admission stamp mismatch: " + key)
        originals = {}
        for source in audit.sources:
            source_manifest = json.loads((Path(source["root"]) / "manifest.json").read_text(encoding="utf-8"))
            for entry in iter_catalog_entries(source["root"]):
                key = source_key(source_manifest["catalogId"], entry["id"])
                if key in selected_keys:
                    originals[key] = entry
        require(set(originals) == selected_keys, "A selected photo is missing from original audited sources")
        ids, digests = set(), set()
        profiles, cells, source_counts = Counter(), Counter(), Counter()
        profile_cells = defaultdict(set)
        evidence_counts = defaultdict(Counter)
        evidence_cells = defaultdict(lambda: defaultdict(set))
        ranges = defaultdict(list)
        directions = Counter()
        bytes_total = 0
        with PackedImageReader(catalog) as reader:
            for entry in final_entries(catalog, manifest):
                identity = entry["id"]
                require(identity not in ids, "Duplicate final image ID")
                ids.add(identity)
                source_catalog = entry["admissionSourceCatalogId"]
                key = source_key(source_catalog, entry["admissionSourceId"])
                payload = reader.read(entry)
                digest = hashlib.sha256(payload).hexdigest()
                require(digest not in digests, "Duplicate physical encoded image")
                digests.add(digest)
                require(digest == entry.get("admissionSha256"), "Final image differs from admitted pixels")
                require(entry.get("admissionPolicySha256") == audit.policy.sha256, "Wrong final image admission policy")
                record = audit.record(source_catalog, originals[key], payload)
                require(record is not None, "A rejected/unresolved photo was physically selected")
                for field in ("feature", "shape", "mesh", "projection", "layout"):
                    require(entry.get(field) == record.get(field), "Stale or changed final face measurement: " + field)
                assignment = classify_assignment(record["feature"], record["projection"])
                require(assignment is not None, "Final photo has no supported expression assignment")
                profile, tier = assignment
                require(entry.get("cleanProfile") == profile.name and entry.get("cleanTier") == tier, "Final expression classification differs from fresh evidence")
                require(tier in PROFILE_EVIDENCE_TIERS.get(profile.name, ()), "Final profile has an undeclared evidence tier")
                require(entry.get("cleanPolicy") == POLICY_VERSION, "Final photo uses another expression selection policy")
                if tier == "observed":
                    require(entry.get("cleanPurity") == 0, "Observed coexpression must not claim isolated purity")
                cell, yaw, pitch = quantized_pose_cell(record["feature"], 3)
                profiles[profile.name] += 1
                profile_cells[profile.name].add(cell)
                evidence_counts[tier][profile.name] += 1
                evidence_cells[tier][profile.name].add(cell)
                cells[cell] += 1
                source_counts[source_catalog] += 1
                fresh_yaw, fresh_pitch = record["freshYaw"], record["freshPitch"]
                directions["yaw_negative_12" if fresh_yaw <= -12 else "yaw_positive_12" if fresh_yaw >= 12 else "yaw_frontal"] += 1
                directions["pitch_negative_12" if fresh_pitch <= -12 else "pitch_positive_12" if fresh_pitch >= 12 else "pitch_middle"] += 1
                start, length = int(entry["offset"]), int(entry["length"])
                ranges[entry["pack"]].append((start, start + length))
                bytes_total += length
        require(len(ids) == args.target_total, "Final physical row count differs from target")
        require(cells == Counter({cell: value["count"] for cell, value in manifest["cells"].items()}), "Final pose-cell counts differ from fresh evidence")
        for name, spans in ranges.items():
            end = 0
            for start, stop in sorted(spans):
                require(start == end and stop > start, "Unreferenced or overlapping pack bytes: " + name)
                end = stop
            require((catalog / "packs" / name).stat().st_size == end, "Unreferenced trailing pack bytes: " + name)
        require({path.name for path in (catalog / "packs").iterdir() if path.is_file()} == set(ranges), "Unreferenced physical pack")
        clean_stats = manifest.get("stats", {}).get("cleanCore", {})
        require(clean_stats.get("gatePassed") is True, "Selection gates did not pass")
        complete_counts = {profile: profiles[profile] for profile in (*STRICT_PROFILE_PRIORITY, *BACKGROUND_PRIORITY)}
        complete_cells = {profile: len(profile_cells[profile]) for profile in complete_counts}
        require(clean_stats.get("profileCounts") == complete_counts, "Manifest expression counts are incomplete or mismatched")
        require(clean_stats.get("profilePoseCells") == complete_cells, "Manifest expression pose counts are incomplete or mismatched")
        require(selection_audit.get("selectedProfiles") == complete_counts, "Selection expression counts are incomplete or mismatched")
        require(selection_audit.get("selectedProfilePoseCells") == complete_cells, "Selection pose counts are incomplete or mismatched")
        require(selection_audit.get("qualityAdmission") == stamp, "Selection audit is bound to another admission")
        require(selection_audit.get("selectedFaces") == args.target_total, "Selection audit physical count mismatch")
        evidence_summary = validate_evidence_totals(selection_audit, clean_stats, evidence_counts, evidence_cells)
        for key in ("minimums", "backgroundMinimums"):
            for profile, minimum in requirements[key].items():
                require(profiles[profile] >= minimum, "Final expression minimum failed: " + profile)
        for key in ("poseCellMinimums", "backgroundPoseCellMinimums"):
            for profile, minimum in requirements[key].items():
                require(len(profile_cells[profile]) >= minimum, "Final expression pose breadth failed: " + profile)
        report = {
            "schemaVersion": 1, "status": "passed", "physicalFaces": len(ids), "uniqueEncodedImages": len(digests),
            "allSelectedPhotosHavePassingAdmission": True, "allFreshMeasurementsMatch": True,
            "allSelectedProfilesHaveDeclaredEvidence": True, **evidence_summary,
            **selected_identity,
            "runtimeExclusionOverlayRequired": False, "bytes": bytes_total, "packs": len(ranges), "poseCells": len(cells),
            "catalogId": manifest["catalogId"], "manifestSha256": sha256_file(catalog / "manifest.json"),
            "qualityAdmission": stamp, "selectedProfiles": dict(sorted(profiles.items())),
            "selectedProfilePoseCells": {key: len(value) for key, value in sorted(profile_cells.items())},
            "selectedSources": dict(sorted(source_counts.items())), "directionCounts": dict(sorted(directions.items())),
            "browserVerified": False, "physicalCameraVerified": False,
        }
    report_path = args.report or catalog / "clean-admission-validation.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
