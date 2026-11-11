#!/usr/bin/env python3
"""Freeze and run serial, fresh-process comparisons of six exact engines.

The oracle is prepared once, before timing. Each child contains only its own
engine. Every measured query includes descriptor preparation and output-list
conversion. Correctness checking, logging, and oracle lookup are outside that
timer. Existing run/pass directories are never overwritten.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import subprocess
import sys
import time
import traceback

for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np

from benchmark import digest, load_arrays, log, write_json
from native_scorer import NativeKernel, build_native
from strict_metric import prepare, score_prepared, stable_topk
from strong_exact_engines import METHODS, create_engine
from temporal_exact import BOUND_EPSILON_FACTOR, REFRESH_FRACTION

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SOURCE_FILES = (
    "protocol.json", "protocol-v2.json", "benchmark.py", "benchmark_v2.py",
    "strict_metric.py", "temporal_exact.py", "engines.py",
    "strong_exact_engines.py", "verify_strong_exact.py", "native_scorer.py",
    "native/strict_kernel.cpp",
)
DATA_FILES = (
    "candidate-ids.json", "candidate-shards.json", "candidates.features.f64",
    "candidates.projections.f64", "queries.features.f64", "queries.projections.f64",
    "queries.json", "queries.manifest.json", "catalog.manifest.json", "orders.json",
    "strict-metric-verification.json",
)


def now():
    return datetime.now(timezone.utc).isoformat()


def environment():
    cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), "unknown")
    extra = {}
    for name in ("cpu.max", "memory.max"):
        path = Path("/sys/fs/cgroup") / name
        extra[name] = path.read_text().strip() if path.exists() else None
    return {
        "platform": platform.platform(), "python": sys.version, "numpy": np.__version__,
        "cpu_model": cpu, "logical_cpus": os.cpu_count(),
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "numerical_threads": {name: os.environ[name] for name in
                              ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS")},
        "cgroup": extra,
        "timing_clock": "time.perf_counter_ns",
        "host_limit": "Shared managed host; affinity and thread count are controlled, other tenants and CPU frequency are not",
    }


def load_protocol():
    protocol = json.loads((HERE / "protocol-v2.json").read_text())
    original = json.loads((HERE / "protocol.json").read_text())
    if digest(HERE / "protocol.json") != protocol["parent_protocol_sha256"]:
        raise ValueError("The original fixed protocol changed")
    if tuple(protocol["methods"]) != METHODS or np.__version__ != protocol["numpy_version"]:
        raise ValueError("Method list or NumPy version differs from protocol")
    if REFRESH_FRACTION != protocol["temporal"]["fallback_fraction"] or BOUND_EPSILON_FACTOR != protocol["temporal"]["floating_margin_scale"]:
        raise ValueError("Pruning constants differ from protocol")
    return protocol, original


def make_schedule(protocol):
    methods = protocol["methods"]
    schedule = []
    for block, setting in enumerate(protocol["method_order"]["blocks"]):
        for position, base_index in enumerate(protocol["method_order"]["base_indexes"]):
            method = methods[(base_index + block) % len(methods)]
            index = len(schedule)
            schedule.append({
                "index": index, "block": block, "position_in_block": position,
                "repeat": setting["repeat"], "order": setting["order"], "method": method,
                "id": f"{index:02d}-r{setting['repeat']}-{setting['order']}-{method}",
            })
    expected = {(method, order, repeat) for method in methods for order in protocol["orders"]
                for repeat in range(protocol["repetitions"])}
    if len(schedule) != protocol["expected_passes"] or {
        (row["method"], row["order"], row["repeat"]) for row in schedule
    } != expected:
        raise ValueError("Incomplete or duplicate fixed schedule")
    return schedule


def pin(cpu):
    if cpu not in os.sched_getaffinity(0):
        raise ValueError("Frozen CPU is unavailable to this process")
    os.sched_setaffinity(0, {cpu})


def verify_file_map(root, hashes):
    for name, expected in hashes.items():
        path = root / name
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"A locked file changed or disappeared: {path}")


def validate_parity(data):
    parity = json.loads((data / "strict-metric-verification.json").read_text())
    if parity.get("status") != "pass" or parity["pythonPortSha256"] != digest(HERE / "strict_metric.py"):
        raise ValueError("Current production-score parity verification is required")
    verify_file_map(HERE, parity["sourceHashes"])


def freeze(args):
    protocol, original = load_protocol()
    if args.output.exists():
        raise FileExistsError("Preserve existing attempts; choose a new run directory")
    args.output.mkdir(parents=True)
    cpu = min(os.sched_getaffinity(0)) if args.cpu is None else args.cpu
    pin(cpu)
    try:
        validate_parity(args.data)
        ids, metadata, arrays = load_arrays(args.data, original)
        orders = json.loads((args.data / "orders.json").read_text())
        expected_orders = {"original": list(range(len(metadata))),
                           "shuffled": np.random.Generator(np.random.PCG64(protocol["shuffle_seed"])).permutation(len(metadata)).tolist()}
        if orders != {"seed": protocol["shuffle_seed"], "orders": expected_orders}:
            raise ValueError("Frozen query orders differ")
        verification = json.loads(args.verification.read_text())
        if verification.get("status") != "pass":
            raise ValueError("Passing strong-exact verification is required")
        required = {"strong_exact_engines.py", "native_scorer.py", "native/strict_kernel.cpp",
                    "strict_metric.py", "temporal_exact.py", "verify_strong_exact.py", "engines.py"}
        if not required.issubset(verification.get("source_sha256", {})):
            raise ValueError("Verification report lacks source provenance")
        verify_file_map(HERE, verification["source_sha256"])
        if not {"candidates.features.f64", "candidates.projections.f64", "queries.features.f64", "queries.projections.f64"}.issubset(verification.get("input_sha256", {})):
            raise ValueError("Verification report lacks input provenance")
        verify_file_map(args.data, verification["input_sha256"])
        if (verification.get("numpy_version") != protocol["numpy_version"]
                or verification.get("absolute_score_tolerance") != 2e-12
                or verification.get("relative_score_tolerance") != 0):
            raise ValueError("Verification version or tolerances differ from protocol")
        if verification.get("native_library_sha256") != digest(args.library):
            raise ValueError("Verification used another native binary")
        build_started = time.perf_counter()
        library = build_native(args.output / "native-build")
        cold_native_build_seconds = time.perf_counter() - build_started
        if digest(library) != digest(args.library):
            raise ValueError("Fresh compilation differs from the verified native binary")
        kernel = NativeKernel(library)
        if kernel.metadata["specification"]["flags"] != protocol["scoring"]["flags"]:
            raise ValueError("Compiler flags differ from protocol")
        source_hashes = {name: digest(HERE / name) for name in SOURCE_FILES}
        input_hashes = {name: digest(args.data / name) for name in DATA_FILES}
        write_json(args.output / "preparation.json", {
            "started_at_utc": now(), "protocol": protocol, "source_sha256": source_hashes,
            "input_sha256": input_hashes, "cpu": cpu, "environment": environment(),
            "oracle_note": "NumPy exhaustive preparation only; no performance result from this phase is used",
        })
        candidates = prepare(arrays["candidates.features"], arrays["candidates.projections"])
        oracle_ids = np.empty((len(metadata), protocol["k"]), dtype=np.int32)
        oracle_scores = np.empty((len(metadata), protocol["k"]), dtype=np.float64)
        for qi, meta in enumerate(metadata):
            query = prepare(arrays["queries.features"][qi:qi + 1], arrays["queries.projections"][qi:qi + 1])
            scores = score_prepared(query, 0, candidates, compensate_roll=meta["compensateRoll"])
            if not np.isfinite(scores).all():
                raise FloatingPointError("Oracle produced a nonfinite score")
            chosen = stable_topk(scores, protocol["k"])
            oracle_ids[qi] = chosen
            oracle_scores[qi] = scores[chosen]
            if qi % 100 == 0 or qi + 1 == len(metadata):
                log("oracle_preparation", done=qi + 1, total=len(metadata))
        np.savez_compressed(args.output / "oracle.npz", ids=oracle_ids, scores=oracle_scores)
        shutil.copyfile(args.verification, args.output / "strong-exact-verification.json")
        shutil.copyfile(args.data / "strict-metric-verification.json", args.output / "strict-metric-verification.json")
        shutil.copyfile(library.with_suffix(".json"), args.output / "native-build.json")
        verify_file_map(HERE, source_hashes)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip()
        document = {
            "status": "frozen_before_performance_measurement", "frozen_at_utc": now(),
            "source_commit": commit, "source_sha256": source_hashes, "input_sha256": input_hashes,
            "protocol": protocol, "parent_protocol": original, "schedule": make_schedule(protocol),
            "oracle_sha256": digest(args.output / "oracle.npz"),
            "verification_sha256": digest(args.output / "strong-exact-verification.json"),
            "native_library": str(library.resolve()), "native_library_sha256": digest(library),
            "native_build_manifest_sha256": digest(library.with_suffix(".json")),
            "cold_native_build_wall_seconds": cold_native_build_seconds,
            "native_build_time_scope": "Fresh compiler/version/CPU inspection, compilation and manifest publication; excluded from query timings",
            "native_build": kernel.metadata, "cpu": cpu, "environment": environment(),
            "candidate_count": len(ids), "query_count": len(metadata), "orders": expected_orders,
        }
        write_json(args.output / "freeze.json", document)
        log("frozen", directory=str(args.output), passes=len(document["schedule"]),
            queries=len(metadata), freeze_sha256=digest(args.output / "freeze.json"))
    except BaseException as exc:
        write_json(args.output / "PREPARATION_FAILED.json", {"at_utc": now(), "error": repr(exc), "traceback": traceback.format_exc()})
        raise


def verify_frozen(root, data=None):
    frozen = json.loads((root / "freeze.json").read_text())
    verify_file_map(HERE, frozen["source_sha256"])
    if digest(root / "oracle.npz") != frozen["oracle_sha256"]:
        raise ValueError("Saved oracle changed")
    if digest(root / "strong-exact-verification.json") != frozen["verification_sha256"]:
        raise ValueError("Verification evidence changed")
    library = Path(frozen["native_library"])
    if digest(library) != frozen["native_library_sha256"] or digest(library.with_suffix(".json")) != frozen["native_build_manifest_sha256"]:
        raise ValueError("Native build changed")
    if data is not None:
        verify_file_map(data, frozen["input_sha256"])
    return frozen


def summarize(rows):
    values = np.asarray([row["elapsed_ms"] for row in rows], dtype=np.float64)
    return {
        "queries": len(rows), "total_ms": float(values.sum()), "mean_ms": float(values.mean()),
        "median_ms": float(np.median(values)), "p95_ms": float(np.percentile(values, 95)),
        "max_ms": float(values.max()), "mean_scored": float(np.mean([row["scored"] for row in rows])),
        "mean_bound_pairs": float(np.mean([row["bound_pair_evaluations"] for row in rows])),
        "mean_eligible": float(np.mean([row["eligible_count"] for row in rows])),
        "full_scans": sum(bool(row["full_scan"]) for row in rows),
        "ordered_top64_mismatches": sum(not row["ordered_ids_equal"] for row in rows),
        "maximum_score_absolute_error": max(row["maximum_score_absolute_error"] for row in rows),
    }


def one_pass(args):
    frozen = verify_frozen(args.output, args.data)
    load_protocol()
    entry = frozen["schedule"][args.entry]
    destination = args.output / "passes" / entry["id"]
    if not destination.is_dir() or any(destination.glob("*.json")):
        raise FileExistsError("Pass must have a fresh launcher-created directory")
    pin(frozen["cpu"])
    rows = []
    results_ids, results_scores = [], []
    started_at = now()
    manifest = {"entry": entry, "started_at_utc": started_at,
                "freeze_sha256": digest(args.output / "freeze.json"), "environment": environment()}
    write_json(destination / "manifest.json", manifest)
    try:
        started = time.perf_counter()
        _, metadata, arrays = load_arrays(args.data, frozen["parent_protocol"])
        read_seconds = time.perf_counter() - started
        oracle = np.load(args.output / "oracle.npz", allow_pickle=False)
        oracle_ids, oracle_scores = oracle["ids"], oracle["scores"]
        started = time.perf_counter()
        candidates = prepare(arrays["candidates.features"], arrays["candidates.projections"])
        descriptor_seconds = time.perf_counter() - started
        started = time.perf_counter()
        kernel = NativeKernel(frozen["native_library"]) if entry["method"].startswith("native_") else None
        kernel_load_seconds = time.perf_counter() - started
        started = time.perf_counter()
        engine = create_engine(entry["method"], candidates, k=frozen["protocol"]["k"], kernel=kernel)
        construction_seconds = time.perf_counter() - started
        construction = {
            "input_read_and_validation_seconds": read_seconds,
            "descriptor_seconds": descriptor_seconds, "kernel_load_seconds": kernel_load_seconds,
            "engine_build_seconds": construction_seconds, "descriptor_payload_bytes": candidates.nbytes,
            "engine": engine.construction,
            "memory_note": "Peak RSS includes source arrays and input validation, not only index payload; one engine per process",
        }
        write_json(destination / "construction.json", construction)
        for index in (0, len(candidates) // 2, len(candidates) - 1):
            warm = prepare(arrays["candidates.features"][index:index + 1], arrays["candidates.projections"][index:index + 1])
            engine.search(engine.prepare_query(warm), compensate_roll=True)
        engine.reset()
        order = frozen["orders"][entry["order"]]
        log("pass_ready", **entry, queries=len(order))
        with (destination / "metrics.jsonl").open("x") as stream:
            for position, qi in enumerate(order):
                started = time.perf_counter_ns()
                query = prepare(arrays["queries.features"][qi:qi + 1], arrays["queries.projections"][qi:qi + 1])
                backend_query = engine.prepare_query(query)
                chosen, scores, stats = engine.search(backend_query, compensate_roll=metadata[qi]["compensateRoll"])
                returned_ids, returned_scores = chosen.tolist(), scores.tolist()
                elapsed_ms = (time.perf_counter_ns() - started) / 1e6
                # No oracle scoring occurs here; all correctness work is outside the timer.
                actual_ids = np.asarray(returned_ids, dtype=np.int32)
                actual_scores = np.asarray(returned_scores, dtype=np.float64)
                valid_shape = actual_ids.shape == oracle_ids[qi].shape and actual_scores.shape == oracle_scores[qi].shape
                ids_equal = valid_shape and np.array_equal(actual_ids, oracle_ids[qi])
                finite = valid_shape and np.isfinite(actual_scores).all()
                max_error = float(np.max(np.abs(actual_scores - oracle_scores[qi]))) if finite else None
                row = {**entry, "position": position, "query_index": qi,
                       "source_frame": metadata[qi]["sourceFrameIndex"], "elapsed_ms": elapsed_ms,
                       "ordered_ids_equal": bool(ids_equal), "maximum_score_absolute_error": max_error, **stats}
                rows.append(row)
                results_ids.append(actual_ids)
                results_scores.append(actual_scores)
                stream.write(json.dumps(row, allow_nan=False) + "\n")
                if not ids_equal or not finite or max_error > 2e-12:
                    stream.flush()
                    write_json(destination / "MISMATCH.json", {
                        "row": row, "expected_ids": oracle_ids[qi].tolist(), "returned_ids": returned_ids,
                        "expected_scores": oracle_scores[qi].tolist(), "returned_scores": returned_scores,
                    })
                    raise AssertionError(f"Exactness gate failed at {entry['id']} query {qi}")
                if position % 100 == 0 or position + 1 == len(order):
                    stream.flush()
                    log("pass_progress", id=entry["id"], done=position + 1, total=len(order))
        np.savez_compressed(destination / "matches.npz", query_indexes=np.asarray(order, dtype=np.int32),
                            ids=np.asarray(results_ids, dtype=np.int32), scores=np.asarray(results_scores, dtype=np.float64))
        verify_frozen(args.output, args.data)
        if manifest["freeze_sha256"] != digest(args.output / "freeze.json"):
            raise ValueError("Run freeze changed during a measured pass")
        result = {"status": "pass", "entry": entry, "started_at_utc": started_at, "completed_at_utc": now(),
                  "summary": summarize(rows), "construction": construction, "manifest": manifest,
                  "manifest_sha256": digest(destination / "manifest.json"),
                  "final_state_payload_bytes": int(engine.state_nbytes),
                  "state_payload_definition": "Index/anchor-score and ID array payload only; temporal retained query descriptors and Python objects excluded; common candidate descriptors reported separately",
                  "process_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                  "matches_sha256": digest(destination / "matches.npz"),
                  "metrics_sha256": digest(destination / "metrics.jsonl")}
        write_json(destination / "summary.json", result)
        log("pass_complete", id=entry["id"], **result["summary"])
    except BaseException as exc:
        write_json(destination / "FAILED.json", {"entry": entry, "at_utc": now(), "error": repr(exc),
                   "traceback": traceback.format_exc(), "completed_queries": len(rows)})
        raise


def run(args):
    frozen = verify_frozen(args.output, args.data)
    pin(frozen["cpu"])
    if (args.output / "passes").exists():
        raise FileExistsError("Do not silently rerun or select among existing passes")
    (args.output / "passes").mkdir()
    with (args.output / "journal.jsonl").open("x") as journal:
        for entry in frozen["schedule"]:
            verify_frozen(args.output)
            destination = args.output / "passes" / entry["id"]
            destination.mkdir()
            event = {"event": "started", "at_utc": now(), **entry}
            journal.write(json.dumps(event) + "\n")
            journal.flush()
            log("launch", **entry)
            command = [sys.executable, str(Path(__file__).resolve()), "pass", "--data", str(args.data.resolve()),
                       "--output", str(args.output.resolve()), "--entry", str(entry["index"])]
            with (destination / "stdout.log").open("x") as stream:
                completed = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, check=False)
            event = {"event": "completed", "at_utc": now(), "returncode": completed.returncode, **entry}
            journal.write(json.dumps(event) + "\n")
            journal.flush()
            if completed.returncode:
                log("run_failed", entry=entry, returncode=completed.returncode,
                    output_log=str(destination / "stdout.log"))
                raise RuntimeError("A fixed pass failed; retained all evidence and stopped")
            result = json.loads((destination / "summary.json").read_text())
            log("completed", id=entry["id"], **result["summary"])
    write_json(args.output / "COMPLETE.json", {"status": "pass", "completed_at_utc": now(),
               "passes": len(frozen["schedule"]), "query_timings": frozen["protocol"]["expected_query_timings"]})


def collect(args):
    frozen = verify_frozen(args.output, args.data)
    if not (args.output / "COMPLETE.json").is_file():
        raise ValueError("The full fixed schedule has not completed")
    if args.public.exists():
        raise FileExistsError("Do not overwrite a public result bundle")
    all_rows, passes = [], []
    oracle = np.load(args.output / "oracle.npz", allow_pickle=False)
    for entry in frozen["schedule"]:
        destination = args.output / "passes" / entry["id"]
        summary = json.loads((destination / "summary.json").read_text())
        if summary["status"] != "pass" or summary["entry"] != entry:
            raise ValueError("Pass identity or status mismatch")
        for filename, key in (("matches.npz", "matches_sha256"), ("metrics.jsonl", "metrics_sha256"),
                              ("manifest.json", "manifest_sha256")):
            if digest(destination / filename) != summary[key]:
                raise ValueError("Pass evidence hash changed")
        manifest = json.loads((destination / "manifest.json").read_text())
        if (manifest != summary["manifest"] or manifest["entry"] != entry
                or manifest["freeze_sha256"] != digest(args.output / "freeze.json")
                or manifest["environment"] != frozen["environment"]):
            raise ValueError("Pass provenance/environment differs from the frozen run")
        rows = [json.loads(line) for line in (destination / "metrics.jsonl").read_text().splitlines()]
        order = frozen["orders"][entry["order"]]
        if [row["query_index"] for row in rows] != order or summarize(rows) != summary["summary"]:
            raise ValueError("Incomplete, reordered, or altered per-query rows")
        if any(row["position"] != position or any(row.get(key) != value for key, value in entry.items())
               for position, row in enumerate(rows)):
            raise ValueError("Per-query pass identity or position mismatch")
        matches = np.load(destination / "matches.npz", allow_pickle=False)
        if not np.array_equal(matches["query_indexes"], order) or not np.array_equal(matches["ids"], oracle["ids"][order]):
            raise AssertionError("Saved returned IDs differ from exhaustive oracle")
        if not np.allclose(matches["scores"], oracle["scores"][order], atol=2e-12, rtol=0):
            raise AssertionError("Saved returned scores differ from exhaustive oracle")
        all_rows.extend(rows)
        passes.append(summary)
    if len(all_rows) != frozen["protocol"]["expected_query_timings"]:
        raise ValueError("Incomplete fixed experiment")
    summaries, comparisons = {}, {}
    for order in frozen["protocol"]["orders"]:
        summaries[order] = {}
        for method in METHODS:
            subset = [row for row in all_rows if row["order"] == order and row["method"] == method]
            method_passes = sorted([row for row in passes if row["entry"]["order"] == order and row["entry"]["method"] == method],
                                   key=lambda row: row["entry"]["repeat"])
            summaries[order][method] = {
                **summarize(subset), "repetitions": [row["summary"] for row in method_passes],
                "median_engine_build_seconds": float(np.median([row["construction"]["engine_build_seconds"] for row in method_passes])),
                "max_process_peak_rss_bytes": max(row["process_peak_rss_bytes"] for row in method_passes),
                "max_state_payload_bytes": max(row["final_state_payload_bytes"] for row in method_passes),
            }
        current = summaries[order]
        comparisons[order] = {
            "numpy_exhaustive_over_native_exhaustive": current["numpy_exhaustive"]["mean_ms"] / current["native_exhaustive"]["mean_ms"],
            "numpy_exhaustive_over_numpy_temporal": current["numpy_exhaustive"]["mean_ms"] / current["numpy_temporal"]["mean_ms"],
            "native_exhaustive_over_native_temporal": current["native_exhaustive"]["mean_ms"] / current["native_temporal"]["mean_ms"],
            "native_exhaustive_over_native_pivot8": current["native_exhaustive"]["mean_ms"] / current["native_pivot8"]["mean_ms"],
            "native_exhaustive_over_native_pivot32": current["native_exhaustive"]["mean_ms"] / current["native_pivot32"]["mean_ms"],
        }
    # Both fixed indexes are independent of the query order and repetition.
    pivots = {}
    for method in ("native_pivot8", "native_pivot32"):
        selected = [row["construction"]["engine"].get("pivot_indexes") for row in passes if row["entry"]["method"] == method]
        if selected[0] is None or any(value != selected[0] for value in selected):
            raise ValueError("Pivot selection changed across processes")
        pivots[method] = selected[0]
    if pivots["native_pivot8"] != pivots["native_pivot32"][:8]:
        raise ValueError("Fixed pivot-prefix condition failed")
    args.public.mkdir(parents=True)
    for filename in ("freeze.json", "preparation.json", "oracle.npz", "strong-exact-verification.json",
                     "strict-metric-verification.json", "native-build.json", "journal.jsonl", "COMPLETE.json"):
        shutil.copyfile(args.output / filename, args.public / filename)
    write_json(args.public / "summary.json", {
        "status": "pass", "passes": len(passes), "query_timings": len(all_rows),
        "summaries": summaries, "comparisons": comparisons, "pivots": pivots,
        "environment": frozen["environment"], "protocol_sha256": frozen["source_sha256"]["protocol-v2.json"],
        "scope": frozen["protocol"]["interpretation"],
    })
    write_json(args.public / "passes.json", passes)
    columns = sorted({name for row in all_rows for name in row})
    # Fixed gzip timestamp makes exported evidence deterministic.
    import io
    with (args.public / "per-query-metrics.csv.gz").open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as zipped:
            with io.TextIOWrapper(zipped, encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=columns)
                writer.writeheader()
                writer.writerows(all_rows)
    for entry in frozen["schedule"]:
        destination = args.public / "matches"
        destination.mkdir(exist_ok=True)
        shutil.copyfile(args.output / "passes" / entry["id"] / "matches.npz", destination / f"{entry['id']}.npz")
    lines = ["# Strong exact search comparison (V2)", "", "All 36 fixed passes completed; 36,396 query timings.", "",
             "Every ordered top-64 result matched the precomputed NumPy exhaustive oracle. This is score-ranking agreement, not a human similarity or identity-accuracy measure.", "",
             "| Order | Method | Mean ms | Median ms | p95 ms | Max ms | Mean candidates scored | Full scans / 3,033 |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for order, methods in summaries.items():
        for method, values in methods.items():
            lines.append(f"| {order} | {method} | {values['mean_ms']:.6f} | {values['median_ms']:.6f} | {values['p95_ms']:.6f} | {values['max_ms']:.6f} | {values['mean_scored']:.3f} | {values['full_scans']} |")
    lines += ["", "## Within-run speed ratios", "", "A ratio greater than one means the denominator method was faster.", ""]
    for order, values in comparisons.items():
        lines.append(f"### {order}\n")
        lines.extend(f"- {name}: {value:.6f}" for name, value in values.items())
        lines.append("")
    lines += ["## Interpretation limits", "", frozen["protocol"]["interpretation"], "",
              "Each child used one engine, one logical CPU, and one numerical thread. Six fixed blocks balance method positions across the complete run, not completely within each order. Repetition and construction/RSS details are in passes.json and summary.json. The shared host was not an isolated physical machine.", "",
              "Native means the shared score evaluator is C++; query preparation, controller, masks and canonical top-k still use Python/NumPy. Fixed-pivot configurations include their own seed policy and report both roll-policy tables in their memory/build costs. No threshold was selected using these timings.", "",
              "Evidence: freeze.json locks code, inputs, binary, oracle and schedule; per-query-metrics.csv.gz retains every measured query; matches/ retains every returned ID and score; oracle.npz contains the saved reference. No V1 timings are pooled into this report.", ""]
    (args.public / "REPORT.md").write_text("\n".join(lines))
    write_json(args.public / "PUBLIC_MANIFEST.json", {
        "created_at_utc": now(), "source_run_freeze_sha256": digest(args.output / "freeze.json"),
        "files": {str(path.relative_to(args.public)): {"sha256": digest(path), "bytes": path.stat().st_size}
                  for path in sorted(args.public.rglob("*")) if path.is_file()},
        "status": "complete", "excluded_measurement_attempts": [],
    })
    log("collected", output=str(args.public), passes=len(passes), queries=len(all_rows), comparisons=comparisons)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("freeze", "run", "pass", "collect"))
    parser.add_argument("--data", type=Path, default=REPO / "work/face-search")
    parser.add_argument("--output", type=Path, required=True, help="Immutable run directory")
    parser.add_argument("--verification", type=Path)
    parser.add_argument("--library", type=Path)
    parser.add_argument("--cpu", type=int)
    parser.add_argument("--entry", type=int)
    parser.add_argument("--public", type=Path)
    args = parser.parse_args()
    if args.command == "freeze" and (args.verification is None or args.library is None):
        parser.error("freeze requires --verification and --library")
    if args.command == "pass" and args.entry is None:
        parser.error("pass requires --entry")
    if args.command == "collect" and args.public is None:
        parser.error("collect requires --public")
    {"freeze": freeze, "run": run, "pass": one_pass, "collect": collect}[args.command](args)


if __name__ == "__main__":
    main()
