"""Fixed V2 exact-search comparisons on the unchanged Many Faces score.

All six engines retain Python controllers, NumPy candidate masks and the same
stable_topk implementation.  ``native_*`` replaces scoring with the shared C++
kernel; it does not mean that the complete controller is implemented in C++.
Candidate/query descriptors still come from the unmodified strict_metric.prepare.
No query data are used to choose the fixed pivots.
"""
from __future__ import annotations

import time

import numpy as np

from engines import embedding
from strict_metric import PreparedFaces, score_prepared, stable_topk
from temporal_exact import BOUND_EPSILON_FACTOR, REFRESH_FRACTION


METHODS = (
    "numpy_exhaustive", "numpy_temporal", "native_exhaustive",
    "native_temporal", "native_pivot8", "native_pivot32",
)


def _score(kernel, query, query_index, candidates, indices=None, **kwargs):
    function = score_prepared if kernel is None else kernel.score_prepared
    return function(query, query_index, candidates, indices, **kwargs)


def change_bounds(query, query_index, anchors, anchor_indexes, *,
                  compensate_roll=True, kernel=None, return_components=False):
    """Uniform bounds |S(query,c)-S(anchor_j,c)|, in one component-score call.

    The formula is the unchanged temporal_exact.query_change_bound formula.
    Its query-dependent coefficients are directional: the table to which this
    bound applies must contain S(anchor_j, candidate), not the reverse score.
    """
    indexes = np.asarray(anchor_indexes)
    if indexes.ndim != 1 or not np.issubdtype(indexes.dtype, np.integer):
        raise ValueError("anchor_indexes must be a one-dimensional integer array")
    if len(indexes) == 0:
        raise ValueError("At least one anchor is required")
    components = _score(kernel, query, query_index, anchors, indexes,
                        compensate_roll=compensate_roll, return_components=True)
    left, right = query.blinks[query_index]
    wink = float(left - right)
    activity = max(0., min(1., (abs(wink) - .14) / .42))
    anchor_blinks = anchors.blinks[indexes]
    anchor_wink = anchor_blinks[:, 0] - anchor_blinks[:, 1]
    anchor_activity = np.clip((np.abs(anchor_wink) - .14) / .42, 0., 1.)
    wink_change = np.abs(wink - anchor_wink)
    activity_change = np.abs(activity - anchor_activity)
    radius = 1. + np.abs(anchor_wink)
    local_wink = (.42 + .58 * activity) * wink_change + .58 * activity_change * radius
    final_wink = (.12 + .48 * activity) * wink_change + .48 * activity_change * radius
    local = np.maximum.reduce((
        components["mouth"] * 1.15, components["leftEye"] * 1.6,
        components["rightEye"] * 1.6, components["brows"] * 1.2,
        components["mouthDescriptor"] * .48, components["mouthShape"] * .95,
        components["eyeDescriptor"] * .52, components["browDescriptor"] * .4,
        components["blendshape"] * .16, components["blink"] * .42,
        local_wink,
    ))
    shape = components["shapeGate"]
    average = (components["mouth"] + components["eyes"] + components["brows"]) / 3
    pitch = np.abs(components["pitchDegrees"]) / 90
    total = .23 * shape + .54 * local + .08 * average + .15 * pitch + final_wink
    if return_components:
        return {"total": total, "shape": shape, "worstLocal": local,
                "localWink": local_wink, "finalWink": final_wink,
                "average": average, "pitch": pitch, "winkChange": wink_change,
                "winkActivityChange": activity_change}
    return total


def select_pivots(vectors: np.ndarray, count: int) -> np.ndarray:
    """Farthest-first on frozen float32 embedding values promoted to float64.

    The first index is N//2. Distances use NumPy float64 squared differences
    and row sums; np.argmax selects the lowest canonical index on exact ties.
    The first eight choices are consequently a prefix of the first 32 choices.
    Selection stops at the requested count, including its own construction cost.
    """
    values = np.asarray(vectors, dtype=np.float64, order="C")
    if values.ndim != 2 or len(values) < 1 or not np.isfinite(values).all():
        raise ValueError("Pivot vectors must be a nonempty finite matrix")
    if not isinstance(count, (int, np.integer)) or count < 1:
        raise ValueError("Pivot count must be positive")
    count = min(int(count), len(values))
    selected = np.empty(count, dtype=np.int64)
    selected[0] = len(values) // 2
    used = np.zeros(len(values), dtype=bool)
    used[selected[0]] = True
    closest = np.full(len(values), np.inf, dtype=np.float64)
    for offset in range(1, count):
        difference = values - values[selected[offset - 1]]
        np.square(difference, out=difference)
        distance = difference.sum(axis=1)
        if not np.isfinite(distance).all():
            raise FloatingPointError("Nonfinite pivot-selection distance")
        np.minimum(closest, distance, out=closest)
        closest[used] = -np.inf
        selected[offset] = int(np.argmax(closest))
        used[selected[offset]] = True
    selected.setflags(write=False)
    return selected


