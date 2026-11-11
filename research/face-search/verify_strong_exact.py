#!/usr/bin/env python3
"""Finite correctness gate for the six fixed V2 exact-search implementations.

The sample is chosen by source index, before looking at any score. Synthetic
cases exercise blink clipping, coefficient boundaries, degenerate widths,
duplicate ties and abrupt changes. This program does not measure search speed.
The full 70,000 by 1,011 benchmark requires its separate exhaustive-oracle gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from engines import embedding
from native_scorer import NativeKernel, build_native
from strict_metric import FEATURE_INDEX, prepare, score_prepared, stable_topk
from strong_exact_engines import METHODS, change_bounds, create_engine, select_pivots
from temporal_exact import BOUND_EPSILON_FACTOR, TemporalExact, query_change_bound


ROOT = Path(__file__).resolve().parents[2]
ATOL = 2e-12
SOURCE_NAMES = (
    "strong_exact_engines.py", "native_scorer.py", "native/strict_kernel.cpp",
    "strict_metric.py", "temporal_exact.py", "verify_strong_exact.py", "engines.py",
)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def matrix(path, width):
    size = path.stat().st_size
    if size == 0 or size % (width * 8):
        raise ValueError(f"Invalid float64 matrix size: {path}")
    return np.memmap(path, dtype="<f8", mode="r", shape=(size // (width * 8), width))


def fixture(data):
    cf = matrix(data / "candidates.features.f64", 55)
    cp = matrix(data / "candidates.projections.f64", 936)
    qf = matrix(data / "queries.features.f64", 55)
    qp = matrix(data / "queries.projections.f64", 936)
    if len(cf) != len(cp) or len(qf) != len(qp):
        raise ValueError("Feature and projection row counts differ")
    if len(cf) < 128 or len(qf) < 16:
        raise ValueError("Insufficient source records for the fixed verification sample")
    ci = np.linspace(0, len(cf) - 1, 128, dtype=int)
    qi = sorted(set(range(8)) | set(np.linspace(0, len(qf) - 1, 16, dtype=int).tolist()))
    candidate_features = np.array(cf[ci], copy=True)
    candidate_points = np.array(cp[ci], copy=True)
    query_features = np.array(qf[qi], copy=True)
    query_points = np.array(qp[qi], copy=True)
    synthetic_features, synthetic_points, labels = [], [], []

    def add(label, feature, points):
        labels.append(label)
        synthetic_features.append(feature.copy())
        synthetic_points.append(points.copy())

    blink_pairs = [(0., 0.), (.139999999, 0.), (.14, 0.), (.140000001, 0.),
                   (.559999999, 0.), (.56, 0.), (.560000001, 0.), (1., 0.),
                   (0., 1.), (-1., 2.), (2., -1.), (.42, .56), (.56, .42)]
    for index, (left, right) in enumerate(blink_pairs):
        feature = query_features[0].copy()
        feature[FEATURE_INDEX["eyeBlinkLeft"]] = left
        feature[FEATURE_INDEX["eyeBlinkRight"]] = right
        add(f"wink-boundary-{index}", feature, query_points[0])
    feature = query_features[0].copy()
    feature[:3] = [1.5, -1.5, 1.5]
    add("pose-jump", feature, query_points[0])
    points = query_points[0].reshape(468, 2).copy()
    for left, right in ((61, 291), (78, 308), (33, 133), (362, 263)):
        points[right] = points[left]
    add("degenerate-widths", query_features[0], points.reshape(-1))
    add("all-zero", np.zeros(55), np.zeros(936))
    add("duplicate-a", candidate_features[0], candidate_points[0])
    add("duplicate-b", candidate_features[0], candidate_points[0])
    sf, sp = np.asarray(synthetic_features), np.asarray(synthetic_points)
    features = np.vstack((candidate_features, sf))
    points = np.vstack((candidate_points, sp))
    # Self hits include the fixed initial pivot, independently of later scores.
    self_indexes = np.array([0, len(features) // 2, len(features) - 1], dtype=int)
    qfeatures = np.vstack((query_features, sf, features[self_indexes]))
    qpoints = np.vstack((query_points, sp, points[self_indexes]))
    manifest = {
        "candidate_source_indexes": ci.tolist(), "query_source_indexes": qi,
        "synthetic_labels": labels, "candidate_self_query_indexes": self_indexes.tolist(),
        "source_candidates": len(cf), "source_queries": len(qf),
        "real_candidates": len(ci), "real_queries": len(qi),
        "synthetic_records": len(sf), "candidates": len(features), "queries": len(qfeatures),
    }
    sample_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
    for array in (features, points, qfeatures, qpoints):
        sample_hash.update(np.ascontiguousarray(array, dtype="<f8").tobytes())
    manifest["fixture_sha256"] = sample_hash.hexdigest()
    return prepare(features, points), prepare(qfeatures, qpoints), manifest, (features, points)


def compare_scores(actual, expected, maxima, key):
    np.testing.assert_allclose(actual, expected, rtol=0., atol=ATOL, err_msg=key)
    maximum = float(np.max(np.abs(actual - expected))) if len(actual) else 0.
    maxima[key] = max(maxima.get(key, 0.), maximum)


def check_native(kernel, candidates, queries):
    native_candidates, native_queries = kernel.bind(candidates), kernel.bind(queries)
    for original, bound in ((candidates, native_candidates), (queries, native_queries)):
        assert bound.source is original
        for name in ("features", "expression", "mouth_shape", "blinks"):
            assert np.shares_memory(getattr(bound, name), getattr(original, name))
        for name in original.groups:
            assert np.shares_memory(bound.groups[name], original.groups[name])
    maxima, full_scores = {}, {}
    subset = np.array([len(candidates) - 1, 0, len(candidates) // 2, 0, 3], dtype=np.int64)
    scalars, subset_checks = 0, 0
    for roll in (False, True):
        full_scores[roll] = []
        for index in range(len(queries)):
            expected = score_prepared(queries, index, candidates, compensate_roll=roll, return_components=True)
            actual = kernel.score_prepared(native_queries, index, native_candidates,
                                           compensate_roll=roll, return_components=True)
            assert expected.keys() == actual.keys()
            for name in expected:
                compare_scores(actual[name], expected[name], maxima, name)
                scalars += len(candidates)
            full_scores[roll].append(expected["strictTotal"])
            # Score-only mode and noncanonical subsets use the identical score.
            values = kernel.score_prepared(native_queries, index, native_candidates, compensate_roll=roll)
            compare_scores(values, expected["strictTotal"], maxima, "score_only")
            values = kernel.score_prepared(native_queries, index, native_candidates, subset, compensate_roll=roll)
            compare_scores(values, expected["strictTotal"][subset], maxima, "subset")
            subset_checks += 1
        full_scores[roll] = np.array(full_scores[roll])
        empty = kernel.score_prepared(native_queries, 0, native_candidates,
                                      np.array([], dtype=np.int64), compensate_roll=roll)
        assert empty.shape == (0,)
    return full_scores, {
        "component_scalars": scalars, "subset_checks": subset_checks,
        "maximum_absolute_error_by_field": maxima, "zero_copy_bind_checked": True,
        "empty_subset_checked": True,
    }


def check_bounds(kernel, candidates, queries, full_scores, manifest):
    native_queries = kernel.bind(queries)
    start = manifest["real_queries"]
    stop = start + manifest["synthetic_records"]
    anchors = np.array(sorted({0, 1, len(queries) - 1, *range(start, stop)}), dtype=np.int64)
    maxima, scalar_comparisons, candidate_comparisons = {}, 0, 0
    maximum_violation = 0.
    for roll in (False, True):
        for current in range(len(queries)):
            numpy_bound = change_bounds(queries, current, queries, anchors,
                                         compensate_roll=roll, return_components=True)
            native_bound = change_bounds(native_queries, current, native_queries, anchors,
                                          compensate_roll=roll, kernel=kernel, return_components=True)
            for key in numpy_bound:
                compare_scores(native_bound[key], numpy_bound[key], maxima, "native_" + key)
            for position, anchor in enumerate(anchors):
                old = query_change_bound(queries, current, queries, int(anchor),
                                         compensate_roll=roll, return_components=True)
                for key in old:
                    compare_scores(np.array([numpy_bound[key][position]]), np.array([old[key]]),
                                   maxima, "v1_" + key)
                    scalar_comparisons += 1
                change = np.abs(full_scores[roll][current] - full_scores[roll][anchor])
                bound = native_bound["total"][position]
                violation = float(np.max(change - bound))
                maximum_violation = max(maximum_violation, violation)
                epsilon = BOUND_EPSILON_FACTOR * max(1., abs(bound),
                                                     float(np.max(np.abs(full_scores[roll][anchor]))))
                if violation > epsilon:
                    raise AssertionError(f"Query-change bound failed: {current=}, {anchor=}, {roll=}, {violation=}")
                candidate_comparisons += len(candidates)
    return {"scalar_v1_component_comparisons": scalar_comparisons,
            "candidate_bound_comparisons": candidate_comparisons,
            "maximum_violation_before_margin": maximum_violation,
            "maximum_absolute_component_error": maxima,
            "both_query_anchor_directions_checked": True}


def check_pivots(kernel, candidates):
    vectors = embedding(candidates)
    assert vectors.dtype == np.float32 and vectors.shape[1] == 371
    first8, first32 = select_pivots(vectors, 8), select_pivots(vectors, 32)
    np.testing.assert_array_equal(first8, first32[:8])
    assert first32[0] == len(candidates) // 2
    assert len(np.unique(first32)) == 32
    # Independent scalar distance recurrence checks farthest-first choices.
    values = vectors.astype(np.float64)
    for position in range(1, 32):
        distances = np.array([min(float(np.sum((row - values[pivot]) ** 2))
                                  for pivot in first32[:position]) for row in values])
        distances[first32[:position]] = -np.inf
        assert first32[position] == int(np.argmax(distances))
    # Identical vectors force canonical ties at every step and prohibit repeats.
    tie = select_pivots(np.zeros((40, 371), dtype=np.float32), 32)
    np.testing.assert_array_equal(tie, [20, *range(20), *range(21, 32)])
    maxima, table_pairs = {}, 0
    for count in (8, 32):
        engine = create_engine(f"native_pivot{count}", candidates, kernel=kernel)
        np.testing.assert_array_equal(engine._pivots, first32[:count])
        for roll in (False, True):
            for position, pivot in enumerate(engine._pivots):
                expected = score_prepared(candidates, int(pivot), candidates, compensate_roll=roll)
                compare_scores(engine._tables[roll][position], expected, maxima, "table_S_pivot_candidate")
                np.testing.assert_array_equal(engine._top[roll][position], stable_topk(expected, 64))
                assert engine._kth[roll][position] == engine._tables[roll][position, engine._top[roll][position, -1]]
                table_pairs += len(candidates)
            for array in (engine._tables[roll], engine._top[roll], engine._kth[roll], engine._scales[roll]):
                assert not array.flags.writeable
        assert engine.construction["precomputed_score_evaluations"] == 2 * count * len(candidates)
    return {"prefix_checked": True, "farthest_choices_checked": 31,
            "duplicate_vector_canonical_ties_checked": True, "table_score_pairs": table_pairs,
            "maximum_absolute_error": maxima, "score_table_policies": [False, True]}


def check_searches(kernel, candidates, queries, full_scores):
    orders = {
        "source_with_probes": np.arange(len(queries)),
        "fixed_shuffle": np.random.Generator(np.random.PCG64(20261111)).permutation(len(queries)),
        "repeated_query": np.repeat(np.array([0, 1, len(queries) - 2, len(queries) - 1]), 3),
    }
    totals = {method: {"checks": 0, "full_scan": 0, "bounded_subset": 0} for method in METHODS}
    max_error = 0.
    v1_stats_comparisons = 0
    for method in METHODS:
        for k in (1, 8, 64):
            engine = create_engine(method, candidates, k=k, kernel=kernel)
            bound_queries = engine.prepare_query(queries)
            baseline = TemporalExact(candidates, k=k) if method == "numpy_temporal" else None
            for roll in (False, True):
                for order in orders.values():
                    first_stats = []
                    for repetition in range(2):
                        engine.reset()
                        if baseline is not None:
                            baseline.reset()
                        for position, index in enumerate(order):
                            ids, scores, stats = engine.search(bound_queries, int(index), roll)
                            expected = stable_topk(full_scores[roll][index], k)
                            np.testing.assert_array_equal(ids, expected, err_msg=f"{method=} {k=} {roll=} {position=}")
                            np.testing.assert_allclose(scores, full_scores[roll][index][expected], rtol=0., atol=ATOL)
                            max_error = max(max_error, float(np.max(np.abs(scores - full_scores[roll][index][expected]))))
                            assert stats["scored"] == stats["score_evaluations"]
                            assert stats["scored"] >= stats["unique_candidates_scored"] >= k
                            assert stats["queries_seen"] == position + 1
                            assert stats["seed_count"] in (0, k)
                            if stats["full_scan"]:
                                assert stats["scored"] == len(candidates) + stats["seed_count"]
                            else:
                                assert stats["scored"] == stats["eligible_count"]
                            if method.endswith("temporal") and position == 0:
                                assert stats["full_scan"] and stats["reason"] == "initial"
                            if repetition == 0:
                                first_stats.append(stats)
                            else:
                                assert stats == first_stats[position], "reset changed the replay"
                            if baseline is not None:
                                old_ids, old_scores, old_stats = baseline.search(queries, int(index), roll)
                                np.testing.assert_array_equal(ids, old_ids)
                                np.testing.assert_array_equal(scores, old_scores)
                                assert stats == old_stats, "Generic NumPy temporal differs from frozen v1"
                                v1_stats_comparisons += 1
                            totals[method]["checks"] += 1
                            totals[method]["full_scan" if stats["full_scan"] else "bounded_subset"] += 1
            # Outputs are owned by the caller, for full and subset paths alike.
            engine.reset()
            for _ in range(2):
                ids, scores, _ = engine.search(bound_queries, len(queries) - 2, True)
                ids[:] = 0
                scores[:] = -123.
            ids, scores, _ = engine.search(bound_queries, len(queries) - 2, True)
            expected = stable_topk(full_scores[True][-2], k)
            np.testing.assert_array_equal(ids, expected)
            np.testing.assert_allclose(scores, full_scores[True][-2][expected], rtol=0., atol=ATOL)
            # Policy switches must refresh temporal state; fixed tables use the
            # correct policy without rebuilding or changing any stored table.
            for roll in (False, True, False):
                ids, scores, stats = engine.search(bound_queries, 0, roll)
                expected = stable_topk(full_scores[roll][0], k)
                np.testing.assert_array_equal(ids, expected)
                np.testing.assert_allclose(scores, full_scores[roll][0][expected], rtol=0., atol=ATOL)
                if method.endswith("temporal"):
                    assert stats["full_scan"] and stats["reason"] == "roll_policy_changed"
            engine.reset()
            if method.endswith("temporal"):
                assert engine.state_nbytes == 0
        # k >= N exercises the complete ordering and the full-scan branch.
        engine = create_engine(method, candidates, k=len(candidates) + 5, kernel=kernel)
        bound_queries = engine.prepare_query(queries)
        for roll in (False, True):
            for index in (0, 1):
                ids, scores, stats = engine.search(bound_queries, index, roll)
                expected = stable_topk(full_scores[roll][index], len(candidates))
                np.testing.assert_array_equal(ids, expected)
                np.testing.assert_allclose(scores, full_scores[roll][index][expected], rtol=0., atol=ATOL)
                assert stats["full_scan"]
    for method in METHODS:
        assert totals[method]["full_scan"] > 0
        if not method.endswith("exhaustive"):
            assert totals[method]["bounded_subset"] > 0, f"No pruned path exercised: {method}"
    return {"by_method": totals, "maximum_absolute_returned_score_error": max_error,
            "numpy_temporal_v1_stats_comparisons": v1_stats_comparisons,
            "top_k_values": [1, 8, 64, len(candidates)], "ordered_id_mismatches": 0,
            "reset_replay_checked": True, "output_alias_safety_checked": True,
            "roll_policy_switches_checked": True}


def check_ties(kernel, raw):
    features, points = raw
    # A tie spanning the pruning threshold must not drop smaller canonical IDs.
    candidates = prepare(np.repeat(features[:1], 96, axis=0), np.repeat(points[:1], 96, axis=0))
    checks = 0
    for method in METHODS:
        for k in (1, 8, 64):
            engine = create_engine(method, candidates, k=k, kernel=kernel)
            queries = engine.prepare_query(candidates)
            for roll in (False, True):
                for _ in range(2):
                    ids, scores, _ = engine.search(queries, 0, roll)
                    np.testing.assert_array_equal(ids, np.arange(k))
                    np.testing.assert_array_equal(scores, np.zeros(k))
                    checks += 1
    return checks


def verify(data, library, output):
    kernel = NativeKernel(library)
    candidates, queries, manifest, raw = fixture(data)
    full_scores, numeric = check_native(kernel, candidates, queries)
    bounds = check_bounds(kernel, candidates, queries, full_scores, manifest)
    pivots = check_pivots(kernel, candidates)
    searches = check_searches(kernel, candidates, queries, full_scores)
    tie_checks = check_ties(kernel, raw)
    directory = Path(__file__).resolve().parent
    report = {
        "status": "pass", "purpose": "finite-v2-exact-search-correctness",
        "source_sha256": {name: digest(directory / name) for name in SOURCE_NAMES},
        "native_library_sha256": digest(library), "native_build": kernel.metadata,
        "input_sha256": {name: digest(data / name) for name in (
            "candidates.features.f64", "candidates.projections.f64",
            "queries.features.f64", "queries.projections.f64")},
        "numpy_version": np.__version__, "absolute_score_tolerance": ATOL,
        "relative_score_tolerance": 0., "fixture": manifest,
        "native_numeric": numeric, "query_change_bounds": bounds,
        "fixed_pivots": pivots, "searches": searches,
        "all_duplicate_tie_searches": tie_checks,
        "limitation": "Finite correctness sample and real-arithmetic bound argument; no interval-arithmetic proof for every floating-point input. No performance evidence. The full frozen corpus must independently pass its NumPy exhaustive ordered-ID and score gate.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "work/face-search")
    parser.add_argument("--library", type=Path)
    parser.add_argument("--build-dir", type=Path, default=ROOT / "work/native-v2-build")
    parser.add_argument("--output", "--out", type=Path, default=ROOT / "work/face-search/strong-exact-verification.json")
    arguments = parser.parse_args()
    library = arguments.library or build_native(arguments.build_dir)
    result = verify(arguments.data, library, arguments.output)
    print(json.dumps({"status": result["status"], "output": str(arguments.output),
                      "searches": result["searches"], "all_duplicate_tie_searches": result["all_duplicate_tie_searches"]}, indent=2))
