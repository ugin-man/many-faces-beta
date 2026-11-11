#!/usr/bin/env python3
"""Check the temporal bound and exact top-k against independently full scans.

The fixed real sample and explicit synthetic cases are correctness checks, not
the benchmark dataset. No timings or speed ratios are selected or reported.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from strict_metric import FEATURE_INDEX, prepare, score_prepared, stable_topk
from temporal_exact import TemporalExact, query_change_bound, BOUND_EPSILON_FACTOR, REFRESH_FRACTION


ROOT = Path(__file__).resolve().parents[2]


def matrix(path: Path, width: int) -> np.ndarray:
    size = path.stat().st_size
    if size % (width * 8):
        raise ValueError(f'Invalid float64 matrix size: {path}')
    return np.memmap(path, dtype='<f8', mode='r', shape=(size // (width * 8), width))


def verify(data: Path, output: Path) -> dict:
    cf = matrix(data / 'candidates.features.f64', 55)
    cp = matrix(data / 'candidates.projections.f64', 936)
    qf = matrix(data / 'queries.features.f64', 55)
    qp = matrix(data / 'queries.projections.f64', 936)
    candidate_indexes = np.linspace(0, len(cf) - 1, min(1024, len(cf)), dtype=int)
    # Include adjacent video queries and widely spaced abrupt-query transitions.
    query_indexes = sorted(set(range(min(32, len(qf)))) |
                           set(np.linspace(0, len(qf) - 1, min(16, len(qf)), dtype=int).tolist()))
    candidate_features = np.array(cf[candidate_indexes], copy=True)
    candidate_points = np.array(cp[candidate_indexes], copy=True)
    query_features = np.array(qf[query_indexes], copy=True)
    query_points = np.array(qp[query_indexes], copy=True)
    labels = [f'real-frame-{index}' for index in query_indexes]

    synthetic_features, synthetic_points = [], []
    # Closely straddle both changes of the query-dependent wink coefficient.
    # Out-of-range blink values additionally check clipping at both endpoints.
    blink_pairs = [(0., 0.), (.139999999, 0.), (.14, 0.), (.140000001, 0.),
                   (.559999999, 0.), (.56, 0.), (.560000001, 0.),
                   (1., 0.), (0., 1.), (-1., 2.), (2., -1.)]
    for i, (left, right) in enumerate(blink_pairs):
        feature = query_features[0].copy()
        feature[FEATURE_INDEX['eyeBlinkLeft']] = left
        feature[FEATURE_INDEX['eyeBlinkRight']] = right
        synthetic_features.append(feature)
        synthetic_points.append(query_points[0].copy())
        labels.append(f'synthetic-wink-boundary-{i}')
    # A displaced pose and collapsed mouth/eye widths challenge unrelated terms
    # and the refresh decision without asserting these are natural video frames.
    feature = query_features[0].copy()
    feature[:3] = [1.5, -1.5, 1.5]
    synthetic_features.append(feature)
    synthetic_points.append(query_points[0].copy())
    labels.append('synthetic-pose-jump')
    points = query_points[0].reshape(468, 2).copy()
    for left, right in [(61, 291), (78, 308), (33, 133), (362, 263)]:
        points[right] = points[left]
    synthetic_features.append(query_features[0].copy())
    synthetic_points.append(points.reshape(-1))
    labels.append('synthetic-degenerate-widths')
    synthetic_features = np.asarray(synthetic_features)
    synthetic_points = np.asarray(synthetic_points)
    # These added candidate probes ensure extreme candidate wink values are
    # included as well as extreme query wink values in the uniform-bound check.
    candidates = prepare(np.vstack((candidate_features, synthetic_features)),
                         np.vstack((candidate_points, synthetic_points)))
    queries = prepare(np.vstack((query_features, synthetic_features)),
                      np.vstack((query_points, synthetic_points)))
    full_scores = {}
    for compensate_roll in (False, True):
        full_scores[compensate_roll] = np.array([
            score_prepared(queries, index, candidates, compensate_roll=compensate_roll)
            for index in range(len(queries))
        ])
    bound_cases = 0
    maximum_bound_violation = 0.
    # All synthetic query/anchor combinations, plus adjacent and long-range
    # real pairs, make the coefficient direction and anchor/current roles matter.
    synthetic_start = len(query_indexes)
    pairs = {(i, max(0, i - 1)) for i in range(len(queries))}
    pairs |= {(i, 0) for i in range(len(queries))}
    pairs |= {(i, j) for i in range(synthetic_start, len(queries))
              for j in range(synthetic_start, len(queries))}
    for compensate_roll in (False, True):
        for current, anchor in sorted(pairs):
            bound = query_change_bound(queries, current, queries, anchor,
                                       compensate_roll=compensate_roll)
            actual_change = np.abs(full_scores[compensate_roll][current] - full_scores[compensate_roll][anchor])
            violation = float(np.max(actual_change - bound))
            maximum_bound_violation = max(maximum_bound_violation, violation)
            tolerance = BOUND_EPSILON_FACTOR * max(1., abs(bound), float(np.max(np.abs(full_scores[compensate_roll]))))
            if violation > tolerance:
                raise AssertionError(f'Invalid bound {current=} {anchor=} {compensate_roll=}: {violation} > {tolerance}')
            bound_cases += len(candidates)

    rng = np.random.default_rng(20261111)
    orders = {
        'source-with-boundary-probes': np.arange(len(queries)),
        'fixed-shuffle': rng.permutation(len(queries)),
        'identical-query-reuse': np.repeat(np.arange(min(8, len(queries))), 3),
    }
    checks, subset_calls, full_calls = 0, 0, 0
    repeat_stats = {}
    for k in (1, 8, 64):
        for compensate_roll in (False, True):
            for order_name, order in orders.items():
                engine = TemporalExact(candidates, k=k)
                first_run_stats = []
                for repetition in range(2):
                    engine.reset()
                    for position, index in enumerate(order):
                        returned, scores, stats = engine.search(queries, int(index), compensate_roll)
                        expected = stable_topk(full_scores[compensate_roll][index], k)
                        np.testing.assert_array_equal(returned, expected,
                                                      err_msg=f'{k=} {compensate_roll=} {order_name=} {position=}')
                        np.testing.assert_allclose(scores, full_scores[compensate_roll][index][expected], atol=2e-12, rtol=2e-12)
                        assert stats['scored'] == stats['score_evaluations']
                        assert stats['scored'] >= stats['unique_candidates_scored']
                        if position == 0:
                            assert stats['full_scan'] and stats['reason'] == 'initial'
                        if repetition == 0:
                            first_run_stats.append(stats)
                        else:
                            assert stats == first_run_stats[position], 'Reset leaked prior-pass state'
                        subset_calls += int(not stats['full_scan'])
                        full_calls += int(stats['full_scan'])
                        checks += 1
                repeat_stats[f'{k}:{compensate_roll}:{order_name}'] = len(order)

    # Switching score policy must invalidate the old policy's anchor bound.
    engine = TemporalExact(candidates, k=64)
    engine.search(queries, 0, True)
    returned, _, stats = engine.search(queries, 1, False)
    assert stats['full_scan'] and stats['reason'] == 'roll_policy_changed'
    np.testing.assert_array_equal(returned, stable_topk(full_scores[False][1], 64))
    # Returned indexes must not alias private anchor state.
    engine = TemporalExact(candidates, k=8)
    returned, _, _ = engine.search(queries, 0)
    returned[:] = 0
    next_returned, _, _ = engine.search(queries, 0)
    np.testing.assert_array_equal(next_returned, stable_topk(full_scores[True][0], 8))
    assert subset_calls > 0 and full_calls > 0, 'Both pruning and full refresh paths must be exercised'

    sample_hash = hashlib.sha256(json.dumps({'candidate_indexes': candidate_indexes.tolist(),
                                             'query_indexes': query_indexes, 'labels': labels},
                                            sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    report = {
        'status': 'pass', 'purpose': 'temporal-bound-and-search-correctness',
        'realCandidateSample': len(candidate_indexes), 'realQuerySample': len(query_indexes),
        'syntheticBoundaryQueriesAndCandidates': len(synthetic_features),
        'sampleManifestSha256': sample_hash, 'boundPairCandidatesChecked': bound_cases,
        'maximumObservedBoundViolationBeforeMargin': maximum_bound_violation,
        'topKSearchChecks': checks + 2, 'topKValues': [1, 8, 64],
        'resultIndexMismatches': 0, 'subsetSearchCalls': subset_calls,
        'fullScanCalls': full_calls, 'rollPolicyChangeForcesRefresh': True,
        'resetReplaysIdentical': True, 'returnedIndexesDoNotAliasState': True,
        'fixedRefreshFraction': REFRESH_FRACTION, 'epsilonFactor': BOUND_EPSILON_FACTOR,
        'ordersAndLengths': repeat_stats,
        'limitation': 'A real-arithmetic proof plus finite floating-point correctness checks, not a formally verified interval-arithmetic guarantee. This sample is not a speed benchmark or a substitute for the full fixed evaluation corpus.',
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=ROOT / 'work/face-search')
    parser.add_argument('--out', type=Path, default=ROOT / 'work/face-search/temporal-exact-verification.json')
    args = parser.parse_args()
    print(json.dumps(verify(args.data, args.out), indent=2))
