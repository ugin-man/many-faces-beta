#!/usr/bin/env python3
"""Standalone exact-search diagnostic, implemented anew after environment loss.

This is a post-observation control, not a preregistered experiment. It never
modifies the frozen primary protocol, scoring code, inputs or primary results.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import resource
import statistics
import subprocess
import sys
import time
import traceback

for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
POLICY_PATH = HERE / "control-policy.json"
METHODS = ("exhaustive_strict", "temporal_exact")
RUNTIME_KEYS = ("platform", "python", "numpy", "faiss", "faiss_compile",
                "cpu_count", "faiss_threads", "cpu_affinity", "cpu_model")
CURRENT_PHASE = "arguments"
CURRENT_PASS = None
CURRENT_QUERY = None


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    def reject_constant(value):
        raise ValueError("Nonfinite JSON constant: " + value)
    return json.loads(Path(path).read_text(), parse_constant=reject_constant)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.replace(path)


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, allow_nan=False), flush=True)


def cpu_model():
    path = Path("/proc/cpuinfo")
    require(path.exists(), "Linux CPU evidence is required")
    return next((line.split(":", 1)[1].strip() for line in path.read_text().splitlines()
                 if line.startswith("model name")), "unknown")


def runtime_info(np, faiss):
    return {
        "platform": platform.platform(), "python": sys.version, "numpy": np.__version__,
        "faiss": faiss.__version__, "faiss_compile": faiss.get_compile_options(),
        "cpu_count": os.cpu_count(), "faiss_threads": faiss.omp_get_max_threads(),
        "cpu_affinity": sorted(os.sched_getaffinity(0)), "cpu_model": cpu_model(),
    }


def relative_file(root, name):
    path = (root / name).resolve()
    require(path.is_relative_to(root.resolve()), "File path escapes its evidence root")
    return path


def all_methods(protocol):
    result = list(METHODS)
    for budget in protocol["candidate_budgets"]:
        result.extend((f"faiss_flat_{budget}", f"faiss_hnsw_{budget}"))
    return result


def policy_and_sources():
    policy = read_json(POLICY_PATH)
    require(policy["candidates"] == 70000 and policy["queries_per_pass"] == 1011
            and policy["k"] == 64 and policy["threads"] == 1, "Unexpected control policy")
    expected_schedule = [
        {"pass": 0, "order": "original", "method": METHODS[0], "repeat": 0},
        {"pass": 1, "order": "original", "method": METHODS[1], "repeat": 0},
        {"pass": 2, "order": "original", "method": METHODS[1], "repeat": 1},
        {"pass": 3, "order": "original", "method": METHODS[0], "repeat": 1},
        {"pass": 4, "order": "shuffled", "method": METHODS[1], "repeat": 0},
        {"pass": 5, "order": "shuffled", "method": METHODS[0], "repeat": 0},
    ]
    require(policy["schedule"] == expected_schedule, "Control schedule changed")
    require(policy["absolute_score_tolerance"] == 2e-12
            and policy["relative_score_tolerance"] == 0, "Control score tolerance changed")
    require(digest(HERE / "protocol.json") == policy["primary_protocol_sha256"],
            "Primary protocol differs from the frozen 538 version")
    for name, expected in policy["primary_code_sha256"].items():
        require(digest(HERE / name) == expected, "Primary code changed: " + name)
    protocol = read_json(HERE / "protocol.json")
    require(protocol["source_commit"] == policy["production_source_commit"],
            "Production commit differs")
    require(protocol["k"] == 64 and protocol["threads"] == 1
            and protocol["repetitions"] == 3, "Primary count or threading policy differs")
    return policy, protocol


def primary_ready(experiment, policy, protocol):
    """Cheap completion/source check. No input binary is scanned here."""
    require(not (experiment / "failure.json").exists(), "Primary failure evidence is present")
    execution = read_json(experiment / "execution.json")
    require(execution.get("completed") is True and not execution.get("failure"),
            "Primary experiment is not complete; control must wait")
    require(execution.get("repetitions") == 3 and execution.get("parallel_benchmarks") is False,
            "Primary run must contain three sequential repetitions")
    require(execution.get("production_source_commit") == policy["production_source_commit"],
            "Primary execution has a different production source")
    affinity = execution.get("measurement_affinity")
    require(isinstance(affinity, list) and len(affinity) == 1
            and isinstance(affinity[0], int), "Primary single-CPU affinity is missing")
    expected_steps = [("python", 0), ("current", 0), ("current", 1),
                      ("python", 1), ("python", 2), ("current", 2)]
    steps = execution.get("steps", [])
    require([(s.get("kind"), s.get("repeat")) for s in steps] == expected_steps,
            "Primary execution does not contain the complete fixed schedule")
    previous_end = execution["started_unix"]
    for step in steps:
        require(step.get("exit_code") == 0 and step["finished_unix"] >= step["started_unix"]
                and step["started_unix"] >= previous_end, "Primary step failed or overlapped")
        previous_end = step["finished_unix"]
    require(execution.get("finished_unix", 0) >= previous_end, "Primary finish time is invalid")
    manifests = []
    for repeat in range(3):
        directory = experiment / f"python-{repeat}"
        require(not (directory / "failure.json").exists(), "Primary Python failure evidence is present")
        manifest = read_json(directory / "manifest.json")
        require(manifest.get("completed") is True and manifest.get("temporal_exact_matches") is True,
                "Primary Python repetition is incomplete")
        require(manifest.get("repeat") == repeat and manifest.get("smoke_queries") == 0,
                "Smoke, partial, or wrong primary repetition")
        require(manifest.get("candidate_count") == 70000 and manifest.get("query_count") == 1011,
                "Primary experiment does not contain every fixed input")
        require(manifest.get("all_protocol_orders") is True
                and sorted(manifest.get("selected_orders", [])) == ["original", "shuffled"],
                "Primary repetition is missing an order")
        require(manifest.get("protocol_sha256") == policy["primary_protocol_sha256"]
                and manifest.get("protocol") == protocol
                and manifest.get("code_sha256") == policy["primary_code_sha256"],
                "Primary source/protocol lock differs")
        require(manifest.get("cpu_affinity") == affinity and manifest.get("faiss_threads") == 1,
                "Primary runtime affinity or thread count differs")
        require(manifest.get("faiss") == protocol["faiss_version"], "Primary Faiss version differs")
        for name, expected in protocol["input_lock"].items():
            if name.endswith((".f64", ".json")):
                require(manifest["input_sha256"].get(name) == expected,
                        "Primary input differs from frozen protocol: " + name)
        if manifests:
            require(manifest["input_sha256"] == manifests[0]["input_sha256"],
                    "Primary repetitions used different inputs")
            require({key: manifest[key] for key in RUNTIME_KEYS}
                    == {key: manifests[0][key] for key in RUNTIME_KEYS},
                    "Primary repetitions used different runtimes")
        for name in ("oracle.json", "original.jsonl", "shuffled.jsonl", "summary.json", "construction.json",
                     "matches-original.npz", "matches-shuffled.npz"):
            require((directory / name).is_file(), "Primary evidence is missing: " + name)
        require((experiment / f"current-{repeat}.json").is_file(), "Primary current baseline is missing")
        manifests.append(manifest)
    return execution, manifests


def freeze_lock(args, policy, protocol, execution, manifests):
    input_hashes = manifests[0]["input_sha256"]
    for name, expected in input_hashes.items():
        require(digest(relative_file(args.data, name)) == expected,
                "Current input differs from successful primary run: " + name)
    parity = read_json(args.data / "strict-metric-verification.json")
    require(parity.get("status") == "pass"
            and parity.get("pythonPortSha256") == policy["primary_code_sha256"]["strict_metric.py"],
            "Metric parity evidence is missing or stale")
    source_hashes = {}
    for name in (*policy["primary_code_sha256"].keys(), "protocol.json",
                 "isolated_control.py", "control-policy.json"):
        source_hashes[str((HERE / name).relative_to(REPO))] = digest(HERE / name)
    for name, expected in parity["sourceHashes"].items():
        path = (HERE / name).resolve()
        require(path.is_relative_to(REPO), "Production source leaves repository")
        require(digest(path) == expected, "Production score source changed since parity verification")
        source_hashes[str(path.relative_to(REPO))] = expected
    evidence_hashes = {"execution.json": digest(args.experiment / "execution.json")}
    oracle_hashes = []
    for repeat in range(3):
        for name in ("manifest.json", "oracle.json", "original.jsonl", "shuffled.jsonl",
                     "summary.json", "construction.json"):
            relative = f"python-{repeat}/{name}"
            evidence_hashes[relative] = digest(args.experiment / relative)
        current = f"current-{repeat}.json"
        evidence_hashes[current] = digest(args.experiment / current)
        oracle_hashes.append(evidence_hashes[f"python-{repeat}/oracle.json"])
    require(len(set(oracle_hashes)) == 1, "Saved primary oracle differs across repetitions")
    return {
        "schema_version": 2, "policy": policy, "protocol": protocol,
        "data": str(args.data), "experiment": str(args.experiment), "output": str(args.output),
        "created_unix": time.time(), "primary_execution": execution,
        "primary_manifests": manifests,
        "input_sha256": input_hashes, "source_sha256": source_hashes,
        "primary_evidence_sha256": evidence_hashes,
        "oracle_relative": "python-0/oracle.json", "oracle_sha256": oracle_hashes[0],
        "runtime": {key: manifests[0][key] for key in RUNTIME_KEYS},
        "measurement_affinity": execution["measurement_affinity"],
        "implementation": policy["implementation"],
    }


def verify_lock(lock_path, expected_sha, *, full=True):
    require(digest(lock_path) == expected_sha, "Control lock changed")
    lock = read_json(lock_path)
    require(lock["policy"] == read_json(POLICY_PATH), "Control policy changed")
    for name, expected in lock["source_sha256"].items():
        require(digest(relative_file(REPO, name)) == expected, "Source changed after lock: " + name)
    for name, expected in lock["primary_evidence_sha256"].items():
        require(digest(relative_file(Path(lock["experiment"]), name)) == expected,
                "Primary evidence changed after lock: " + name)
    if full:
        for name, expected in lock["input_sha256"].items():
            require(digest(relative_file(Path(lock["data"]), name)) == expected,
                    "Input changed after lock: " + name)
    return lock


def load_oracle(lock, np):
    path = Path(lock["experiment"]) / lock["oracle_relative"]
    require(digest(path) == lock["oracle_sha256"], "Saved oracle changed")
    document = read_json(path)
    require(document["query_indices"] == list(range(1011)), "Oracle query enumeration is incomplete")
    indexes = np.asarray(document["indices"])
    scores = np.asarray(document["scores"], dtype=np.float64)
    require(indexes.shape == (1011, 64) and scores.shape == (1011, 64),
            "Oracle has an invalid shape")
    require(indexes.dtype.kind in "iu" and np.all((indexes >= 0) & (indexes < 70000)),
            "Oracle indexes are invalid")
    require(np.isfinite(scores).all() and np.all(np.diff(scores, axis=1) >= 0),
            "Oracle scores are nonfinite or unsorted")
    require(all(len(set(row.tolist())) == 64 for row in indexes), "Oracle has duplicate candidates")
    for row_ids, row_scores in zip(indexes, scores):
        tied = np.diff(row_scores) == 0
        require(np.all(np.diff(row_ids)[tied] > 0), "Oracle tie order is not canonical")
    indexes.setflags(write=False)
    scores.setflags(write=False)
    return indexes, scores


def control_run(args):
    global CURRENT_PHASE, CURRENT_PASS
    CURRENT_PHASE = "primary-readiness"
    policy, protocol = policy_and_sources()
    execution, manifests = primary_ready(args.experiment, policy, protocol)
    if args.check_ready:
        log("control-ready", primary_completed=True, primary_repetitions=3,
            measurement_affinity=execution["measurement_affinity"])
        return
    require(not args.output.exists(), "Refuse to overwrite any control output, including a failed run")
    CURRENT_PHASE = "freeze"
    lock = freeze_lock(args, policy, protocol, execution, manifests)
    args.output.mkdir(parents=True)
    lock_path = args.output / "lock.json"
    write_json(lock_path, lock)
    lock_sha = digest(lock_path)
    environment = dict(os.environ)
    if args.python_dependencies:
        environment["PYTHONPATH"] = str(args.python_dependencies.resolve()) + (
            os.pathsep + environment["PYTHONPATH"] if environment.get("PYTHONPATH") else "")
    record = {"schema_version": 2, "lock_sha256": lock_sha, "completed": False,
              "parallel_benchmarks": False, "started_unix": time.time(), "steps": [],
              "measurement_affinity": execution["measurement_affinity"],
              "implementation": policy["implementation"]}
    write_json(args.output / "control-execution.json", record)
    try:
        for item in policy["schedule"]:
            CURRENT_PASS = item["pass"]
            CURRENT_PHASE = "launch-worker"
            verify_lock(lock_path, lock_sha, full=False)
            command = [sys.executable, str(HERE / "isolated_control.py"), "--experiment", str(args.experiment),
                       "--data", str(args.data), "--output", str(args.output),
                       "--worker", str(item["pass"]), "--lock-sha", lock_sha]
            step = {**item, "command": command, "started_unix": time.time()}
            record["steps"].append(step)
            write_json(args.output / "control-execution.json", record)
            with (args.output / f"pass-{item['pass']}.log").open("w") as logfile:
                process = subprocess.Popen(command, cwd=REPO, env=environment,
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           text=True, bufsize=1)
                step["pid"] = process.pid
                write_json(args.output / "control-execution.json", record)
                for line in process.stdout:
                    logfile.write(line)
                    logfile.flush()
                    print(line, end="", flush=True)
                code = process.wait()
            step.update({"finished_unix": time.time(), "exit_code": code})
            write_json(args.output / "control-execution.json", record)
            require(code == 0, f"Control pass {item['pass']} failed with exit code {code}")
        CURRENT_PHASE = "final-invariance"
        verify_lock(lock_path, lock_sha)
        record.update({"completed": True, "finished_unix": time.time()})
        write_json(args.output / "control-execution.json", record)
    except BaseException as error:
        record.update({"failure": {"type": type(error).__name__, "message": str(error)},
                       "finished_unix": time.time()})
        write_json(args.output / "control-execution.json", record)
        raise
    analyze(args)


def validate_result(chosen, scores, expected_ids, expected_scores, np):
    require(chosen.shape == (64,) and scores.shape == (64,), "Returned top-k shape differs")
    require(chosen.dtype.kind in "iu" and np.all((chosen >= 0) & (chosen < 70000))
            and len(set(chosen.tolist())) == 64, "Returned indexes are invalid")
    require(np.isfinite(scores).all() and np.all(np.diff(scores) >= 0),
            "Returned scores are nonfinite or unsorted")
    require(np.array_equal(chosen, expected_ids), "Global top-64 IDs or rank differ from saved oracle")
    difference = np.abs(scores - expected_scores)
    require(np.all(difference <= 2e-12), "Strict-score parity exceeds absolute 2e-12 tolerance")
    return float(difference.max()), max(0.0, float(scores[0] - expected_scores[0]))


def validate_temporal_stats(stats, position, method):
    scored = stats.get("scored")
    require(isinstance(scored, int) and 64 <= scored <= 70064, "Invalid scored-candidate count")
    require(isinstance(stats.get("full_scan"), bool), "Missing full-scan flag")
    if method == "exhaustive_strict":
        require(scored == 70000 and stats["full_scan"], "Exhaustive engine did not score entire database")
        return
    require(stats.get("queries_seen") == position + 1, "Temporal history did not reset or skipped a query")
    require(stats.get("total_candidates") == 70000, "Temporal database size differs")
    require(stats.get("score_evaluations") == scored, "Temporal score-accounting mismatch")
    if position == 0:
        require(stats.get("reason") == "initial" and stats["full_scan"]
                and stats.get("anchor_generation") == 1 and scored == 70000,
                "First temporal query has nonempty history")
    if stats["full_scan"]:
        require(stats.get("unique_candidates_scored") == 70000, "Incomplete temporal fallback")
    else:
        require(stats.get("reason") == "bounded_subset"
                and stats.get("unique_candidates_scored") == scored
                and stats.get("eligible_count") == scored, "Invalid bounded-subset accounting")


def worker(args):
    global CURRENT_PHASE, CURRENT_PASS, CURRENT_QUERY
    CURRENT_PASS = args.worker
    CURRENT_PHASE = "worker-lock"
    require(args.lock_sha is not None, "Worker requires immutable lock hash")
    lock_path = args.output / "lock.json"
    lock = verify_lock(lock_path, args.lock_sha)
    require(str(args.data) == lock["data"] and str(args.experiment) == lock["experiment"]
            and str(args.output) == lock["output"], "Worker roots differ from control lock")
    policy, protocol = policy_and_sources()
    require(0 <= args.worker < len(policy["schedule"]), "Worker pass number out of range")
    item = policy["schedule"][args.worker]
    affinity = set(lock["measurement_affinity"])
    require(hasattr(os, "sched_setaffinity") and affinity <= os.sched_getaffinity(0),
            "Primary CPU is not available to worker")
    os.sched_setaffinity(0, affinity)
    CURRENT_PHASE = "worker-import"
    import numpy as np
    import faiss
    from benchmark import load_arrays
    from engines import ExhaustiveStrict
    from strict_metric import prepare
    from temporal_exact import TemporalExact, REFRESH_FRACTION, BOUND_EPSILON_FACTOR
    faiss.omp_set_num_threads(1)
    observed = runtime_info(np, faiss)
    require(observed == lock["runtime"], "Worker runtime/hardware differs from successful new primary run")
    require(REFRESH_FRACTION == protocol["temporal_exact"]["fallback_fraction"]
            and BOUND_EPSILON_FACTOR == protocol["temporal_exact"]["floating_margin_scale"],
            "Temporal constants differ from primary protocol")
    expected_ids, expected_scores = load_oracle(lock, np)
    orders = read_json(args.data / "orders.json")
    fixed_orders = {
        "original": list(range(1011)),
        "shuffled": np.random.Generator(np.random.PCG64(protocol["shuffle_seed"])).permutation(1011).tolist(),
    }
    require(orders == {"seed": protocol["shuffle_seed"], "orders": fixed_orders},
            "Query orders differ from fixed protocol")
    order = fixed_orders[item["order"]]
    directory = args.output / f"pass-{args.worker}"
    require(not directory.exists(), "Refuse to overwrite an existing pass")
    directory.mkdir()
    manifest = {
        "schema_version": 2, **item, "completed": False, "lock_sha256": args.lock_sha,
        "pid": os.getpid(), "runtime": observed, "started_unix": time.time(),
        "query_count": 1011, "candidate_count": 70000, "k": 64,
        "engines_constructed": [item["method"]], "ann_indexes_constructed": 0,
        "measured_passes": 1, "source_sha256": lock["source_sha256"],
        "input_sha256": lock["input_sha256"], "oracle_sha256": lock["oracle_sha256"],
        "validation": {"absolute_score_tolerance": 2e-12, "relative_score_tolerance": 0},
    }
    write_json(directory / "manifest.json", manifest)
    try:
        CURRENT_PHASE = "candidate-preparation"
        started = time.perf_counter()
        ids, metadata, arrays = load_arrays(args.data, protocol)
        read_seconds = time.perf_counter() - started
        require(len(ids) == 70000 and len(metadata) == 1011, "Worker omitted fixed inputs")
        started = time.perf_counter()
        candidates = prepare(arrays["candidates.features"], arrays["candidates.projections"])
        descriptor_seconds = time.perf_counter() - started
        started = time.perf_counter()
        engine = (ExhaustiveStrict(candidates, k=64) if item["method"] == "exhaustive_strict"
                  else TemporalExact(candidates, k=64))
        engine_construct_seconds = time.perf_counter() - started
        started = time.perf_counter()
        for source in (0, len(ids) // 2, len(ids) - 1):
            warm = prepare(arrays["candidates.features"][source:source + 1],
                           arrays["candidates.projections"][source:source + 1])
            engine.search(warm)
        engine.reset()
        warmup_seconds = time.perf_counter() - started
        construction = {
            "input_read_seconds": read_seconds, "descriptor_seconds": descriptor_seconds,
            "engine_construct_seconds": engine_construct_seconds, "warmup_seconds": warmup_seconds,
            "descriptor_payload_bytes": int(candidates.nbytes),
            "warmup_catalog_indices": [0, len(ids) // 2, len(ids) - 1],
            "warmup_count": 3, "reset_after_warmup": True, "ann_indexes_constructed": 0,
            "note": "Only the measured engine exists; competing ANN indexes are not allocated.",
        }
        write_json(directory / "construction.json", construction)
        raw_ids = np.empty((1011, 64), dtype=np.int32)
        raw_scores = np.empty((1011, 64), dtype=np.float64)
        max_score_error = 0.0
        log("control-pass-ready", **item, runtime=observed, construction=construction)
        CURRENT_PHASE = "timed-pass"
        pass_started = time.perf_counter()
        with (directory / "observations.jsonl").open("w") as evidence:
            for position, query_index in enumerate(order):
                CURRENT_QUERY = query_index
                started_ns = time.perf_counter_ns()
                query = prepare(arrays["queries.features"][query_index:query_index + 1],
                                arrays["queries.projections"][query_index:query_index + 1])
                chosen, scores, stats = engine.search(
                    query, compensate_roll=metadata[query_index]["compensateRoll"])
                returned_ids, returned_scores = chosen.tolist(), scores.tolist()
                elapsed_ms = (time.perf_counter_ns() - started_ns) / 1e6
                # Oracle access, all validation, storage and serialization are outside the timer.
                error, gap = validate_result(
                    np.asarray(returned_ids), np.asarray(returned_scores),
                    expected_ids[query_index], expected_scores[query_index], np)
                require(math.isfinite(elapsed_ms) and elapsed_ms > 0, "Invalid query duration")
                validate_temporal_stats(stats, position, item["method"])
                raw_ids[position] = returned_ids
                raw_scores[position] = returned_scores
                max_score_error = max(max_score_error, error)
                row = {
                    **item, "position": position, "query_index": query_index,
                    "source_frame": metadata[query_index]["sourceFrameIndex"],
                    "elapsed_ms": elapsed_ms, "recall1": 1.0, "recall10": 1.0, "recall64": 1.0,
                    "score_excess": gap, "max_absolute_score_error": error, **stats,
                }
                evidence.write(json.dumps(row, allow_nan=False) + "\n")
                if position % 100 == 0 or position + 1 == len(order):
                    evidence.flush()
                    log("control-progress", **item, done=position + 1, total=len(order),
                        elapsed_seconds=time.perf_counter() - pass_started)
        np.savez_compressed(directory / "matches.npz", query_indices=np.asarray(order),
                            indices=raw_ids, scores=raw_scores)
        CURRENT_PHASE = "worker-final-invariance"
        verify_lock(lock_path, args.lock_sha)
        manifest.update({
            "completed": True, "finished_unix": time.time(),
            "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "validation": {"ordered_top64_equal": True, "all_queries": 1011,
                           "absolute_score_tolerance": 2e-12, "relative_score_tolerance": 0,
                           "max_absolute_score_error": max_score_error},
            "files_sha256": {name: digest(directory / name)
                             for name in ("observations.jsonl", "matches.npz", "construction.json")},
        })
        write_json(directory / "manifest.json", manifest)
        log("control-pass-complete", **item, queries=1011,
            max_absolute_score_error=max_score_error, peak_rss_bytes=manifest["peak_rss_bytes"])
    except BaseException as error:
        write_json(directory / "failure.json", {
            "type": type(error).__name__, "message": str(error), "phase": CURRENT_PHASE,
            "pass": CURRENT_PASS, "query_index": CURRENT_QUERY, "time": time.time(),
        })
        raise


def read_rows(path):
    with Path(path).open() as stream:
        return [json.loads(line) for line in stream if line.strip()]


def percentile(values, percent):
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summarize_rows(rows):
    require(bool(rows), "Cannot summarize an empty group")
    times = [row["elapsed_ms"] for row in rows]
    require(all(math.isfinite(value) and value > 0 for value in times), "Invalid measured times")
    recalls = {f"mean_recall{k}": statistics.fmean(row[f"recall{k}"] for row in rows)
               for k in (1, 10, 64)}
    return {
        "observations": len(rows), "distinct_queries": len({row["query_index"] for row in rows}),
        "total_ms": math.fsum(times), "mean_ms": statistics.fmean(times),
        "p50_ms": percentile(times, 50), "p95_ms": percentile(times, 95), "max_ms": max(times),
        **recalls, "min_recall64": min(row["recall64"] for row in rows),
        "missed_frames": sum(row["recall64"] != 1 for row in rows),
        "mean_top1_gap": statistics.fmean(row["score_excess"] for row in rows),
        "max_top1_gap": max(row["score_excess"] for row in rows),
        "mean_scored": statistics.fmean(row["scored"] for row in rows),
        "total_scored": sum(row["scored"] for row in rows),
        "full_scans": sum(bool(row["full_scan"]) for row in rows),
    }


def primary_predecessor_diagnostic(lock, orders):
    """Observed strata of the new primary run, never combined with control times."""
    methods = all_methods(lock["protocol"])
    diagnosis = {}
    experiment = Path(lock["experiment"])
    for order_name in ("original", "shuffled"):
        strata = {}
        aggregate_exact, aggregate_temporal = [], []
        for repeat in range(3):
            rows = read_rows(experiment / f"python-{repeat}/{order_name}.jsonl")
            require(len(rows) == 1011 * len(methods), "Primary diagnostic contains missing or extra rows")
            for position, query_index in enumerate(orders[order_name]):
                block = rows[position * len(methods):(position + 1) * len(methods)]
                shift = (position + repeat) % len(methods)
                require([row["method"] for row in block] == methods[shift:] + methods[:shift],
                        "Primary observed method sequence differs from recorded cyclic rotation")
                for row in block:
                    require(row["order"] == order_name and row["position"] == position
                            and row["query_index"] == query_index, "Primary query accounting mismatch")
                    require(math.isfinite(row["elapsed_ms"]) and row["elapsed_ms"] > 0,
                            "Nonfinite primary timing")
                    for k in (1, 10, 64):
                        require(math.isfinite(row[f"recall{k}"]) and 0 <= row[f"recall{k}"] <= 1,
                                "Invalid primary recall")
                by_name = {row["method"]: row for row in block}
                exact, temporal = by_name[METHODS[0]], by_name[METHODS[1]]
                require(all(row[f"recall{k}"] == 1 for row in (exact, temporal) for k in (1, 10, 64)),
                        "Primary exact engine has an observed miss")
                for row in (exact, temporal):
                    validate_temporal_stats(row, position, row["method"])
                index = [row["method"] for row in block].index(METHODS[1])
                predecessor = block[index - 1]["method"] if index else "first_in_query_group"
                key = (predecessor, temporal["full_scan"])
                entry = strata.setdefault(key, {"exact": [], "temporal": []})
                entry["exact"].append(exact)
                entry["temporal"].append(temporal)
                aggregate_exact.append(exact)
                aggregate_temporal.append(temporal)
        groups = []
        for (predecessor, full_scan), entry in sorted(strata.items()):
            exact = summarize_rows(entry["exact"])
            temporal = summarize_rows(entry["temporal"])
            groups.append({
                "previous_method_in_same_query_group": predecessor,
                "temporal_full_scan": full_scan, "observations": temporal["observations"],
                "exhaustive_mean_ms": exact["mean_ms"], "temporal_mean_ms": temporal["mean_ms"],
                "ratio_of_paired_total_times_exhaustive_over_temporal":
                    exact["total_ms"] / temporal["total_ms"],
            })
        exact = summarize_rows(aggregate_exact)
        temporal = summarize_rows(aggregate_temporal)
        diagnosis[order_name] = {
            "primary_repetitions": 3, "strata": groups,
            "interleaved_exhaustive_mean_ms": exact["mean_ms"],
            "interleaved_temporal_mean_ms": temporal["mean_ms"],
            "interleaved_ratio_of_total_times_exhaustive_over_temporal":
                exact["total_ms"] / temporal["total_ms"],
        }
    return {
        "basis": "Successful new-hardware primary run only; these observations are not pooled with isolated control.",
        "qualification": "Cyclic rotation changes positions but preserves most exhaustive-to-temporal adjacency. "
                         "Strata contain different queries and are observational, not a causal estimate. "
                         "Standalone control also removes competing ANN allocations; it does not isolate cache effects alone.",
        "orders": diagnosis,
    }


def report_markdown(summary):
    lines = [
        "# Isolated exact-search diagnostic",
        "",
        "Status: **complete and validated**. All six fixed fresh-process passes are retained.",
        "",
        "This implementation was authored anew after the original cloud environment became unavailable. "
        "It is a post-observation diagnostic, not preregistration. The interrupted host's measurements "
        "are not included. The main interleaved experiment and this standalone condition remain separate.",
        "",
        "## Measurement and validation",
        "",
        f"- Database: {summary['input']['candidates']:,} canonical candidates.",
        f"- Each pass: all {summary['input']['queries']:,} valid queries from the fixed existing clip; top 64.",
        "- Schedule: original E, T, T, E in four new processes; shuffled T, E in two new processes.",
        "- Each process constructs only its measured engine, performs three database-derived warmups, "
        "resets history, and measures one complete pass. No Faiss index is constructed.",
        "- Timers include query preparation, search, top-k, history maintenance, and conversion of returned "
        "indexes/scores to lists. Decode, inference, candidate preparation, warmup and oracle validation are excluded.",
        "- Every returned candidate ID and rank equals the frozen saved main oracle; every score has "
        "absolute error at most 2e-12, with relative tolerance zero. No competing scorer runs to grade a query.",
        f"- CPU affinity: {summary['environment']['measurement_affinity']}; numerical/Faiss threads: 1.",
        f"- CPU model: {summary['environment']['runtime']['cpu_model']}.",
        "",
        "## Complete timing results",
        "",
        "| Order | Engine | Passes | Mean ms | p50 ms | p95 ms | Max ms | Recall@64 | Min recall@64 | Full scans | Mean scored |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for order_name, group in summary["orders"].items():
        for method, stats in group.items():
            lines.append(f"| {order_name} | {method} | {len(stats['passes'])} | {stats['mean_ms']:.6f} | "
                         f"{stats['p50_ms']:.6f} | {stats['p95_ms']:.6f} | {stats['max_ms']:.6f} | "
                         f"{stats['mean_recall64']:.6f} | {stats['min_recall64']:.6f} | "
                         f"{stats['full_scans']} | {stats['mean_scored']:.2f} |")
    lines += [
        "",
        "Original-order results have two repetitions per engine; shuffled-order results have only one "
        "supplementary repetition per engine. These are observations on one already-composited clip. "
        "They support no confidence interval, significance claim, cross-video generalization, "
        "identity-recognition accuracy claim or proof of human perceptual similarity.",
        "",
        "## Ratios and every pass",
        "",
    ]
    for order_name, comparison in summary["comparisons"]["exact_vs_temporal"].items():
        lines.append(f"- {order_name}: exhaustive total / temporal total = "
                     f"{comparison['ratio_of_total_times_exhaustive_over_temporal']:.6f}; "
                     f"temporal measured-time reduction = {comparison['time_reduction_fraction'] * 100:.3f}%. "
                     f"Repetitions per engine = {comparison['repetitions_per_engine']}.")
    lines += [
        "",
        "| Pass | Order | Engine | Repeat | Total ms | Mean ms | Read s | Descriptors s | Warmup s | Peak RSS bytes |",
        "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in summary["passes"]:
        c = item["construction"]
        lines.append(f"| {item['pass']} | {item['order']} | {item['method']} | {item['repeat']} | "
                     f"{item['total_ms']:.6f} | {item['mean_ms']:.6f} | "
                     f"{c['input_read_seconds']:.6f} | {c['descriptor_seconds']:.6f} | "
                     f"{c['warmup_seconds']:.6f} | {item['peak_rss_bytes']} |")
    lines += [
        "",
        "## Main-run predecessor diagnostic",
        "",
        summary["primary_predecessor_diagnostic"]["qualification"],
        "",
        "The cyclic main experiment is not fully counterbalanced. Standalone speed claims should "
        "refer to the isolated results above. The following strata are displayed to make the timing "
        "concern reviewable; they are not adjustments applied to either experiment.",
        "",
        "| Order | Prior method within query | Temporal full scan | Count | E mean ms | T mean ms | E/T paired totals |",
        "|---|---|---|---:|---:|---:|---:|",
    ]
    for order_name, diagnosis in summary["primary_predecessor_diagnostic"]["orders"].items():
        for group in diagnosis["strata"]:
            lines.append(f"| {order_name} | {group['previous_method_in_same_query_group']} | "
                         f"{group['temporal_full_scan']} | {group['observations']} | "
                         f"{group['exhaustive_mean_ms']:.6f} | {group['temporal_mean_ms']:.6f} | "
                         f"{group['ratio_of_paired_total_times_exhaustive_over_temporal']:.6f} |")
    lines += [
        "",
        "## Evidence and limits",
        "",
        "The accompanying summary contains immutable source/input/oracle hashes, runtime versions, "
        "every pass, aggregate tails, candidate counts and full-scan counts. The public compressed CSV "
        "contains numeric query metrics only. Full ordered candidate IDs and strict-score arrays "
        "remain in private matches.npz files under the raw work directory and are not uploaded as public artifacts.",
        "",
        "The unchanged primary score is the correctness target. Its empirical agreement with the "
        "production port does not establish a new similarity metric or a new nearest-neighbor theorem. "
        "The pruning argument is exact in real arithmetic; this run checks the implementation's "
        "floating-point margin on every selected query and candidate result.",
        "",
        "This condition uses a fresh process per engine and no competing ANN indexes. Consequently, "
        "differences from the main experiment may include allocator, memory-footprint and cache effects. "
        "The E/T/T/E order limits a simple linear drift explanation but does not eliminate host contention, "
        "thermal drift or general hardware variability.",
        "",
    ]
    return "\n".join(lines)


def analyze(args):
    global CURRENT_PHASE, CURRENT_PASS, CURRENT_QUERY
    CURRENT_PHASE = "analysis-invariance"
    record = read_json(args.output / "control-execution.json")
    require(record.get("completed") is True and not record.get("failure"),
            "Control experiment is incomplete; partial results will not be summarized")
    require(record.get("parallel_benchmarks") is False, "Control processes were not sequential")
    lock_sha = record["lock_sha256"]
    lock = verify_lock(args.output / "lock.json", lock_sha)
    policy, protocol = policy_and_sources()
    primary_ready(Path(lock["experiment"]), policy, protocol)
    require(str(args.output) == lock["output"] and str(args.data) == lock["data"]
            and str(args.experiment) == lock["experiment"], "Analysis roots differ from immutable lock")
    require(record["measurement_affinity"] == lock["measurement_affinity"], "Control affinity changed")
    require(record["started_unix"] >= lock["primary_execution"]["finished_unix"],
            "Control started before primary completion")
    steps = record.get("steps", [])
    require(len(steps) == 6, "Exactly six control passes are required")
    require(len({step["pid"] for step in steps}) == 6, "Fresh worker PIDs are not distinct")
    previous_end = record["started_unix"]
    for step, item in zip(steps, policy["schedule"]):
        require(all(step[key] == value for key, value in item.items()), "Control pass schedule differs")
        require(step.get("exit_code") == 0 and step["started_unix"] >= previous_end
                and step["finished_unix"] >= step["started_unix"], "Control pass failed or overlapped")
        previous_end = step["finished_unix"]
    require(record["finished_unix"] >= previous_end, "Control finish time is invalid")
    import numpy as np
    expected_ids, expected_scores = load_oracle(lock, np)
    orders_document = read_json(Path(lock["data"]) / "orders.json")
    orders = orders_document["orders"]
    require(orders_document["seed"] == protocol["shuffle_seed"]
            and orders["original"] == list(range(1011))
            and orders["shuffled"] == np.random.Generator(
                np.random.PCG64(protocol["shuffle_seed"])).permutation(1011).tolist(),
            "Analysis query orders differ from frozen protocol")
    all_rows, passes, raw_manifest_hashes = [], [], {}
    maximum_error = 0.0
    CURRENT_PHASE = "analysis-all-pass-validation"
    for item, step in zip(policy["schedule"], steps):
        CURRENT_PASS = item["pass"]
        directory = args.output / f"pass-{item['pass']}"
        require(not (directory / "failure.json").exists(), "Control pass has failure evidence")
        manifest = read_json(directory / "manifest.json")
        require(manifest.get("completed") is True and manifest.get("lock_sha256") == lock_sha,
                "Control pass incomplete or lock differs")
        require(all(manifest.get(key) == value for key, value in item.items()), "Pass metadata differs")
        require(manifest.get("pid") == step["pid"] and manifest.get("runtime") == lock["runtime"],
                "Worker process/runtime evidence differs")
        require(manifest.get("started_unix") >= step["started_unix"]
                and manifest.get("finished_unix", float("inf")) <= step["finished_unix"],
                "Pass manifest time is outside its subprocess")
        require(manifest.get("source_sha256") == lock["source_sha256"]
                and manifest.get("input_sha256") == lock["input_sha256"]
                and manifest.get("oracle_sha256") == lock["oracle_sha256"], "Pass input/source lock differs")
        require(manifest.get("engines_constructed") == [item["method"]]
                and manifest.get("ann_indexes_constructed") == 0
                and manifest.get("measured_passes") == 1
                and manifest.get("query_count") == 1011 and manifest.get("candidate_count") == 70000
                and manifest.get("k") == 64, "Pass does not represent one isolated full workload")
        require(set(manifest["files_sha256"]) == {"observations.jsonl", "matches.npz", "construction.json"},
                "Pass output evidence set differs")
        for name, expected in manifest["files_sha256"].items():
            require(digest(directory / name) == expected, "Pass evidence changed: " + name)
        rows = read_rows(directory / "observations.jsonl")
        order = orders[item["order"]]
        require(len(rows) == 1011, "Pass has missing or extra query observations")
        pass_error = 0.0
        with np.load(directory / "matches.npz", allow_pickle=False) as raw:
            require(set(raw.files) == {"query_indices", "indices", "scores"}, "Unexpected raw match schema")
            require(raw["query_indices"].tolist() == order, "Raw query order differs")
            raw_indices, raw_scores = raw["indices"], raw["scores"]
            require(raw_indices.shape == (1011, 64) and raw_scores.shape == (1011, 64),
                    "Incomplete raw top-64 evidence")
            for position, (query_index, row) in enumerate(zip(order, rows)):
                CURRENT_QUERY = query_index
                require(all(row.get(key) == value for key, value in item.items())
                        and row.get("position") == position and row.get("query_index") == query_index,
                        "Observation metadata or query enumeration differs")
                require(not any(isinstance(value, (dict, list)) for value in row.values()),
                        "Observation contains arrays or nested data")
                error, gap = validate_result(raw_indices[position], raw_scores[position],
                                             expected_ids[query_index], expected_scores[query_index], np)
                require(row.get("max_absolute_score_error") == error and row.get("score_excess") == gap,
                        "Reported score error differs from raw results")
                require(all(row.get(f"recall{k}") == 1 for k in (1, 10, 64)), "Reported exact recall differs")
                validate_temporal_stats(row, position, item["method"])
                pass_error = max(pass_error, error)
        require(manifest.get("validation") == {
            "ordered_top64_equal": True, "all_queries": 1011,
            "absolute_score_tolerance": 2e-12, "relative_score_tolerance": 0,
            "max_absolute_score_error": pass_error,
        }, "Manifest validation differs from rechecked raw evidence")
        construction = read_json(directory / "construction.json")
        require(construction["warmup_catalog_indices"] == [0, 35000, 69999]
                and construction["warmup_count"] == 3 and construction["reset_after_warmup"] is True
                and construction["ann_indexes_constructed"] == 0, "Warmup/isolation evidence differs")
        for name in ("input_read_seconds", "descriptor_seconds", "engine_construct_seconds", "warmup_seconds"):
            require(math.isfinite(construction[name]) and construction[name] >= 0,
                    "Invalid preparation duration")
        pass_summary = {
            **item, **summarize_rows(rows), "construction": construction,
            "peak_rss_bytes": manifest["peak_rss_bytes"],
            "max_absolute_score_error": pass_error, "pid": manifest["pid"],
        }
        maximum_error = max(maximum_error, pass_error)
        passes.append(pass_summary)
        all_rows.extend(rows)
        raw_manifest_hashes[f"pass-{item['pass']}/manifest.json"] = digest(directory / "manifest.json")
    grouped = {}
    comparisons = {}
    for order_name in ("original", "shuffled"):
        grouped[order_name] = {}
        count = policy["repeats_by_order"][order_name]
        for method in METHODS:
            rows = [row for row in all_rows if row["order"] == order_name and row["method"] == method]
            selected_passes = [p for p in passes if p["order"] == order_name and p["method"] == method]
            require(sorted(p["repeat"] for p in selected_passes) == list(range(count)),
                    "Missing or selected repetitions")
            require(len(rows) == count * 1011, "Aggregate observation count differs")
            grouped[order_name][method] = {
                **summarize_rows(rows), "passes": selected_passes,
                "pass_totals_ms": [p["total_ms"] for p in selected_passes],
                "mean_pass_total_ms": statistics.fmean(p["total_ms"] for p in selected_passes),
            }
        exact, temporal = (grouped[order_name][method] for method in METHODS)
        per_repeat = []
        for repeat in range(count):
            e = next(p for p in exact["passes"] if p["repeat"] == repeat)
            t = next(p for p in temporal["passes"] if p["repeat"] == repeat)
            per_repeat.append({"repeat": repeat,
                               "ratio_of_total_times_exhaustive_over_temporal": e["total_ms"] / t["total_ms"]})
        comparisons[order_name] = {
            "ratio_of_total_times_exhaustive_over_temporal": exact["total_ms"] / temporal["total_ms"],
            "time_reduction_fraction": 1 - temporal["total_ms"] / exact["total_ms"],
            "repetitions_per_engine": count, "per_repeat": per_repeat,
            "qualification": "Descriptive ratio for this isolated process condition and this one clip; no confidence interval.",
        }
    CURRENT_PHASE = "analysis-primary-diagnostic"
    diagnosis = primary_predecessor_diagnostic(lock, orders)
    summary = {
        "schema_version": 2, "status": "complete_validated",
        "implementation": policy["implementation"], "design": policy["reason"],
        "methods": list(METHODS), "schedule": policy["schedule"],
        "input": {"candidates": 70000, "queries": 1011, "k": 64,
                  "input_sha256": lock["input_sha256"]},
        "environment": {"measurement_affinity": lock["measurement_affinity"],
                        "runtime": lock["runtime"], "threads": 1,
                        "primary_experiment_commit": lock["primary_execution"]["experiment_commit"]},
        "source": {"base_commit": policy["base_commit"],
                   "production_source_commit": policy["production_source_commit"],
                   "sha256": lock["source_sha256"], "primary_protocol_sha256": policy["primary_protocol_sha256"]},
        "validation": {"complete_passes": 6, "observations": len(all_rows),
                       "ordered_top64_equal": True, "absolute_score_tolerance": 2e-12,
                       "relative_score_tolerance": 0, "max_absolute_score_error": maximum_error,
                       "all_scheduled_passes_retained": True, "first_query_history_empty": True,
                       "oracle_sha256": lock["oracle_sha256"], "lock_sha256": lock_sha,
                       "raw_manifest_sha256": raw_manifest_hashes,
                       "primary_evidence_sha256": lock["primary_evidence_sha256"]},
        "orders": grouped, "passes": passes, "comparisons": {"exact_vs_temporal": comparisons},
        "primary_predecessor_diagnostic": diagnosis,
        "limitations": [
            policy["interpretation"],
            "Isolated processes have no competing ANN allocations; differences from interleaved timing are not attributable solely to cache predecessor.",
            "Frame recall is agreement with the frozen production score, not identity or perceptual ground truth.",
            "No old interrupted-host observations are pooled with this successful new-hardware run.",
        ],
    }
    CURRENT_PHASE = "publication"
    if args.publish:
        require(not args.publish.exists(), "Refuse to overwrite a public result directory")
        args.publish.mkdir(parents=True)
        write_json(args.publish / "summary.json", summary)
        with gzip.open(args.publish / "per-query-metrics.csv.gz", "wt", newline="") as stream:
            fields = ["order", "repeat", "method", "qindex", "ms", "recall1", "recall10",
                      "recall64", "gap", "scored", "fullscan"]
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            for row in all_rows:
                writer.writerow({
                    "order": row["order"], "repeat": row["repeat"], "method": row["method"],
                    "qindex": row["query_index"], "ms": row["elapsed_ms"],
                    "recall1": row["recall1"], "recall10": row["recall10"], "recall64": row["recall64"],
                    "gap": row["score_excess"], "scored": row["scored"], "fullscan": row["full_scan"],
                })
        (args.publish / "RUN_REPORT.md").write_text(report_markdown(summary))
    print("CONTROL_SUMMARY_BEGIN", flush=True)
    print(json.dumps(summary, separators=(",", ":"), allow_nan=False), flush=True)
    print("CONTROL_SUMMARY_END", flush=True)
    log("control-analysis-complete", passes=6, observations=len(all_rows),
        public_output=str(args.publish) if args.publish else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=REPO / "work/face-search")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publish", type=Path)
    parser.add_argument("--python-dependencies", type=Path)
    parser.add_argument("--analyze-only", action="store_true")
    parser.add_argument("--check-ready", action="store_true")
    parser.add_argument("--worker", type=int)
    parser.add_argument("--lock-sha")
    args = parser.parse_args()
    for name in ("experiment", "data", "output", "publish", "python_dependencies"):
        value = getattr(args, name)
        if value is not None:
            setattr(args, name, value.resolve())
    if args.python_dependencies:
        sys.path.insert(0, str(args.python_dependencies))
    require(sum((args.analyze_only, args.check_ready, args.worker is not None)) <= 1,
            "Select only one execution mode")
    if args.worker is not None:
        worker(args)
    elif args.analyze_only:
        analyze(args)
    else:
        control_run(args)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        if isinstance(error, SystemExit) and error.code in (0, None):
            raise
        log("control-failed", status="not_complete", phase=CURRENT_PHASE,
            pass_number=CURRENT_PASS, query_index=CURRENT_QUERY,
            type=type(error).__name__, message=str(error))
        traceback.print_exc()
        raise SystemExit(1)
