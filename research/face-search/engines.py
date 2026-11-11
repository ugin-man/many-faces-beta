"""Shared strict-score search engines for the fixed research experiment.

Faiss searches a documented surrogate embedding, then every returned candidate
is scored by the same production strictTotal formula. IndexFlatL2 is exact only
for the surrogate; it is NOT an exact oracle for strictTotal.
"""
from __future__ import annotations

import numpy as np

from strict_metric import (
    PreparedFaces, GROUP_INDEXES, EXPRESSION_WEIGHTS, MOUTH_SHAPE_WEIGHTS,
    BLEND_ACTION_INDEXES, BLEND_ACTION_WEIGHTS, MOUTH_ACTION_INDEXES,
    MOUTH_ACTION_WEIGHT_ARRAY, score_prepared, stable_topk,
)


EMBEDDING_SPEC = {
    "name": "strict-components-l2-v1",
    "training": "none; coefficients fixed from the existing strictTotal expression",
    "precision": "float32 embedding; float64 strict reranking",
    "roll": "compensated; roll omitted",
    "wink_activity": 0.5,
    "limitation": "L2 concatenation approximates sums and maxima; it is not the strict score",
}


def embedding(faces: PreparedFaces) -> np.ndarray:
    # RMS components are embedded with their existing coefficient. Minimax is
    # approximated by concatenation, identically for Flat and HNSW. No weights
    # are fitted to query results. The query-dependent wink coefficient uses
    # the fixed midpoint activity (0.5) only for candidate generation.
    groups = {
        "contour": .23 * .62,
        "nose": .23 * .2,
        "mouth": .54 * 1.15 + .08 / 3,
        "left_eye": .54 * 1.6 + .08 / 6,
        "right_eye": .54 * 1.6 + .08 / 6,
        "brows": .54 * 1.2 + .08 / 3,
    }
    parts = [faces.groups[key] * (weight / np.sqrt(len(GROUP_INDEXES[key])))
             for key, weight in groups.items()]

    def rms(values, weights, coefficient):
        w = np.asarray(weights, dtype=np.float64)
        return values * np.sqrt(w / w.sum()) * coefficient

    parts.extend((
        rms(faces.expression[:, :4], EXPRESSION_WEIGHTS[:4], .54 * .48),
        rms(faces.expression[:, 4:6], [1.5, 1.5], .54 * .52),
        rms(faces.expression[:, 6:8], [1., 1.], .54 * .4),
        rms(faces.mouth_shape, MOUTH_SHAPE_WEIGHTS, .54 * .95 * .62),
        rms(faces.features[:, MOUTH_ACTION_INDEXES], MOUTH_ACTION_WEIGHT_ARRAY, .54 * .95 * .38),
        rms(faces.features[:, BLEND_ACTION_INDEXES], BLEND_ACTION_WEIGHTS, .54 * .16),
        faces.blinks * (.54 * .42 / np.sqrt(2)),
        (faces.blinks[:, 0] - faces.blinks[:, 1])[:, None] * (.54 * (.42 + .58 * .5) + .12 + .48 * .5),
        faces.features[:, :2] * (.23 * .08),
        faces.features[:, 1:2] * (.23 * .1 + .15),
    ))
    return np.ascontiguousarray(np.concatenate(parts, axis=1), dtype=np.float32)


class ExhaustiveStrict:
    def __init__(self, candidates: PreparedFaces, k=64):
        self.candidates, self.k = candidates, k

    def reset(self):
        pass

    def search(self, query: PreparedFaces, query_index=0, *, compensate_roll=True):
        values = score_prepared(query, query_index, self.candidates, compensate_roll=compensate_roll)
        result = stable_topk(values, self.k)
        return result, values[result], {"scored": len(values), "full_scan": True}


class FaissRerank:
    def __init__(self, index, candidates: PreparedFaces, pool: int, k=64, *, hnsw=False):
        self.index, self.candidates, self.pool, self.k = index, candidates, pool, k
        self.hnsw = hnsw

    def reset(self):
        pass

    def search(self, query: PreparedFaces, query_index=0, *, compensate_roll=True):
        if not compensate_roll:
            raise ValueError("The frozen surrogate embedding requires compensated roll")
        if self.hnsw:
            self.index.hnsw.efSearch = max(128, self.pool * 2)
        vector = embedding(query)[query_index:query_index + 1]
        _, found = self.index.search(vector, min(self.pool, len(self.candidates)))
        selected = np.unique(found[0][found[0] >= 0])
        values = score_prepared(query, query_index, self.candidates, selected,
                                compensate_roll=compensate_roll)
        result = stable_topk(values, self.k, selected)
        return result, values[np.searchsorted(selected, result)], {
            "scored": len(selected), "full_scan": False,
        }
