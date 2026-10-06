#!/usr/bin/env python3
"""Verify that every physical selected photo has matching admission evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from clean_core_admission import AdmissionAudit, PackedImageReader, iter_catalog_entries, safe_child, sha256_file, source_key
from clean_core_policy_v3 import BACKGROUND_PRIORITY, STRICT_PROFILE_PRIORITY, classify_assignment, quantized_pose_cell


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
            "backgroundPoseCellMinimums": dict(policy.BACKGROUND_POSE_CELL_MINIMUMS)}


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
                cell, yaw, pitch = quantized_pose_cell(record["feature"], 3)
                profiles[profile.name] += 1
                profile_cells[profile.name].add(cell)
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
        for key in ("minimums", "backgroundMinimums"):
            for profile, minimum in requirements[key].items():
                require(profiles[profile] >= minimum, "Final expression minimum failed: " + profile)
        for key in ("poseCellMinimums", "backgroundPoseCellMinimums"):
            for profile, minimum in requirements[key].items():
                require(len(profile_cells[profile]) >= minimum, "Final expression pose breadth failed: " + profile)
        report = {
            "schemaVersion": 1, "status": "passed", "physicalFaces": len(ids), "uniqueEncodedImages": len(digests),
            "allSelectedPhotosHavePassingAdmission": True, "allFreshMeasurementsMatch": True,
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
