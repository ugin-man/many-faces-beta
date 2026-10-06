#!/usr/bin/env python3
"""Audit every source candidate into bounded-memory, exact-image SQLite records.

This creates admission evidence only. It does not replace runtime catalogs,
select a reduced catalog, or publish a Site.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import os
import sqlite3
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import clean_core_admission as admission


def partition_for(key: str, parts: int) -> int:
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big") % parts


def partition_count(config: dict[str, Any]) -> int:
    return int(config.get("parts", config["workers"]))


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(admission.json_bytes(value) + b"\n")
    temporary.replace(path)


def audit_partition(part: int, config: dict[str, Any]) -> dict[str, Any]:
    # Native model dependencies have not been imported when these limits are set.
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"
    os.environ["TF_NUM_INTRAOP_THREADS"] = "1"
    os.environ["TF_NUM_INTEROP_THREADS"] = "1"
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    if admission.sha256_file(admission.__file__) != config["metadata"]["analysisCodeSha256"]:
        raise ValueError("Admission code changed while starting workers")
    parts = partition_count(config)
    path = Path(config["output"]) / f"partition-{part:02d}.sqlite"
    policy = admission.AdmissionPolicy.from_document(config["policy"])
    metadata = {**config["metadata"], "status": "running", "part": part, "parts": parts}
    connection = admission.create_records_database(path, metadata)
    count = 0
    reasons: Counter[str] = Counter()
    started = time.monotonic()
    try:
        with admission.AdmissionEngine(config["attribute_model"], config["face_model"], policy,
                reviews=config["controls"]["reviews"], prior_exclusions=config["controls"]["priorYawExclusions"]) as engine:
            if engine.model_sha256 != metadata["models"]["attributeSha256"] or engine.face_model_sha256 != metadata["models"]["faceSha256"]:
                raise ValueError("Admission model changed while starting workers")
            for source, fingerprint in zip(config["sources"], config["fingerprints"]):
                catalog_id = fingerprint["catalogId"]
                with admission.PackedImageReader(source["root"]) as reader:
                    for entry in admission.iter_catalog_entries(source["root"]):
                        key = admission.source_key(catalog_id, str(entry.get("id") or ""))
                        if partition_for(key, parts) != part:
                            continue
                        payload = None
                        try:
                            payload = reader.read(entry)
                            record = engine.evaluate(payload, entry, catalog_id, source["label"])
                        except Exception as error:
                            # A failed inference/read is a recorded unresolved candidate,
                            # never an implicit pass or a missing row.
                            record = admission.base_record(entry, catalog_id, source["label"], policy, payload)
                            record["reasons"] = ["image_read_error" if payload is None else "analysis_error"]
                            record["error"] = type(error).__name__ + ": " + str(error)
                        admission.insert_record(connection, record)
                        count += 1
                        reasons.update(record["reasons"])
                        if count % 250 == 0:
                            connection.commit()
                        if count % 1000 == 0:
                            print("ADMISSION_PROGRESS " + json.dumps({"part": part, "processed": count,
                                  "seconds": round(time.monotonic() - started, 1)}), flush=True)
            runtime_versions = engine.runtime_versions
        admission.set_database_metadata(connection, "status", "complete")
        admission.set_database_metadata(connection, "runtimeVersions", runtime_versions)
        summary = admission.database_summary(connection)
        admission.set_database_metadata(connection, "summary", summary)
        connection.commit()
    finally:
        connection.close()
    receipt = {"part": part, "parts": parts, "status": "complete", **summary,
               "reasons": dict(reasons), "runtimeVersions": runtime_versions,
               "path": path.name, "sha256": admission.sha256_file(path),
               "seconds": round(time.monotonic() - started, 2)}
    write_json(path.with_suffix(".json"), receipt)
    print("ADMISSION_PARTITION " + json.dumps(receipt, ensure_ascii=False), flush=True)
    return receipt


def merge_partitions(output: Path, config: dict[str, Any], partitions: list[dict[str, Any]]) -> dict[str, Any]:
    parts = partition_count(config)
    if len(partitions) != parts or {row.get("part") for row in partitions} != set(range(parts)):
        raise ValueError("Missing or duplicate candidate audit partitions")
    if any(row.get("status") != "complete" or row.get("parts") != parts for row in partitions):
        raise ValueError("Incomplete candidate audit partition")
    versions = {admission.json_bytes(row["runtimeVersions"]) for row in partitions}
    if len(versions) != 1:
        raise ValueError("Candidate partitions used different runtime versions")
    database_path = output / "records.sqlite"
    merged = admission.create_records_database(database_path, {**config["metadata"], "status": "running"})
    try:
        for part in sorted(partitions, key=lambda row: row["part"]):
            path = admission.safe_child(output, part["path"])
            if admission.sha256_file(path) != part["sha256"]:
                raise ValueError("Candidate partition database changed")
            reader = admission.readonly_database(path)
            try:
                metadata = admission.database_metadata(reader)
                for key, value in config["metadata"].items():
                    if metadata.get(key) != value:
                        raise ValueError("Inconsistent candidate partition metadata: " + key)
                if metadata.get("status") != "complete" or metadata.get("part") != part["part"] or metadata.get("parts") != parts:
                    raise ValueError("Candidate partition identity mismatch")
                summary = admission.database_summary(reader)
                if any(part.get(key) != value for key, value in summary.items()):
                    raise ValueError("Candidate partition count mismatch")
                cursor = reader.execute("SELECT source_key,source_catalog_id,source_id,encoded_sha256,source_feature_sha256,decision,record_sha256,record_z FROM records")
                while batch := cursor.fetchmany(500):
                    if any(partition_for(row[0], parts) != part["part"] for row in batch):
                        raise ValueError("A candidate was assigned to the wrong partition")
                    merged.executemany("INSERT INTO records VALUES (?,?,?,?,?,?,?,?)", batch)
                merged.commit()
            finally:
                reader.close()
        summary = admission.database_summary(merged)
        if summary["recordCount"] != sum(source["expectedRows"] for source in config["fingerprints"]):
            raise ValueError("Incomplete source candidate coverage")
        for source in config["fingerprints"]:
            keys = [row[0] for row in merged.execute("SELECT source_key FROM records WHERE source_catalog_id=? ORDER BY source_key", (source["catalogId"],))]
            if len(keys) != source["expectedRows"] or admission.key_set_sha256(keys) != source["sourceKeySetSha256"]:
                raise ValueError("Merged candidate source-key coverage mismatch")
        admission.set_database_metadata(merged, "status", "complete")
        admission.set_database_metadata(merged, "runtimeVersions", json.loads(next(iter(versions))))
        admission.set_database_metadata(merged, "summary", summary)
        merged.commit()
    finally:
        merged.close()
    # Do not certify a run whose source manifests/shards changed mid-analysis.
    current = [admission.fingerprint_catalog(source["label"], source["root"]) for source in config["sources"]]
    if current != config["fingerprints"]:
        raise ValueError("Source files changed while candidate admission was running")
    return {**summary, "recordsPath": database_path.name, "recordsSha256": admission.sha256_file(database_path),
            "runtimeVersions": json.loads(next(iter(versions)))}


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", action="append", required=True, metavar="LABEL=PATH")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--face-attribute-model", "--attribute-model", dest="attribute_model", type=Path, required=True)
    parser.add_argument("--face-model", type=Path, required=True)
    parser.add_argument("--reviewed-visibility", type=Path, required=True)
    parser.add_argument("--prior-yaw-evidence", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--parts", type=int, help="Total deterministic partitions; defaults to --workers")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--part", type=int, help="Run this one partition only, for a distributed Actions matrix")
    mode.add_argument("--merge-only", action="store_true", help="Validate and merge previously completed partitions")
    parser.add_argument("--visibility-max-score", type=float, default=.05)
    parser.add_argument("--mirror-check", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.workers <= 8:
        parser.error("workers must be between 1 and 8")
    args.parts = args.parts if args.parts is not None else args.workers
    if not 1 <= args.parts <= 64:
        parser.error("parts must be between 1 and 64")
    if args.part is not None and not 0 <= args.part < args.parts:
        parser.error("part must be in the range 0..parts-1")
    if args.part is not None and args.workers != 1:
        parser.error("A single distributed --part requires --workers 1")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    output = args.out.resolve()
    if not args.merge_only and output.exists() and any(output.iterdir()):
        raise ValueError("Output directory must be empty; completed or partial audits are never silently overwritten")
    if args.merge_only and any((output / name).exists() for name in ("records.sqlite", "candidate-audit.json")):
        raise ValueError("A merged audit already exists; it is never silently overwritten")
    output.mkdir(parents=True, exist_ok=True)
    sources = admission.normalize_sources(args.catalog)
    fingerprints = [admission.fingerprint_catalog(source["label"], source["root"]) for source in sources]
    if len({row["catalogId"] for row in fingerprints}) != len(fingerprints):
        raise ValueError("Catalog IDs must be distinct across admission sources")
    policy = admission.AdmissionPolicy(visibility_max_score=args.visibility_max_score, mirror_check=args.mirror_check)
    controls = {"schemaVersion": 1,
                "reviews": admission.load_visibility_reviews(args.reviewed_visibility),
                "priorYawExclusions": admission.resolve_prior_yaw_exclusions(args.prior_yaw_evidence, sources, fingerprints),
                "reviewedFileSha256": admission.sha256_file(args.reviewed_visibility),
                "priorYawEvidenceSha256": admission.sha256_file(args.prior_yaw_evidence)}
    controls_path = output / "admission-controls.json"
    metadata = {"schemaVersion": admission.SCHEMA_VERSION, "policySha256": policy.sha256,
                "analysisCodeSha256": admission.sha256_file(admission.__file__),
                "models": {"attributeSha256": admission.sha256_file(args.attribute_model), "faceSha256": admission.sha256_file(args.face_model)},
                "controlsSha256": hashlib.sha256(admission.json_bytes(controls) + b"\n").hexdigest(), "sources": fingerprints}
    # This contains no timestamps or absolute paths, so independent matrix jobs
    # must produce exactly the same run identity. Partition database metadata is
    # verified independently, even if artifact downloads overwrite this file.
    run_metadata = {**metadata, "parts": args.parts, "policy": policy.document(),
                    "runnerCodeSha256": admission.sha256_file(__file__)}
    run_metadata_path = output / "run-metadata.json"
    if args.merge_only:
        if json.loads(run_metadata_path.read_text(encoding="utf-8")) != run_metadata:
            raise ValueError("Distributed audit run metadata differs from the requested merge")
        if admission.sha256_file(controls_path) != metadata["controlsSha256"]:
            raise ValueError("Distributed audit review/evidence controls differ from the requested merge")
    else:
        write_json(controls_path, controls)
        write_json(run_metadata_path, run_metadata)
    config = {"output": str(output), "workers": args.workers, "parts": args.parts, "sources": sources, "fingerprints": fingerprints,
              "policy": policy.document(), "controls": controls, "metadata": metadata,
              "attribute_model": str(args.attribute_model.resolve()), "face_model": str(args.face_model.resolve())}
    print("ADMISSION_START " + json.dumps({"rows": sum(source["expectedRows"] for source in fingerprints),
          "workers": args.workers, "parts": args.parts, "part": args.part, "mergeOnly": args.merge_only,
          "priorYawDigestExclusions": len(controls["priorYawExclusions"]),
          "reviewedDigests": len(controls["reviews"]), "policySha256": policy.sha256}), flush=True)
    started = time.monotonic()
    if args.merge_only:
        partitions = [json.loads((output / f"partition-{part:02d}.json").read_text(encoding="utf-8")) for part in range(args.parts)]
    elif args.part is not None:
        audit_partition(args.part, config)
        return 0
    elif args.workers == 1:
        partitions = [audit_partition(part, config) for part in range(args.parts)]
    else:
        with ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn")) as executor:
            futures = [executor.submit(audit_partition, part, config) for part in range(args.parts)]
            partitions = [future.result() for future in as_completed(futures)]
    merged = merge_partitions(output, config, partitions)
    receipt = {**metadata, "status": "complete", "policy": policy.document(), "workers": args.parts,
               "partitionCount": args.parts, "executionWorkers": args.workers,
               "sources": fingerprints, "controlsPath": controls_path.name,
               "partitions": sorted(partitions, key=lambda row: row["part"]), **merged,
               "runnerCodeSha256": admission.sha256_file(__file__),
               "createdAt": datetime.now(timezone.utc).isoformat(), "seconds": round(time.monotonic() - started, 2),
               "runtimeExclusionOverlayRequired": False, "candidateSelectionPerformed": False,
               "scoresCalibrated": False, "allCandidateRowsAccounted": True}
    receipt_path = output / "candidate-audit.json"
    write_json(receipt_path, receipt)
    # Exercise the same fail-closed reader the physical builder will use.
    try:
        with admission.AdmissionAudit(receipt_path, args.attribute_model, sources):
            pass
    except Exception as error:
        receipt["status"] = "validation_failed"
        receipt["validationError"] = type(error).__name__ + ": " + str(error)
        write_json(receipt_path, receipt)
        raise
    print("ADMISSION_COMPLETE " + json.dumps({key: receipt[key] for key in (
        "recordCount", "passCount", "rejectCount", "unresolvedCount", "recordsSha256", "seconds")}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
