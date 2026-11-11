#!/usr/bin/env python3
"""Run the frozen single-query search experiment, retaining per-query evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import resource
import sys
import time
from pathlib import Path

# Keep BLAS/OpenMP single-threaded before importing any numerical library.
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np
import faiss

from engines import EMBEDDING_SPEC, ExhaustiveStrict, FaissRerank, embedding
from strict_metric import prepare
from temporal_exact import TemporalExact, REFRESH_FRACTION, BOUND_EPSILON_FACTOR

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, allow_nan=False), flush=True)


def load_arrays(data, protocol):
    ids = json.loads((data / "candidate-ids.json").read_text())
    metadata = json.loads((data / "queries.json").read_text())
    catalog_manifest = json.loads((data / "catalog.manifest.json").read_text())
    query_manifest = json.loads((data / "queries.manifest.json").read_text())
    expected_hashes = {}
    for manifest in (catalog_manifest, query_manifest):
        if manifest["sourceCommit"] != protocol["source_commit"]:
            raise ValueError("Input source commit differs from the frozen protocol")
        for name, facts in manifest["files"].items():
            if Path(name).name != name:
                raise ValueError("Unsafe input manifest path")
            if digest(data / name) != facts["sha256"]:
                raise ValueError(f"Input hash differs from preparation manifest: {name}")
            expected_hashes[name] = facts["sha256"]
    for name, value in protocol["input_lock"].items():
        if name.endswith((".f64", ".json")) and expected_hashes.get(name) != value:
            raise ValueError(f"Input differs from the pre-measurement protocol: {name}")
    expected_count = protocol["input_lock"]["valid_queries"]
    frames = protocol["input_lock"]["planned_frames"]
    evidence = query_manifest["evidence"]
    if query_manifest["queryCount"] != len(metadata) or len(metadata) != expected_count:
        raise ValueError("Query count differs from fixed extraction")
    if query_manifest["plannedFrames"] != frames or query_manifest["decodedFrames"] != frames:
        raise ValueError("Incomplete frame decoding")
    if [row["sourceFrameIndex"] for row in evidence] != list(range(frames)):
        raise ValueError("Frame accounting is not a complete ordered enumeration")
    if [row["sourceFrameIndex"] for row in metadata] != [row["sourceFrameIndex"] for row in evidence if row["valid"]]:
        raise ValueError("Query selection differs from all valid detected frames")
    if len(ids) != 70000 or ids != sorted(set(ids)):
        raise ValueError("Require the complete 70,000-record corpus in unique canonical ID order")
    if not metadata or any(not item["compensateRoll"] for item in metadata):
        raise ValueError("Require nonempty, compensated-roll production query features")
    result = {}
    for name, rows, columns in (("candidates.features", len(ids), 55),
                                ("candidates.projections", len(ids), 936),
                                ("queries.features", len(metadata), 55),
                                ("queries.projections", len(metadata), 936)):
        file = data / f"{name}.f64"
        if file.stat().st_size != rows * columns * 8:
            raise ValueError(f"Invalid array size: {name}")
        result[name] = np.memmap(file, dtype="<f8", mode="r", shape=(rows, columns))
        if not np.isfinite(result[name]).all():
            raise ValueError(f"Nonfinite input: {name}")
    return ids, metadata, result


def summarize(rows):
    milliseconds = np.array([row["elapsed_ms"] for row in rows])
    return {
        "queries": len(rows), "total_ms": float(milliseconds.sum()),
        "mean_ms": float(milliseconds.mean()), "median_ms": float(np.median(milliseconds)),
        "p95_ms": float(np.percentile(milliseconds, 95)), "max_ms": float(milliseconds.max()),
        **{name: float(np.mean([row[name] for row in rows]))
           for name in ("recall1", "recall10", "recall64", "score_excess", "scored")},
        "min_recall64": float(min(row["recall64"] for row in rows)),
        "max_score_excess": float(max(row["score_excess"] for row in rows)),
        "full_scans": sum(bool(row["full_scan"]) for row in rows),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", type=Path, default=REPO / "work/face-search")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--repeat", type=int, default=0)
    p.add_argument("--smoke-queries", type=int, default=0)
    p.add_argument("--orders", nargs="+", choices=["original", "shuffled"], default=["original", "shuffled"])
    p.add_argument("--prepare-only", action="store_true")
    args = p.parse_args()
    if args.output.exists():
        raise FileExistsError("Refuse to overwrite an existing experiment output")
    args.output.mkdir(parents=True)
    protocol = json.loads((HERE / "protocol.json").read_text())
    if REFRESH_FRACTION != protocol["temporal_exact"]["fallback_fraction"] or BOUND_EPSILON_FACTOR != protocol["temporal_exact"]["floating_margin_scale"]:
        raise ValueError("Temporal implementation constants differ from protocol.json")
    parity = json.loads((args.data / "strict-metric-verification.json").read_text())
    if parity.get("status") != "pass" or parity.get("pythonPortSha256") != digest(HERE / "strict_metric.py"):
        raise ValueError("Run a passing metric parity check for the current Python score implementation")
    for name, expected in parity["sourceHashes"].items():
        if digest(HERE / name) != expected:
            raise ValueError("Production scoring source changed since parity verification")
    if faiss.__version__ != protocol["faiss_version"]:
        raise ValueError("Use the exact Faiss version fixed in protocol.json")
    faiss.omp_set_num_threads(1)
    loaded_at = time.perf_counter()
    ids, metadata, arrays = load_arrays(args.data, protocol)
    read_seconds = time.perf_counter() - loaded_at
    query_count = len(metadata)
    all_orders = {"original": list(range(query_count)),
                  "shuffled": np.random.Generator(np.random.PCG64(protocol["shuffle_seed"])).permutation(query_count).tolist()}
    orders_path = args.data / "orders.json"
    orders_document = {"seed": protocol["shuffle_seed"], "orders": all_orders}
    if orders_path.exists() and json.loads(orders_path.read_text()) != orders_document:
        raise ValueError("Existing order manifest differs from the frozen protocol")
    write_json(orders_path, orders_document)
    code_hashes = {name: digest(HERE / name) for name in
                   ("benchmark.py", "engines.py", "strict_metric.py", "temporal_exact.py")}
    data_files = ["candidate-ids.json", "candidate-shards.json", "candidates.features.f64",
                  "candidates.projections.f64", "queries.features.f64", "queries.projections.f64",
                  "queries.json", "queries.manifest.json", "catalog.manifest.json", "orders.json",
                  "strict-metric-verification.json"]
    manifest = {
        "protocol": protocol, "protocol_sha256": digest(HERE / "protocol.json"),
        "code_sha256": code_hashes,
        "input_sha256": {name: digest(args.data / name) for name in data_files},
        "candidate_count": len(ids), "query_count": query_count,
        "smoke_queries": args.smoke_queries, "repeat": args.repeat,
        "selected_orders": args.orders,
        "all_protocol_orders": sorted(args.orders) == sorted(protocol["orders"]),
        "platform": platform.platform(), "python": sys.version, "numpy": np.__version__,
        "faiss": faiss.__version__, "faiss_compile": faiss.get_compile_options(),
        "cpu_count": os.cpu_count(), "faiss_threads": faiss.omp_get_max_threads(),
        "cpu_affinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
        "cpu_model": next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")), "unknown"),
        "started_unix": time.time(), "embedding": EMBEDDING_SPEC,
    }
    write_json(args.output / "manifest.json", manifest)
    if args.prepare_only:
        return
    prepared_at = time.perf_counter()
    candidates = prepare(arrays["candidates.features"], arrays["candidates.projections"])
    descriptor_seconds = time.perf_counter() - prepared_at
    embedded_at = time.perf_counter()
    vectors = embedding(candidates)
    embedding_seconds = time.perf_counter() - embedded_at
    build_at = time.perf_counter()
    flat = faiss.IndexFlatL2(vectors.shape[1])
    flat.add(vectors)
    flat_build_seconds = time.perf_counter() - build_at
    build_at = time.perf_counter()
    hnsw = faiss.IndexHNSWFlat(vectors.shape[1], protocol["hnsw"]["M"])
    hnsw.hnsw.efConstruction = protocol["hnsw"]["efConstruction"]
    hnsw.hnsw.rng = faiss.RandomGenerator(protocol["hnsw"]["seed"])
    hnsw.add(vectors)
    hnsw_build_seconds = time.perf_counter() - build_at
    construction = {
        "input_read_seconds": read_seconds, "descriptor_seconds": descriptor_seconds,
        "embedding_seconds": embedding_seconds, "flat_build_seconds": flat_build_seconds,
        "hnsw_build_seconds": hnsw_build_seconds,
        "descriptor_payload_bytes": candidates.nbytes, "embedding_bytes": vectors.nbytes,
        "flat_serialized_bytes": int(faiss.serialize_index(flat).nbytes),
        "hnsw_serialized_bytes": int(faiss.serialize_index(hnsw).nbytes),
        "embedding_dimensions": vectors.shape[1],
        "note": "Descriptors are shared by all Python methods; process RSS includes all competing indexes",
    }
    write_json(args.output / "construction.json", construction)
    engines = {"exhaustive_strict": ExhaustiveStrict(candidates, protocol["k"]),
               "temporal_exact": TemporalExact(candidates, k=protocol["k"])}
    for budget in protocol["candidate_budgets"]:
        engines[f"faiss_flat_{budget}"] = FaissRerank(flat, candidates, budget, protocol["k"])
        engines[f"faiss_hnsw_{budget}"] = FaissRerank(hnsw, candidates, budget, protocol["k"], hnsw=True)
    methods = list(engines)
    # DB-derived warmup. Never expose a measured future query to temporal state.
    for source in (0, len(ids) // 2, len(ids) - 1):
        warm = prepare(arrays["candidates.features"][source:source + 1], arrays["candidates.projections"][source:source + 1])
        for engine in engines.values():
            engine.search(warm)
    for engine in engines.values():
        engine.reset()
    log("ready", construction=construction, methods=methods, query_count=query_count)
    summaries, oracle_ids, oracle_scores = {}, {}, {}
    selected_orders = args.orders if args.repeat % 2 == 0 else list(reversed(args.orders))
    try:
        for order_name in selected_orders:
            for engine in engines.values():
                engine.reset()
            order = all_orders[order_name]
            if args.smoke_queries:
                order = order[:args.smoke_queries]
            rows_by_method = {name: [] for name in methods}
            raw_ids = np.empty((len(order), len(methods), protocol["k"]), dtype=np.int32)
            raw_scores = np.empty((len(order), len(methods), protocol["k"]), dtype=np.float64)
            order_start = time.perf_counter()
            with (args.output / f"{order_name}.jsonl").open("w") as evidence:
                for position, query_id in enumerate(order):
                    # Rotate the method order, including full scan, to distribute
                    # shared-memory cache effects. Each engine prepares its query.
                    shift = (position + args.repeat) % len(methods)
                    names = methods[shift:] + methods[:shift]
                    results = {}
                    for name in names:
                        started = time.perf_counter_ns()
                        query = prepare(arrays["queries.features"][query_id:query_id + 1],
                                        arrays["queries.projections"][query_id:query_id + 1])
                        chosen, scores, stats = engines[name].search(query, compensate_roll=metadata[query_id]["compensateRoll"])
                        returned_ids, returned_scores = chosen.tolist(), scores.tolist()
                        elapsed_ms = (time.perf_counter_ns() - started) / 1e6
                        if len(returned_ids) != protocol["k"] or len(set(returned_ids)) != protocol["k"]:
                            raise AssertionError(f"Incomplete or duplicate output from {name}")
                        if any(i < 0 or i >= len(ids) for i in returned_ids) or not np.isfinite(returned_scores).all():
                            raise AssertionError(f"Invalid index or nonfinite score from {name}")
                        if returned_scores != sorted(returned_scores):
                            raise AssertionError(f"Unsorted result from {name}")
                        raw_ids[position, methods.index(name)] = returned_ids
                        raw_scores[position, methods.index(name)] = returned_scores
                        results[name] = (returned_ids, returned_scores, stats, elapsed_ms)
                    expected_ids, expected_scores, _, _ = results["exhaustive_strict"]
                    if query_id in oracle_ids and (expected_ids != oracle_ids[query_id] or expected_scores != oracle_scores[query_id]):
                        raise AssertionError("Exhaustive result changed across orders")
                    oracle_ids[query_id], oracle_scores[query_id] = expected_ids, expected_scores
                    exact_ids, exact_scores, _, _ = results["temporal_exact"]
                    if exact_ids != expected_ids or not np.allclose(exact_scores, expected_scores, atol=2e-12, rtol=2e-12):
                        raise AssertionError(f"Temporal exactness failure at {order_name}/{query_id}")
                    for name, (chosen, scores, stats, elapsed_ms) in results.items():
                        row = {
                            "order": order_name, "position": position, "query_index": query_id,
                            "source_frame": metadata[query_id]["sourceFrameIndex"], "method": name,
                            "elapsed_ms": elapsed_ms,
                            **{f"recall{k}": len(set(chosen[:k]) & set(expected_ids[:k])) / k for k in (1, 10, 64)},
                            "score_excess": max(0., scores[0] - expected_scores[0]), **stats,
                        }
                        rows_by_method[name].append(row)
                        evidence.write(json.dumps(row, allow_nan=False) + "\n")
                    if position % 100 == 0 or position + 1 == len(order):
                        evidence.flush()
                        log("progress", order=order_name, done=position + 1, total=len(order),
                            elapsed_seconds=time.perf_counter() - order_start)
            summaries[order_name] = {name: summarize(rows) for name, rows in rows_by_method.items()}
            write_json(args.output / "summary.json", summaries)
            np.savez_compressed(args.output / f"matches-{order_name}.npz", methods=np.asarray(methods),
                                query_indices=np.asarray(order), indices=raw_ids, scores=raw_scores)
        canonical = sorted(oracle_ids)
        # Derived face selections stay under ignored work/, never in public
        # evidence. Published metrics contain no photos, landmarks or match IDs.
        write_json(args.output / "oracle.json", {
            "query_indices": canonical, "indices": [oracle_ids[q] for q in canonical],
            "scores": [oracle_scores[q] for q in canonical],
        })
        for name, expected in manifest["code_sha256"].items():
            if digest(HERE / name) != expected:
                raise AssertionError(f"Benchmark code changed during measurement: {name}")
        if digest(HERE / "protocol.json") != manifest["protocol_sha256"]:
            raise AssertionError("Protocol changed during measurement")
        for name, expected in manifest["input_sha256"].items():
            if digest(args.data / name) != expected:
                raise AssertionError(f"Input changed during measurement: {name}")
        manifest.update({"completed": True, "finished_unix": time.time(),
                         "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                         "temporal_exact_matches": True})
        write_json(args.output / "manifest.json", manifest)
        log("completed", output=str(args.output), peak_rss_bytes=manifest["peak_rss_bytes"])
    except BaseException as error:
        write_json(args.output / "failure.json", {"type": type(error).__name__, "message": str(error), "time": time.time()})
        raise


if __name__ == "__main__":
    main()