class _Engine:
    def __init__(self, candidates: PreparedFaces, k=64, *, kernel=None):
        self._started = time.perf_counter()
        if not isinstance(k, (int, np.integer)) or k < 1 or len(candidates) < 1:
            raise ValueError("Positive k and at least one candidate are required")
        self.kernel = kernel
        self.raw_candidates = candidates
        self.k = min(int(k), len(candidates))
        started = time.perf_counter()
        self.candidates = self.prepare_query(candidates)
        self.construction = {
            "backend": "numpy" if kernel is None else "native_scorer_python_controller",
            "candidate_bind_seconds": time.perf_counter() - started,
            "shared_descriptor_payload_bytes": int(candidates.nbytes),
            "controller": "Python; NumPy masks; common strict_metric.stable_topk",
        }
        self.reset()

    def _construction_done(self):
        self.construction["total_seconds"] = time.perf_counter() - self._started
        self.construction["state_payload_bytes"] = self.state_nbytes

    def prepare_query(self, prepared: PreparedFaces):
        return prepared if self.kernel is None else self.kernel.bind(prepared)

    def reset(self):
        self._queries_seen = 0

    @property
    def state_nbytes(self):
        return 0

    def _validate_query(self, query, query_index, compensate_roll):
        if not isinstance(query_index, (int, np.integer)) or not 0 <= query_index < len(query):
            raise IndexError("Invalid query index")
        if not isinstance(compensate_roll, (bool, np.bool_)):
            raise ValueError("compensate_roll must be boolean")
        self._queries_seen += 1
        return bool(compensate_roll)

    def _scores(self, query, query_index, indices=None, *, compensate_roll=True):
        values = _score(self.kernel, query, query_index, self.candidates, indices,
                        compensate_roll=compensate_roll)
        if not np.isfinite(values).all():
            raise FloatingPointError("Nonfinite strict scores cannot be ranked")
        return values

    def _stats(self, *, full_scan, reason, scored, eligible_count,
               seed_count=0, bound_pair_evaluations=0, **extra):
        return {
            "full_scan": bool(full_scan), "reason": reason,
            "queries_seen": self._queries_seen,
            "total_candidates": len(self.candidates),
            "scored": int(scored), "score_evaluations": int(scored),
            "unique_candidates_scored": len(self.candidates) if full_scan else int(eligible_count),
            "eligible_count": int(eligible_count), "seed_count": int(seed_count),
            "bound_pair_evaluations": int(bound_pair_evaluations), **extra,
        }

    def _subset(self, query, query_index, compensate_roll, eligible, seed, seed_scores):
        indexes = np.flatnonzero(eligible)
        eligible[seed] = False
        remaining = np.flatnonzero(eligible)
        scores = np.empty(len(indexes), dtype=np.float64)
        scores[np.searchsorted(indexes, seed)] = seed_scores
        scores[np.searchsorted(indexes, remaining)] = self._scores(
            query, query_index, remaining, compensate_roll=compensate_roll)
        result = stable_topk(scores, self.k, indexes)
        return result, scores[np.searchsorted(indexes, result)], len(seed) + len(remaining)


class Exhaustive(_Engine):
    def __init__(self, candidates, k=64, *, kernel=None):
        super().__init__(candidates, k, kernel=kernel)
        self._construction_done()

    def search(self, query, query_index=0, compensate_roll=True):
        roll = self._validate_query(query, query_index, compensate_roll)
        scores = self._scores(query, query_index, compensate_roll=roll)
        top = stable_topk(scores, self.k)
        return top, scores[top], self._stats(
            full_scan=True, reason="exhaustive", scored=len(scores),
            eligible_count=len(scores), anchor_updated=False)


