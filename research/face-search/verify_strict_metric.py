#!/usr/bin/env python3
"""Check the vectorized strict-score port against production JavaScript.

This is numerical validation, not retrieval-quality evaluation or a performance
benchmark. Validation samples are fixed by catalog order before any timings.
Synthetic boundary probes are reported separately from real catalog records.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np

from strict_metric import FACE_ACTION_KEYS, FEATURE_INDEX, prepare, score_prepared, stable_topk


ROOT = Path(__file__).resolve().parents[2]
ATOL = 2e-12
RTOL = 2e-12


def catalog_samples(catalog: Path) -> list[dict]:
    manifest = json.loads((catalog / 'manifest.json').read_text())
    files = sorted({file for cell in manifest['cells'].values()
                    for file in cell.get('shards', [cell.get('shard')]) if file})
    # Six sorted records from each of sixteen equally spaced catalog shards.
    # Avoid constructing or selecting the validation sample from score results.
    shard_indexes = np.linspace(0, len(files) - 1, 16, dtype=int)
    records = []
    for index in shard_indexes:
        items = json.loads((catalog / 'shards' / files[index]).read_text())['items']
        for item in sorted(items, key=lambda x: x['id'])[:6]:
            points = np.frombuffer(base64.b64decode(item['projection']), dtype='<i2').astype(np.float64) / 4096
            if len(item['feature']) == 55 and len(points) == 936:
                records.append({'id': item['id'], 'feature': item['feature'], 'projection': points.tolist()})
    # Some tail shards have fewer than six faces. Use all available fixed records.
    return sorted({record['id']: record for record in records}.values(), key=lambda x: x['id'])


def boundary_probes(base: dict) -> list[dict]:
    feature = np.asarray(base['feature'], dtype=np.float64)
    points = np.asarray(base['projection'], dtype=np.float64)
    variants = []
    def add(label: str, f: np.ndarray, p: np.ndarray) -> None:
        variants.append({'id': 'synthetic-' + label, 'feature': f.tolist(), 'projection': p.tolist()})
    add('zero', np.zeros(55), np.zeros(936))
    add('same-geometry', feature.copy(), points.copy())
    for label, left, right in [('left-wink', 1., 0.), ('right-wink', 0., 1.),
                                ('blink-clipping', -1., 2.), ('wink-activation-boundary', .56, .42)]:
        f = feature.copy()
        f[FEATURE_INDEX['eyeBlinkLeft']] = left
        f[FEATURE_INDEX['eyeBlinkRight']] = right
        add(label, f, points.copy())
    f = feature.copy()
    f[:3] = [1.25, -1.25, 1.25]
    add('pose-extreme', f, points.copy())
    # Coincident widths exercise the source's .025/.04/.05 denominator floors.
    p = points.reshape(468, 2).copy()
    p[291] = p[61]
    p[308] = p[78]
    p[133] = p[33]
    p[263] = p[362]
    add('coincident-widths', feature.copy(), p.reshape(-1))
    return variants


def verify(catalog: Path, output: Path) -> dict:
    real = catalog_samples(catalog)
    if len(real) < 20:
        raise ValueError('Insufficient catalog records for fixed numerical validation')
    probes = boundary_probes(real[0])
    candidates = sorted(real + probes, key=lambda x: x['id'])
    real_query_indexes = np.linspace(0, len(real) - 1, min(16, len(real)), dtype=int)
    queries = [real[index] for index in real_query_indexes] + probes
    fixture = {'candidates': candidates, 'queries': queries}
    with tempfile.TemporaryDirectory(prefix='many-faces-score-port-') as temp:
        fixture_path = Path(temp) / 'input.json'
        reference_path = Path(temp) / 'reference.json'
        fixture_bytes = json.dumps(fixture, separators=(',', ':')).encode()
        fixture_path.write_bytes(fixture_bytes)
        subprocess.run(['node', str(Path(__file__).with_name('strict-reference.mjs')),
                        str(fixture_path), str(reference_path)], cwd=ROOT, check=True)
        reference = json.loads(reference_path.read_text())
    if tuple(reference['actionKeys']) != FACE_ACTION_KEYS:
        raise AssertionError('Production feature order differs from port')
    prepared = prepare(np.array([x['feature'] for x in candidates]), np.array([x['projection'] for x in candidates]))
    prepared_queries = prepare(np.array([x['feature'] for x in queries]), np.array([x['projection'] for x in queries]))
    maxima: dict[str, float] = {}
    comparisons = 0
    rank_mismatches = []
    subset = np.array([len(candidates) - 1, 0, len(candidates) // 2, 3], dtype=int)
    for case in reference['results']:
        qi = next(i for i, query in enumerate(queries) if query['id'] == case['query'])
        actual = score_prepared(prepared_queries, qi, prepared, compensate_roll=case['compensateRoll'], return_components=True)
        for key, values in actual.items():
            if key not in case['errors'][0]:
                continue
            expected = np.array([error[key] for error in case['errors']])
            maximum = float(np.max(np.abs(expected - values)))
            maxima[key] = max(maxima.get(key, 0.), maximum)
            np.testing.assert_allclose(values, expected, rtol=RTOL, atol=ATOL,
                                       err_msg=f'{key}, query={case["query"]}, compensateRoll={case["compensateRoll"]}')
            comparisons += len(values)
        # Full ordering is checked, including self hits and deliberately duplicated
        # geometry. Very-near nonidentical scores can in principle exchange order;
        # any observed exchange is reported and causes this gate to fail.
        actual_rank = stable_topk(actual['strictTotal'], len(candidates)).tolist()
        if actual_rank != case['rank']:
            rank_mismatches.append({'query': case['query'], 'compensateRoll': case['compensateRoll'],
                                    'actual': actual_rank, 'reference': case['rank']})
        subset_scores = score_prepared(prepared_queries, qi, prepared, subset, compensate_roll=case['compensateRoll'])
        np.testing.assert_allclose(subset_scores, actual['strictTotal'][subset], rtol=RTOL, atol=ATOL)
    if rank_mismatches:
        raise AssertionError(f'{len(rank_mismatches)} numerical-validation rank mismatches: {rank_mismatches[:1]}')
    np.testing.assert_array_equal(stable_topk(np.array([1., 0., 0., 0., 2.]), 2), [1, 2])
    np.testing.assert_array_equal(stable_topk(np.array([0., 0., 0.]), 2, np.array([7, 4, 2])), [2, 4])
    np.testing.assert_array_equal(stable_topk(np.array([], dtype=float), 10), np.array([], dtype=int))
    empty = score_prepared(prepared_queries, 0, prepared, np.array([], dtype=int))
    assert empty.shape == (0,)
    report = {
        'status': 'pass', 'purpose': 'numerical-port-validation',
        'sourceHashes': reference['sourceHashes'],
        'pythonPortSha256': hashlib.sha256(Path(__file__).with_name('strict_metric.py').read_bytes()).hexdigest(),
        'fixtureSha256': hashlib.sha256(fixture_bytes).hexdigest(),
        'realCatalogRecords': len(real), 'syntheticBoundaryRecords': len(probes),
        'queries': len(queries), 'compensateRollValues': [False, True],
        'pairScoresCompared': len(reference['results']) * len(candidates),
        'componentScalarsCompared': comparisons, 'absoluteTolerance': ATOL, 'relativeTolerance': RTOL,
        'maximumAbsoluteErrorByField': maxima, 'rankMismatches': 0,
        'subsetChecks': len(reference['results']), 'boundaryTieChecks': 3,
        'limitation': 'Fixed finite sample validates the numerical port; it is not a mathematical proof for every floating-point input. The full score is query-asymmetric and not assumed to obey a triangle inequality.',
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'public/seed-catalog')
    parser.add_argument('--out', type=Path, default=ROOT / 'work/face-search/strict-metric-verification.json')
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.catalog, arguments.out), indent=2))
