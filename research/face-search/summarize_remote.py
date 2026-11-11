#!/usr/bin/env python3
"""New, fail-closed analysis of the independent Actions run.

This is a new analyzer, not a claimed recovery of an earlier local analyzer.
It never runs a search engine or edits timing files. All retrieval metrics are
recomputed from retained result IDs against the saved global strict oracle.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROTOCOL_SHA256 = "c7294b075da00cd5b1f3a6baecb5e81ca7bf64f58d4008deb66004c41d9bc4ca"
CODE_SHA256 = {
    "benchmark.py": "cd1dbdc0097c4ca17aa83002979c33c2e75236667c4f1261ca5535f450d75383",
    "engines.py": "edb09911191fe3c727d24b6c07674d56b90bbc079269260df00833960cb46557",
    "strict_metric.py": "8d15329ea4848511b051bf3709647b097408e33c13bda20b55e50e35ad47346b",
    "temporal_exact.py": "ab60ba2e797ce4fa23b36c587794c96c3fadfdbf419d130903ae59eb6a370b2e",
}
BLOB_SHA1 = {
    "research/face-search/benchmark-current.mjs": "aa3105f1c767c67ff752a13b519b4589e709c7f2",
    "app/live/review-strict-ranker.ts": "e535adf8767660f7f80c6b5f0784254a35dbcf27",
    "app/live/review-local-catalog.ts": "34a3df22ddcda03f5bcdceb17d318c1de28db142",
    "app/live/review-work-cache.ts": "6db83380f18e8b1d4f364d1c849db554137b8c32",
    "app/live/astra/top-k.ts": "1c296f866e5f3f5b0e30a8fde52a5e929f25a946",
    "app/projection-matching.ts": "a9a4bbaded1747b0625a2c5deee99c22ddb7cb4f",
    "app/face-actions.ts": "d6267b4faa6553b6057dc2ad7fbb8902d9c788c7",
    "app/live/review-search.worker.ts": "bf3b59c73dbd82976c798104e68ebaeb11cc157f",
    "research/face-search/run-experiment.py": "b981909fd273a509ca21097a3016da8db4e4b843"
}
PYTHON_METHODS = [
    "exhaustive_strict", "temporal_exact",
    "faiss_flat_128", "faiss_hnsw_128",
    "faiss_flat_512", "faiss_hnsw_512",
    "faiss_flat_2048", "faiss_hnsw_2048",
    "faiss_flat_8192", "faiss_hnsw_8192",
]
CURRENT_METHOD = "current_node_core"
METHODS = PYTHON_METHODS + [CURRENT_METHOD]
ORDERS = ("original", "shuffled")
N = 1011
CATALOG = 70000
K = 64
TOLERANCE = 2e-12
DATA_FILES = [
    "candidate-ids.json", "candidate-shards.json", "candidates.features.f64",
    "candidates.projections.f64", "queries.features.f64", "queries.projections.f64",
    "queries.json", "queries.manifest.json", "catalog.manifest.json", "orders.json",
    "strict-metric-verification.json",
]
CSV_FIELDS = [
    "repeat", "order", "method", "position", "query_index", "source_frame",
    "elapsed_ms", "recall1", "recall10", "recall64", "score_excess",
    "returned_count", "scored", "full_scan", "pose_candidates",
]

def require(condition, message):
    if not condition:
        raise ValueError(message)

def read_json(path):
    def reject(value):
        raise ValueError("Nonfinite JSON constant: " + value)
    return json.loads(Path(path).read_text(), parse_constant=reject)

def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def blob_digest(path):
    content = Path(path).read_bytes()
    return hashlib.sha1(("blob " + str(len(content)) + "\0").encode() + content).hexdigest()

def finite(value, label):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value), label + " must be finite numeric")
    return float(value)

def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()

def near(actual, expected, label, atol=1e-10, rtol=1e-12):
    require(math.isclose(float(actual), float(expected), abs_tol=atol, rel_tol=rtol), label + " differs from recomputed evidence")

def source_gate():
    require(digest(HERE / "protocol.json") == PROTOCOL_SHA256, "The fixed primary protocol changed")
    for name, expected in CODE_SHA256.items():
        require(digest(HERE / name) == expected, "Frozen Python timing source changed: " + name)
    for name, expected in BLOB_SHA1.items():
        require(blob_digest(REPO / name) == expected, "Frozen production/launcher source changed: " + name)
    return {**CODE_SHA256, "protocol.json": PROTOCOL_SHA256, "summarize_remote.py": digest(Path(__file__))}

def answer_metrics(chosen, scores, expected_ids, expected_scores, allow_short=False):
    chosen = np.asarray(chosen)
    scores = np.asarray(scores, dtype=np.float64)
    require(chosen.ndim == scores.ndim == 1 and chosen.shape == scores.shape, "Malformed retained result")
    require(len(chosen) <= K and (allow_short or len(chosen) == K), "Wrong result count")
    require(np.issubdtype(chosen.dtype, np.integer) or len(chosen) == 0, "Noninteger candidate index")
    require(len(set(chosen.tolist())) == len(chosen), "Duplicate candidate ID")
    require(bool(np.all(chosen >= 0) and np.all(chosen < CATALOG)), "Out-of-range candidate index")
    require(bool(np.isfinite(scores).all() and np.all(np.diff(scores) >= 0)), "Nonfinite or unsorted retained scores")
    recalls = {f"recall{k}": len(set(chosen[:k].tolist()) & set(expected_ids[:k].tolist())) / k for k in (1, 10, 64)}
    if len(scores):
        require(bool(np.all(scores >= expected_scores[:len(scores)] - TOLERANCE)), "A returned rank score is better than its claimed global order statistic")
        known = {int(index): float(score) for index, score in zip(expected_ids, expected_scores)}
        for index, score in zip(chosen, scores):
            if int(index) in known:
                require(abs(float(score) - known[int(index)]) <= TOLERANCE, "Same candidate has a score inconsistent with the oracle")
        excess = max(0., float(scores[0] - expected_scores[0]))
    else:
        excess = None
    return {**recalls, "score_excess": excess, "returned_count": len(chosen)}

def summarize(rows):
    elapsed = np.asarray([row["elapsed_ms"] for row in rows], dtype=np.float64)
    require(len(elapsed) > 0 and np.isfinite(elapsed).all() and np.all(elapsed >= 0), "Invalid elapsed times")
    excess = [row["score_excess"] for row in rows if row["score_excess"] is not None]
    scored = [row["scored"] for row in rows if row["scored"] is not None]
    full = [row["full_scan"] for row in rows if row["full_scan"] is not None]
    poses = [row["pose_candidates"] for row in rows if row["pose_candidates"] is not None]
    return {
        "observations": len(rows), "total_ms": float(elapsed.sum()),
        "mean_ms": float(elapsed.mean()), "median_ms": float(np.median(elapsed)),
        "p95_ms": float(np.percentile(elapsed, 95)), "maximum_ms": float(elapsed.max()),
        **{name: float(np.mean([row[name] for row in rows])) for name in ("recall1", "recall10", "recall64")},
        "worst_recall64": float(min(row["recall64"] for row in rows)),
        "mean_score_excess": float(np.mean(excess)) if excess else None,
        "maximum_score_excess": float(max(excess)) if excess else None,
        "empty_results": sum(row["returned_count"] == 0 for row in rows),
        "mean_scored": float(np.mean(scored)) if len(scored) == len(rows) else None,
        "full_scans": sum(bool(value) for value in full) if len(full) == len(rows) else None,
        "mean_pose_candidates": float(np.mean(poses)) if len(poses) == len(rows) else None,
    }

def check_matrix(ids, scores, shape, label):
    require(ids.shape == scores.shape == shape, label + " shape mismatch")
    require(np.issubdtype(ids.dtype, np.integer), label + " IDs must be integer")
    require(bool(np.all(ids >= 0) and np.all(ids < CATALOG)), label + " invalid IDs")
    require(bool(np.all(np.diff(np.sort(ids, axis=-1), axis=-1) != 0)), label + " duplicate IDs")
    require(bool(np.isfinite(scores).all() and np.all(np.diff(scores, axis=-1) >= 0)), label + " invalid scores")

def same_answers(ids, scores, other_ids, other_scores, label):
    require(np.array_equal(ids, other_ids), label + " changed returned candidate order")
    require(bool(np.all(np.abs(scores - other_scores) <= TOLERANCE)), label + " changed retained scores")

def analyze(args):
    sources = source_gate()
    protocol = read_json(HERE / "protocol.json")
    require(protocol["catalog_records"] == CATALOG and protocol["input_lock"]["valid_queries"] == N and protocol["k"] == K, "Unexpected fixed task dimensions")
    require(protocol["repetitions"] == 3 and protocol["threads"] == 1 and protocol["orders"] == list(ORDERS), "Unexpected fixed experiment design")
    execution_path = args.experiment / "execution.json"
    require(execution_path.is_file(), "Main execution.json is absent: input preparation or main measurement did not finish")
    execution = read_json(execution_path)
    require(execution.get("completed") is True and "failure" not in execution, "Main experiment is incomplete or failed; no numerical summary is valid")
    require(execution.get("parallel_benchmarks") is False and execution.get("repetitions") == 3, "Main experiment was not the fixed sequential three-repeat run")
    require(execution["production_source_commit"] == protocol["source_commit"], "Production source pin differs")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    require(execution["experiment_commit"] == head, "The retained main run belongs to another checkout; do not pool old hardware runs")
    affinity = execution["measurement_affinity"]
    require(isinstance(affinity, list) and len(affinity) == 1 and affinity[0] in execution["available_affinity"], "Require one fixed logical CPU")
    expected_schedule = [("python", 0), ("current", 0), ("current", 1), ("python", 1), ("python", 2), ("current", 2)]
    steps = execution["steps"]
    require([(step["kind"], step["repeat"]) for step in steps] == expected_schedule, "Main schedule is missing, duplicated, or reordered")
    previous_end = finite(execution["started_unix"], "execution start")
    by_step = {}
    for step in steps:
        require(step.get("exit_code") == 0, "A main measurement step failed")
        start, end = finite(step["started_unix"], "step start"), finite(step["finished_unix"], "step end")
        require(start >= previous_end - 1e-6 and end >= start, "Main steps overlap or have invalid timestamps")
        previous_end = end
        by_step[(step["kind"], step["repeat"])] = step
    require(finite(execution["finished_unix"], "execution finish") >= previous_end, "Execution completion precedes its last step")

    input_hashes = {name: digest(args.data / name) for name in DATA_FILES}
    for name, expected in protocol["input_lock"].items():
        if name.endswith((".f64", ".json")):
            require(input_hashes.get(name) == expected, "Input differs from the frozen query/database lock: " + name)
    ids = read_json(args.data / "candidate-ids.json")
    metadata = read_json(args.data / "queries.json")
    require(len(ids) == CATALOG and ids == sorted(set(ids)), "Incomplete or noncanonical candidate IDs")
    require(len(metadata) == N and all(row["compensateRoll"] is True for row in metadata), "Invalid query metadata")
    catalog = read_json(args.data / "catalog.manifest.json")
    query_manifest = read_json(args.data / "queries.manifest.json")
    require(catalog["sourceCommit"] == query_manifest["sourceCommit"] == protocol["source_commit"], "Preparation source differs")
    require(catalog["records"] == catalog["uniqueIds"] == CATALOG and catalog["shards"] == 775, "Incomplete catalog preparation")
    require(query_manifest["plannedFrames"] == query_manifest["decodedFrames"] == protocol["input_lock"]["planned_frames"], "Incomplete video decoding")
    require(query_manifest["queryCount"] == N, "Invalid valid-query count")
    evidence = query_manifest["evidence"]
    require([row["sourceFrameIndex"] for row in evidence] == list(range(protocol["input_lock"]["planned_frames"])), "Frame accounting is incomplete")
    require([row["sourceFrameIndex"] for row in metadata] == [row["sourceFrameIndex"] for row in evidence if row["valid"]], "Some valid frames were filtered")
    for manifest in (catalog, query_manifest):
        for name, facts in manifest["files"].items():
            require(Path(name).name == name and digest(args.data / name) == facts["sha256"], "Preparation output differs: " + name)
    for stem, count, columns in (("candidates.features", CATALOG, 55), ("candidates.projections", CATALOG, 936), ("queries.features", N, 55), ("queries.projections", N, 936)):
        require((args.data / (stem + ".f64")).stat().st_size == count * columns * 8, "Input matrix shape mismatch: " + stem)
    orders_document = read_json(args.data / "orders.json")
    expected_orders = {
        "original": list(range(N)),
        "shuffled": np.random.Generator(np.random.PCG64(protocol["shuffle_seed"])).permutation(N).tolist(),
    }
    require(orders_document == {"seed": protocol["shuffle_seed"], "orders": expected_orders}, "Query order differs from fixed PCG64 schedule")
    parity = read_json(args.data / "strict-metric-verification.json")
    require(parity["status"] == "pass" and parity["pythonPortSha256"] == sources["strict_metric.py"] and parity["rankMismatches"] == 0, "Metric-port verification is stale or failed")
    for name, expected in parity["sourceHashes"].items():
        resolved = (HERE / name).resolve()
        require(resolved.is_relative_to(REPO) and digest(resolved) == expected, "Production source changed after metric verification")
    observed_files = {str(execution_path.relative_to(args.experiment)): digest(execution_path)}
    observed_files.update({str((args.data / name).resolve()): value for name, value in input_hashes.items()})
    rows, per_pass, preparation = [], [], []
    oracle_ids = oracle_scores = None
    canonical_answers = {}
    environment = None
    node_environment = None

    def remember(path):
        observed_files[str(path.resolve())] = digest(path)

    for repeat in range(3):
        base = args.experiment / f"python-{repeat}"
        require(not (base / "failure.json").exists(), "A failed Python run cannot be summarized as complete")
        manifest_path = base / "manifest.json"
        manifest = read_json(manifest_path)
        require(manifest.get("completed") is True and manifest.get("smoke_queries") == 0 and manifest.get("temporal_exact_matches") is True, "A Python repeat is incomplete, smoke-only, or failed exactness")
        require(manifest["repeat"] == repeat and manifest["candidate_count"] == CATALOG and manifest["query_count"] == N, "Python repeat dimensions differ")
        require(manifest["protocol_sha256"] == PROTOCOL_SHA256 and manifest["protocol"] == protocol and manifest["code_sha256"] == CODE_SHA256, "Python source/protocol mismatch")
        require(manifest["input_sha256"] == input_hashes, "Python inputs differ from this Actions run")
        require(manifest["all_protocol_orders"] is True and set(manifest["selected_orders"]) == set(ORDERS), "A Python order is missing")
        require(manifest["faiss_threads"] == 1 and manifest["cpu_affinity"] == affinity and manifest["faiss"] == protocol["faiss_version"], "Python execution resources differ")
        step = by_step[("python", repeat)]
        require(step["started_unix"] <= manifest["started_unix"] <= manifest["finished_unix"] <= step["finished_unix"], "Python files were not produced by their recorded step")
        env = {key: manifest[key] for key in ("platform", "python", "numpy", "faiss", "faiss_compile", "cpu_model", "cpu_count", "cpu_affinity", "faiss_threads")}
        if environment is None:
            environment = env
        else:
            require(env == environment, "Hardware/runtime changed between Python repetitions")
        construction = read_json(base / "construction.json")
        require(all(finite(construction[key], key) >= 0 for key in ("input_read_seconds", "descriptor_seconds", "embedding_seconds", "flat_build_seconds", "hnsw_build_seconds")), "Invalid preparation times")
        preparation.append({"repeat": repeat, "python": construction, "peak_rss_bytes": manifest["peak_rss_bytes"]})
        oracle_path = base / "oracle.json"
        oracle = read_json(oracle_path)
        require(oracle["query_indices"] == list(range(N)), "Oracle omits or reorders queries")
        oid = np.asarray(oracle["indices"])
        osc = np.asarray(oracle["scores"], dtype=np.float64)
        check_matrix(oid, osc, (N, K), "Saved global oracle")
        if oracle_ids is None:
            oracle_ids, oracle_scores = oid, osc
        else:
            same_answers(oid, osc, oracle_ids, oracle_scores, "Oracle across repetitions")
        for path in (manifest_path, oracle_path, base / "construction.json", base / "summary.json"):
            remember(path)
        recorded_summary = read_json(base / "summary.json")
        require(set(recorded_summary) == set(ORDERS), "Recorded Python summary is incomplete")
        for order_name in ORDERS:
            order = expected_orders[order_name]
            matched_path = base / f"matches-{order_name}.npz"
            with np.load(matched_path, allow_pickle=False) as retained:
                require(set(retained.files) == {"methods", "query_indices", "indices", "scores"}, "Unexpected retained match archive")
                require(retained["methods"].tolist() == PYTHON_METHODS, "Missing or reordered Python method")
                require(retained["query_indices"].tolist() == order, "Retained query order differs")
                raw_ids, raw_scores = retained["indices"], retained["scores"]
                check_matrix(raw_ids, raw_scores, (N, len(PYTHON_METHODS), K), "Python retained matches")
                inverse = np.empty(N, dtype=np.int64)
                inverse[np.asarray(order)] = np.arange(N)
                for method_index, name in enumerate(PYTHON_METHODS):
                    canonical_ids = raw_ids[inverse, method_index]
                    canonical_scores = raw_scores[inverse, method_index]
                    if name in canonical_answers:
                        same_answers(canonical_ids, canonical_scores, *canonical_answers[name], name + " across all repeats/orders")
                    else:
                        canonical_answers[name] = (canonical_ids.copy(), canonical_scores.copy())
                    if name in ("exhaustive_strict", "temporal_exact"):
                        same_answers(canonical_ids, canonical_scores, oracle_ids, oracle_scores, name + " versus global oracle")
                timing_path = base / f"{order_name}.jsonl"
                timed_rows = [json.loads(line) for line in timing_path.read_text().splitlines() if line.strip()]
                require(len(timed_rows) == N * len(PYTHON_METHODS), "Timing rows are missing or extra")
                seen = set()
                by_method = {name: [] for name in PYTHON_METHODS}
                for entry in timed_rows:
                    name = entry["method"]
                    require(name in PYTHON_METHODS and entry["order"] == order_name, "Unknown method or order in timings")
                    position, qi = entry["position"], entry["query_index"]
                    require(isinstance(position, int) and 0 <= position < N and order[position] == qi, "Timing query/order mismatch")
                    require((position, name) not in seen, "Duplicate timing result")
                    seen.add((position, name))
                    require(entry["source_frame"] == metadata[qi]["sourceFrameIndex"], "Timing source-frame mismatch")
                    method_index = PYTHON_METHODS.index(name)
                    chosen, scores = raw_ids[position, method_index], raw_scores[position, method_index]
                    metrics = answer_metrics(chosen, scores, oracle_ids[qi], oracle_scores[qi])
                    for key in ("recall1", "recall10", "recall64", "score_excess"):
                        near(entry[key], metrics[key], "Recorded " + key, atol=TOLERANCE, rtol=0)
                    scored = entry["scored"]
                    require(isinstance(scored, int) and K <= scored <= CATALOG + K, "Invalid scoring-work count")
                    require(isinstance(entry["full_scan"], bool), "Invalid full-scan flag")
                    if name == "exhaustive_strict":
                        require(scored == CATALOG and entry["full_scan"], "Exhaustive work count is not global")
                    elif name == "temporal_exact":
                        require(entry["queries_seen"] == position + 1, "Temporal history did not reset")
                        if position == 0:
                            require(entry["full_scan"] and entry["reason"] == "initial", "First temporal query is not a fresh full scan")
                    else:
                        require(not entry["full_scan"] and scored <= int(name.rsplit("_", 1)[1]), "ANN/Flat work count differs from fixed budget")
                    row = {"repeat": repeat, "order": order_name, "method": name, "position": position,
                           "query_index": qi, "source_frame": metadata[qi]["sourceFrameIndex"],
                           "elapsed_ms": finite(entry["elapsed_ms"], "elapsed_ms"), **metrics,
                           "scored": scored, "full_scan": entry["full_scan"], "pose_candidates": None}
                    require(row["elapsed_ms"] >= 0, "Negative elapsed time")
                    rows.append(row)
                    by_method[name].append(row)
                require(len(seen) == N * len(PYTHON_METHODS), "Incomplete method/query coverage")
                require(set(recorded_summary[order_name]) == set(PYTHON_METHODS), "Summary method is missing")
                for name, observations in by_method.items():
                    measured = summarize(observations)
                    old = recorded_summary[order_name][name]
                    require(old["queries"] == N, "Incorrect recorded query count")
                    for old_key, new_key in (("total_ms", "total_ms"), ("mean_ms", "mean_ms"), ("median_ms", "median_ms"),
                                             ("p95_ms", "p95_ms"), ("recall1", "recall1"), ("recall10", "recall10"),
                                             ("recall64", "recall64"), ("min_recall64", "worst_recall64"), ("scored", "mean_scored")):
                        near(old[old_key], measured[new_key], "Python summary " + old_key)
                    require(old["full_scans"] == measured["full_scans"], "Full-scan aggregate mismatch")
                    per_pass.append({"repeat": repeat, "order": order_name, "method": name, **measured})
            remember(matched_path)
            remember(timing_path)

        current_path = args.experiment / f"current-{repeat}.json"
        current = read_json(current_path)
        require(current["schemaVersion"] == 1 and current["method"] == "production_video_core_pose_window_strict_ranker" and current["smoke"] is False, "Invalid or smoke-only Node baseline")
        config = current["configuration"]
        require(config["topK"] == K and config["repetitions"] == 1 and config["resultCache"] is False and config["inputFrameSkipping"] is False, "Node baseline configuration differs")
        require(config["windowCache"]["resetAtEveryPass"] is True, "Node window history was not reset")
        require({value["name"]: value["indices"] for value in config["queryOrders"]} == expected_orders, "Node query order differs")
        require(len(config["queryOrders"]) == 2, "Duplicate Node query-order name")
        require(current["preparation"]["candidateCount"] == CATALOG and current["preparation"]["queryCount"] == N, "Node input dimensions differ")
        require(current["validation"]["answerInvariantAcrossOrdersAndRepetitions"] is True and current["validation"]["distinctQueriesChecked"] == N, "Node internal answer invariance did not pass")
        step = by_step[("current", repeat)]
        require(step["started_unix"] <= timestamp(current["startedAt"]) <= timestamp(current["completedAt"]) <= step["finished_unix"], "Node file was not produced by its recorded step")
        expected_node_sources = {name: digest(REPO / name) for name in BLOB_SHA1 if name != "research/face-search/run-experiment.py"}
        require(current["provenance"]["sourceHashes"] == expected_node_sources, "Node production source hash differs")
        node_inputs = current["provenance"]["inputFiles"]
        expected_node_inputs = {
            "source-catalog-manifest.json", "catalog.manifest.json", "candidate-ids.json",
            "candidate-shards.json", "candidates.features.f64", "candidates.projections.f64",
            "queries.json", "queries.features.f64", "queries.projections.f64", "orders.json",
        }
        require(set(node_inputs) == expected_node_inputs, "Unexpected Node input file set")
        for name, facts in node_inputs.items():
            file = args.experiment / "orders-reversed.json" if name == "orders.json" and repeat % 2 else args.data / name
            require(digest(file) == facts["sha256"] and file.stat().st_size == facts["bytes"], "Node input hash mismatch: " + name)
        require(current["provenance"]["catalog"] == catalog, "Node catalog provenance differs")
        env = {key: current["environment"][key] for key in ("node", "v8", "platform", "architecture", "cpu", "logicalCpus", "totalMemoryBytes")}
        if node_environment is None:
            node_environment = env
        else:
            require(node_environment == env, "Node hardware/runtime changed between repeats")
        preparation[repeat]["node"] = current["preparation"]
        preparation[repeat]["node_memory_at_finish"] = current["memoryAtFinish"]
        observations = current["observations"]
        require(len(observations) == N * 2 and len(current["passes"]) == 2, "Node observations or passes incomplete")
        seen = set()
        by_order = {name: [] for name in ORDERS}
        for entry in observations:
            order_name, position, qi = entry["order"], entry["position"], entry["queryIndex"]
            require(order_name in ORDERS and entry["repetition"] == 0, "Unexpected inner Node repetition")
            require(isinstance(position, int) and 0 <= position < N and expected_orders[order_name][position] == qi, "Node query/order mismatch")
            require((order_name, position) not in seen, "Duplicate Node query")
            seen.add((order_name, position))
            require(entry["sourceFrameIndex"] == metadata[qi]["sourceFrameIndex"], "Node source frame differs")
            near(entry["time"], metadata[qi]["time"], "Node source time", atol=1e-12, rtol=0)
            chosen, scores = np.asarray(entry["indices"]), np.asarray(entry["strictScores"], dtype=np.float64)
            require(entry["returnedCount"] == len(chosen) == min(K, entry["poseCandidateCount"]), "Node returned count differs from its candidate pool")
            metrics = answer_metrics(chosen, scores, oracle_ids[qi], oracle_scores[qi], allow_short=True)
            key = (CURRENT_METHOD, qi)
            if key in canonical_answers:
                same_answers(chosen, scores, *canonical_answers[key], "Node across all repeats/orders")
            else:
                canonical_answers[key] = (chosen.copy(), scores.copy())
            elapsed = finite(entry["elapsedMs"], "Node elapsed_ms")
            near(elapsed, entry["poseWindowMs"] + entry["rankMs"] + entry["resultAssemblyMs"], "Node timing decomposition", atol=1e-7, rtol=1e-10)
            row = {"repeat": repeat, "order": order_name, "method": CURRENT_METHOD, "position": position,
                   "query_index": qi, "source_frame": metadata[qi]["sourceFrameIndex"], "elapsed_ms": elapsed, **metrics,
                   "scored": None, "full_scan": None, "pose_candidates": entry["poseCandidateCount"]}
            require(elapsed >= 0, "Negative Node elapsed time")
            rows.append(row)
            by_order[order_name].append(row)
        for order_name, observations in by_order.items():
            require(len(observations) == N, "A Node order is incomplete")
            matches = [value for value in current["passes"] if value["order"] == order_name and value["repetition"] == 0]
            require(len(matches) == 1, "Node pass is missing or duplicated")
            old = matches[0]
            measured = summarize(observations)
            require(old["queries"] == N and old["rankStats"]["queries"] == N, "Node ranker did not evaluate every query exactly once")
            near(old["totalMs"], measured["total_ms"], "Node total time")
            near(old["meanMs"], measured["mean_ms"], "Node mean time")
            near(old["p95Ms"], measured["p95_ms"], "Node p95")
            per_pass.append({"repeat": repeat, "order": order_name, "method": CURRENT_METHOD, **measured,
                             "mean_detailed_candidates": old["rankStats"]["detailedCandidates"] / N,
                             "work_note": "Per-query exact work is not recorded by the Node harness; pose pool and pass-level detailed-candidate counts are kept separate."})
        remember(current_path)

    require(len(rows) == N * 3 * 2 * len(METHODS) and len(per_pass) == 3 * 2 * len(METHODS), "Incomplete final method/repeat/order grid")
    aggregates = {}
    for order_name in ORDERS:
        aggregates[order_name] = []
        for name in METHODS:
            selected = [row for row in rows if row["order"] == order_name and row["method"] == name]
            passes = [value for value in per_pass if value["order"] == order_name and value["method"] == name]
            require(len(selected) == N * 3 and sorted(value["repeat"] for value in passes) == [0, 1, 2], "Final grid has a missing repeat")
            measured = summarize(selected)
            aggregates[order_name].append({
                "method": name, **measured, "mean_ms_by_repeat": [value["mean_ms"] for value in sorted(passes, key=lambda x: x["repeat"])],
                "mean_total_ms_per_pass": measured["total_ms"] / 3,
                "full_scans_by_repeat": [value["full_scans"] for value in sorted(passes, key=lambda x: x["repeat"])],
                "mean_detailed_candidates": float(np.mean([value["mean_detailed_candidates"] for value in passes])) if name == CURRENT_METHOD else None,
            })
    require(source_gate() == sources, "Source changed during analysis")
    require({name: digest(args.data / name) for name in DATA_FILES} == input_hashes, "Input changed during analysis")
    for name, expected in observed_files.items():
        file = args.experiment / name if not Path(name).is_absolute() else Path(name)
        require(digest(file) == expected, "Retained evidence changed during analysis: " + name)
    return {
        "schema_version": 1, "status": "complete_validated", "analyzer": "new summarize_remote.py",
        "analysis_unix": time.time(), "experiment_commit": head, "production_source_commit": protocol["source_commit"],
        "main_execution_sha256": digest(execution_path), "source_sha256": sources, "frozen_git_blob_sha1": BLOB_SHA1,
        "input_sha256": input_hashes, "evidence_sha256": observed_files,
        "candidate_count": CATALOG, "valid_queries": N, "planned_frames": protocol["input_lock"]["planned_frames"],
        "repetitions": 3, "orders": list(ORDERS), "method_count": len(METHODS),
        "numeric_observations": len(rows), "environment": environment, "node_environment": node_environment,
        "execution_started_unix": execution["started_unix"], "execution_finished_unix": execution["finished_unix"],
        "validation": {"all_66_method_order_repeat_cells_complete": True, "all_64_ordered_oracle_ids_checked": True,
                       "exhaustive_and_temporal_match_global_oracle": True, "all_method_answers_invariant_across_repeats_orders": True,
                       "score_absolute_tolerance": TOLERANCE, "quality_recomputed_from_retained_ids": True,
                       "current_node_is_heuristic_not_exact": True},
        "aggregates": aggregates, "per_pass": per_pass, "preparation": preparation,
        "limitations": [
            "This is a new independent hardware run. No numbers from the interrupted local run are pooled.",
            "These Python timings rotate all methods within each query; predecessor/cache effects may remain. Keep standalone isolated-control timings separate.",
            "There is one already-composited public video. Its frames and timing repetitions are not independent videos or perceptual ground truth.",
            "Recall measures agreement with the fixed strict-score global top-64; it does not measure identity recognition or human-perceived similarity.",
            "Search timings exclude video inference, input reads, descriptor/index construction and rendering; preparation is reported separately.",
            "The Node baseline is only the warm production search core. Wink supplements, quality overlays, browser scheduling and sequence optimization are excluded.",
            "Python and Node are implemented systems in different runtimes. No speed ratio establishes a language-independent algorithmic advantage.",
            "The exactness observations do not establish new research novelty or superiority over optimized native fused exact-search baselines.",
            "Aggregate percentiles pool repeated observations of the same fixed queries; no confidence intervals or population-level significance are claimed.",
        ],
    }, rows

def report_markdown(summary):
    lines = [
        "# Many Faces face-search benchmark: independent Actions run", "",
        "**Validation: complete.** Every fixed method, order, repetition and query was checked against retained evidence.", "",
        "This is a newly written analysis of the Actions run. It does not reconstruct missing local reports or combine hardware runs.", "",
        "## Run", "",
        "- Candidates: 70,000; valid queries: 1,011 of 1,061 decoded frames.",
        "- Three sequential repetitions of original and fixed shuffled order.",
        "- Python/Faiss: one thread on one logical CPU; the checked launcher applies the same affinity to Node.",
        "- CPU: " + summary["environment"]["cpu_model"],
        "- Experiment commit: " + summary["experiment_commit"],
        "- Production score/source commit: " + summary["production_source_commit"], "",
        "## Results", "",
        "Times include each implementation's timed search boundary and output assembly. Mean and p95 below describe the repeated fixed queries, not independent-video uncertainty.", "",
    ]
    for order in ORDERS:
        lines.extend(["### " + order, "", "| Method | Mean ms | p95 ms | Recall@1 | Recall@10 | Recall@64 | Worst Recall@64 |", "|---|---:|---:|---:|---:|---:|---:|"])
        for row in summary["aggregates"][order]:
            lines.append("| " + row["method"] + " | " + " | ".join(
                f"{row[key]:.3f}" if key in ("mean_ms", "p95_ms") else f"{row[key]:.6f}"
                for key in ("mean_ms", "p95_ms", "recall1", "recall10", "recall64", "worst_recall64")) + " |")
        lines.append("")
    lines.extend(["## Preparation and interpretation", "",
                  "Per-repeat descriptor construction, embedding/index build times, index sizes and memory observations are retained in summary.json. They are not hidden inside the search-time comparison.",
                  "Per-query metrics in per-query-metrics.csv.gz contain no face IDs, photos or landmark coordinates. All quality metrics are recomputed from private retained match arrays.",
                  "Node detailed-candidate counts are available only at pass level; they are not invented as per-query scoring counts.", "",
                  "## Limitations", ""])
    lines.extend("- " + item for item in summary["limitations"])
    lines.extend(["", "The standalone isolated control is a separate experiment. Its timings must not be pooled into these tables.", ""])
    return "\n".join(lines)

def publish(args, summary, rows):
    args.output.mkdir(parents=True, exist_ok=True)
    require(not any((args.output / name).exists() for name in ("summary.json", "REPORT.md", "per-query-metrics.csv.gz")), "Refuse to overwrite a published summary")
    with tempfile.TemporaryDirectory(prefix=".summary-stage-", dir=args.output) as folder:
        stage = Path(folder)
        with (stage / "per-query-metrics.csv.gz").open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
                with io.TextIOWrapper(compressed, encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
                    writer.writeheader()
                    writer.writerows(rows)
        (stage / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        (stage / "REPORT.md").write_text(report_markdown(summary))
        for name in ("per-query-metrics.csv.gz", "summary.json", "REPORT.md"):
            (stage / name).replace(args.output / name)

def public_summary(summary):
    public = {
        "status": summary["status"], "experiment_commit": summary["experiment_commit"],
        "production_source_commit": summary["production_source_commit"], "cpu": summary["environment"]["cpu_model"],
        "cpu_affinity": summary["environment"]["cpu_affinity"], "python": summary["environment"]["python"].split()[0],
        "numpy": summary["environment"]["numpy"], "faiss": summary["environment"]["faiss"],
        "candidates": CATALOG, "queries": N, "repetitions": 3, "method_count": len(METHODS),
        "all_exact_checks_passed": True, "scope": "independent Actions main run; cyclic method interleaving; no local or isolated-control pooling",
        "files": ["summary.json", "REPORT.md", "per-query-metrics.csv.gz"],
    }
    for order in ORDERS:
        public[order] = [
            {"method": row["method"], "ms": round(row["mean_ms"], 3),
             "ms_repeats": [round(value, 3) for value in row["mean_ms_by_repeat"]],
             "p95": round(row["p95_ms"], 3), "r1": round(row["recall1"], 6),
             "r10": round(row["recall10"], 6), "r64": round(row["recall64"], 6),
             "worst64": round(row["worst_recall64"], 6),
             "scored": None if row["mean_scored"] is None else round(row["mean_scored"], 2),
             "full_scans": row["full_scans_by_repeat"]}
            for row in summary["aggregates"][order]
        ]
    return public

def self_test():
    source_gate()
    ids = np.arange(K, dtype=np.int64)
    scores = np.arange(K, dtype=np.float64)
    require(answer_metrics(ids, scores, ids, scores)["recall64"] == 1., "Correct oracle rejected")
    missing = np.arange(1, K + 1, dtype=np.int64)
    metrics = answer_metrics(missing, np.arange(1, K + 1, dtype=np.float64), ids, scores)
    require(metrics["recall1"] == 0. and metrics["recall10"] == .9 and metrics["recall64"] == 63 / 64, "Recall checker failed")
    for bad_ids, bad_scores in ((np.zeros(K, dtype=np.int64), scores),
                                (ids, scores + 1), (ids.astype(float), scores),
                                (ids + K, np.r_[0., .5, np.arange(2, K, dtype=float)])):
        try:
            answer_metrics(bad_ids, bad_scores, ids, scores)
        except ValueError:
            pass
        else:
            raise AssertionError("A malformed result incorrectly passed validation")
    empty = answer_metrics(np.array([], dtype=np.int64), np.array([]), ids, scores, allow_short=True)
    require(empty["recall64"] == 0. and empty["score_excess"] is None, "Empty Node result must be retained as a failure")
    print("SUMMARIZER_SELF_TEST_PASS", flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", type=Path, default=REPO / "work/face-search/experiment-actions-v1")
    parser.add_argument("--data", type=Path, default=REPO / "work/face-search")
    parser.add_argument("--output", type=Path, default=HERE / "results/actions-v1")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    try:
        summary, rows = analyze(args)
        publish(args, summary, rows)
    except BaseException as error:
        args.output.mkdir(parents=True, exist_ok=True)
        failure = {"status": "no_valid_main_summary", "error_type": type(error).__name__, "message": str(error),
                   "time": time.time(), "numeric_summary_published": False,
                   "instruction": "Inspect input preflight and main execution/failure logs. Do not substitute the interrupted local run or a partial repetition."}
        path = args.output / "validation-failure.json"
        if path.exists():
            path = args.output / ("validation-failure-" + str(time.time_ns()) + ".json")
        path.write_text(json.dumps(failure, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        print("PUBLIC_SUMMARY_NOT_AVAILABLE: " + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
    print("PUBLIC_SUMMARY_BEGIN", flush=True)
    print(json.dumps(public_summary(summary), ensure_ascii=False, separators=(",", ":"), allow_nan=False), flush=True)
    print("PUBLIC_SUMMARY_END", flush=True)

if __name__ == "__main__":
    main()