class Temporal(_Engine):
    def __init__(self, candidates, k=64, *, kernel=None):
        super().__init__(candidates, k, kernel=kernel)
        self._construction_done()

    def reset(self):
        super().reset()
        self._anchor = None
        self._anchor_index = 0
        self._anchor_roll = True
        self._anchor_scores = None
        self._anchor_topk = None
        self._anchor_scale = 1.
        self._anchor_age = 0
        self._generation = 0

    @property
    def state_nbytes(self):
        return (0 if self._anchor_scores is None else self._anchor_scores.nbytes) + (
            0 if self._anchor_topk is None else self._anchor_topk.nbytes)

    def _full(self, query, qi, roll, *, reason, seed_count=0, eligible_count=None,
              bound=None, epsilon=None):
        scores = self._scores(query, qi, compensate_roll=roll)
        top = stable_topk(scores, self.k)
        age = self._anchor_age
        self._anchor, self._anchor_index, self._anchor_roll = query, qi, roll
        self._anchor_scores, self._anchor_topk = scores, top
        scores.setflags(write=False)
        top.setflags(write=False)
        self._anchor_scale = max(1., float(np.max(np.abs(scores))))
        self._anchor_age = 0
        self._generation += 1
        stats = self._stats(
            full_scan=True, reason=reason, scored=len(scores) + seed_count,
            eligible_count=len(scores) if eligible_count is None else eligible_count,
            seed_count=seed_count, bound_pair_evaluations=int(bound is not None),
            anchor_updated=True, anchor_generation=self._generation,
            anchor_age_before=age, anchor_age=0,
            bound=bound if bound is None or np.isfinite(bound) else None,
            epsilon=epsilon,
        )
        return top.copy(), scores[top], stats

    def search(self, query, query_index=0, compensate_roll=True):
        roll = self._validate_query(query, query_index, compensate_roll)
        if self._anchor is None:
            return self._full(query, query_index, roll, reason="initial")
        if roll != self._anchor_roll:
            return self._full(query, query_index, roll, reason="roll_policy_changed")
        if self.k == len(self.candidates):
            return self._full(query, query_index, roll, reason="all_candidates_requested")
        bound = float(change_bounds(query, query_index, self._anchor,
                                    np.array([self._anchor_index], dtype=np.int64),
                                    compensate_roll=roll, kernel=self.kernel)[0])
        if not np.isfinite(bound):
            return self._full(query, query_index, roll, reason="nonfinite_change_bound", bound=bound)
        if bound < 0:
            raise ArithmeticError("A query-change bound cannot be negative")
        seed = self._anchor_topk
        seed_scores = self._scores(query, query_index, seed, compensate_roll=roll)
        upper = float(np.max(seed_scores))
        epsilon = BOUND_EPSILON_FACTOR * max(self._anchor_scale, 1., abs(bound), abs(upper))
        eligible = self._anchor_scores <= upper + bound + epsilon
        eligible[seed] = True
        count = int(np.count_nonzero(eligible))
        if count > REFRESH_FRACTION * len(self.candidates):
            return self._full(query, query_index, roll, reason="candidate_fraction",
                              seed_count=len(seed), eligible_count=count,
                              bound=bound, epsilon=epsilon)
        top, values, scored = self._subset(query, query_index, roll, eligible, seed, seed_scores)
        age = self._anchor_age
        self._anchor_age += 1
        return top, values, self._stats(
            full_scan=False, reason="bounded_subset", scored=scored,
            eligible_count=count, seed_count=len(seed), bound_pair_evaluations=1,
            anchor_updated=False, anchor_generation=self._generation,
            anchor_age_before=age, anchor_age=self._anchor_age,
            bound=bound, epsilon=epsilon,
        )


class FixedPivots(_Engine):
    def __init__(self, candidates, count, k=64, *, kernel):
        super().__init__(candidates, k, kernel=kernel)
        started = time.perf_counter()
        vectors = embedding(candidates)
        self.construction["embedding_seconds"] = time.perf_counter() - started
        self.construction["embedding_dimensions"] = int(vectors.shape[1])
        self.construction["embedding_payload_bytes"] = int(vectors.nbytes)
        started = time.perf_counter()
        self._pivots = select_pivots(vectors, count)
        self.construction["pivot_selection_seconds"] = time.perf_counter() - started
        del vectors
        self._tables, self._top, self._scales, self._kth = {}, {}, {}, {}
        timings = {}
        for roll in (False, True):
            started = time.perf_counter()
            table = np.empty((len(self._pivots), len(self.candidates)), dtype=np.float64)
            top = np.empty((len(self._pivots), self.k), dtype=np.int64)
            for row, pivot in enumerate(self._pivots):
                table[row] = self._scores(self.candidates, int(pivot), compensate_roll=roll)
                top[row] = stable_topk(table[row], self.k)
            scale = np.maximum(1., np.max(np.abs(table), axis=1))
            kth = table[np.arange(len(self._pivots)), top[:, -1]].copy()
            for array in (table, top, scale, kth):
                array.setflags(write=False)
            self._tables[roll], self._top[roll] = table, top
            self._scales[roll], self._kth[roll] = scale, kth
            timings[str(roll).lower()] = time.perf_counter() - started
        self.construction.update({
            "requested_pivots": int(count), "pivot_count": len(self._pivots),
            "pivot_indexes": self._pivots.tolist(), "selection_initial_index": len(candidates) // 2,
            "selection": "farthest-first; float32 v1 embedding promoted to float64; squared row-sum L2; lowest-index ties",
            "selection_stops_at_requested_count": True,
            "score_table_seconds_by_roll": timings,
            "score_table_seconds": sum(timings.values()),
            "score_table_payload_bytes": sum(x.nbytes for x in self._tables.values()),
            "precomputed_score_evaluations": 2 * len(self._pivots) * len(candidates),
            "score_orientation": "S(pivot, candidate)",
            "roll_policies": [False, True],
            "seed_rule": "argmin(anchor_kth_score + query_change_bound), then current-query strict rerank of that pivot's stored top-k",
        })
        self._construction_done()

    @property
    def state_nbytes(self):
        if not hasattr(self, "_tables"):
            return 0
        return self._pivots.nbytes + sum(
            array.nbytes for collection in (self._tables, self._top, self._scales, self._kth)
            for array in collection.values())

    def _full(self, query, qi, roll, *, reason, seed_count=0, eligible_count=None,
              bound_count=0, seed_pivot_position=None):
        scores = self._scores(query, qi, compensate_roll=roll)
        top = stable_topk(scores, self.k)
        return top, scores[top], self._stats(
            full_scan=True, reason=reason, scored=len(scores) + seed_count,
            eligible_count=len(scores) if eligible_count is None else eligible_count,
            seed_count=seed_count, bound_pair_evaluations=bound_count,
            anchor_updated=False, pivot_count=len(self._pivots),
            seed_pivot_position=seed_pivot_position,
        )

    def search(self, query, query_index=0, compensate_roll=True):
        roll = self._validate_query(query, query_index, compensate_roll)
        if self.k == len(self.candidates):
            return self._full(query, query_index, roll, reason="all_candidates_requested")
        bounds = change_bounds(query, query_index, self.candidates, self._pivots,
                               compensate_roll=roll, kernel=self.kernel)
        if not np.isfinite(bounds).all():
            return self._full(query, query_index, roll, reason="nonfinite_change_bound",
                              bound_count=len(self._pivots))
        if (bounds < 0).any():
            raise ArithmeticError("A query-change bound cannot be negative")
        pivot_position = int(np.argmin(self._kth[roll] + bounds))
        seed = self._top[roll][pivot_position]
        seed_scores = self._scores(query, query_index, seed, compensate_roll=roll)
        upper = float(np.max(seed_scores))
        scales = np.maximum(self._scales[roll], np.maximum(np.abs(bounds), abs(upper)))
        epsilons = BOUND_EPSILON_FACTOR * scales
        eligible = np.ones(len(self.candidates), dtype=bool)
        for row in range(len(self._pivots)):
            eligible &= self._tables[roll][row] <= upper + bounds[row] + epsilons[row]
        eligible[seed] = True
        count = int(np.count_nonzero(eligible))
        if count > REFRESH_FRACTION * len(self.candidates):
            return self._full(query, query_index, roll, reason="candidate_fraction",
                              seed_count=len(seed), eligible_count=count,
                              bound_count=len(self._pivots), seed_pivot_position=pivot_position)
        top, values, scored = self._subset(query, query_index, roll, eligible, seed, seed_scores)
        return top, values, self._stats(
            full_scan=False, reason="bounded_subset", scored=scored,
            eligible_count=count, seed_count=len(seed), bound_pair_evaluations=len(self._pivots),
            anchor_updated=False, pivot_count=len(self._pivots), seed_pivot_position=pivot_position,
        )


def create_engine(method, candidates, k=64, kernel=None):
    if method not in METHODS:
        raise ValueError("Unknown fixed V2 method: " + str(method))
    use_native = method.startswith("native_")
    if use_native and kernel is None:
        raise ValueError("A NativeKernel is required for native methods")
    backend = kernel if use_native else None
    if method.endswith("exhaustive"):
        result = Exhaustive(candidates, k, kernel=backend)
    elif method.endswith("temporal"):
        result = Temporal(candidates, k, kernel=backend)
    else:
        result = FixedPivots(candidates, 8 if method.endswith("pivot8") else 32,
                             k, kernel=backend)
    result.method = method
    return result
