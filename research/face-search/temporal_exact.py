"""Causal anchor-score reuse with a conservative query-change bound.

All retained candidates are rescored with the unchanged ``strictTotal``. The
mathematical pruning argument is in PROOF.md. It applies in real arithmetic;
the implementation adds a scale-dependent float64 margin and is checked against
exhaustive scoring. No claim of a novel nearest-neighbor theorem is made.
"""

from __future__ import annotations

import math

import numpy as np

from strict_metric import PreparedFaces, score_prepared, stable_topk


REFRESH_FRACTION = .60
BOUND_EPSILON_FACTOR = 1e-10


def _wink_values(faces: PreparedFaces, index: int) -> tuple[float, float]:
    left, right = faces.blinks[index]
    wink = float(left - right)
    activity = max(0., min(1., (abs(wink) - .14) / .42))
    return wink, activity


def query_change_bound(
    current: PreparedFaces,
    current_index: int,
    anchor: PreparedFaces,
    anchor_index: int,
    *,
    compensate_roll: bool = True,
    return_components: bool = False,
) -> float | dict[str, float]:
    """Bound |S(current,c)-S(anchor,c)| uniformly over all candidates c.

    Both scores must use the same compensate_roll policy. All terms except
    query-weighted wink distances follow the reverse triangle inequality on
    the corresponding mapped descriptors. The wink terms use their separate
    coefficient-change bound; strictTotal itself is not assumed to be a metric.
    """
    components = score_prepared(current, current_index, anchor,
                                np.array([anchor_index], dtype=np.intp),
                                compensate_roll=compensate_roll,
                                return_components=True)
    c = {key: float(value[0]) for key, value in components.items()}
    wink, activity = _wink_values(current, current_index)
    anchor_wink, anchor_activity = _wink_values(anchor, anchor_index)
    wink_change = abs(wink - anchor_wink)
    activity_change = abs(activity - anchor_activity)
    # Every clipped candidate wink is in [-1,1], hence
    # |anchor_wink - candidate_wink| <= 1 + |anchor_wink|.
    candidate_wink_radius = 1 + abs(anchor_wink)
    local_wink_bound = (.42 + .58 * activity) * wink_change + .58 * activity_change * candidate_wink_radius
    final_wink_bound = (.12 + .48 * activity) * wink_change + .48 * activity_change * candidate_wink_radius
    local_bound = max(
        c['mouth'] * 1.15,
        c['leftEye'] * 1.6,
        c['rightEye'] * 1.6,
        c['brows'] * 1.2,
        c['mouthDescriptor'] * .48,
        c['mouthShape'] * .95,
        c['eyeDescriptor'] * .52,
        c['browDescriptor'] * .4,
        c['blendshape'] * .16,
        c['blink'] * .42,
        local_wink_bound,
    )
    shape_bound = c['shapeGate']
    average_bound = (c['mouth'] + c['eyes'] + c['brows']) / 3
    pitch_bound = abs(c['pitchDegrees']) / 90
    total = .23 * shape_bound + .54 * local_bound + .08 * average_bound + .15 * pitch_bound + final_wink_bound
    if return_components:
        return {
            'total': total, 'shape': shape_bound, 'worstLocal': local_bound,
            'localWink': local_wink_bound, 'finalWink': final_wink_bound,
            'average': average_bound, 'pitch': pitch_bound,
            'winkChange': wink_change, 'winkActivityChange': activity_change,
        }
    return total


class TemporalExact:
    """Stateful search with one past fully scored anchor and no future access.

    Call reset() at every order/pass/clip boundary. Prepared candidate and query
    descriptors may be shared by all evaluated methods; temporal state is not.
    The fixed refresh threshold is 60% of the database, chosen before timing.
    ``search`` returns (global_indices, corresponding_scores, diagnostic_stats).
    """

    def __init__(self, candidates: PreparedFaces, k: int = 64):
        if not isinstance(k, (int, np.integer)) or k < 1:
            raise ValueError('k must be a positive integer')
        if len(candidates) < 1:
            raise ValueError('At least one candidate is required')
        self.candidates = candidates
        self.k = min(int(k), len(candidates))
        self.reset()

    def reset(self) -> None:
        self._anchor: PreparedFaces | None = None
        self._anchor_index = 0
        self._anchor_roll = True
        self._anchor_scores: np.ndarray | None = None
        self._anchor_topk: np.ndarray | None = None
        self._anchor_score_scale = 1.
        self._anchor_age = 0
        self._queries_seen = 0
        self._generation = 0

    @property
    def state_nbytes(self) -> int:
        """Anchor score/index payload only; shared descriptor arrays excluded."""
        return (0 if self._anchor_scores is None else self._anchor_scores.nbytes) + (0 if self._anchor_topk is None else self._anchor_topk.nbytes)

    def _full_scan(
        self,
        query: PreparedFaces,
        query_index: int,
        compensate_roll: bool,
        *,
        reason: str,
        seed_evaluations: int = 0,
        eligible_count: int | None = None,
        bound: float | None = None,
        epsilon: float | None = None,
    ) -> tuple[np.ndarray, np.ndarray, dict]:
        scores = score_prepared(query, query_index, self.candidates, compensate_roll=compensate_roll)
        if not np.isfinite(scores).all():
            raise FloatingPointError('Non-finite strict scores cannot be safely ranked')
        top = stable_topk(scores, self.k)
        age_before = self._anchor_age
        self._anchor = query
        self._anchor_index = query_index
        self._anchor_roll = compensate_roll
        self._anchor_scores = scores
        self._anchor_scores.setflags(write=False)
        self._anchor_topk = top
        self._anchor_topk.setflags(write=False)
        self._anchor_score_scale = max(1., float(np.max(np.abs(scores))))
        self._anchor_age = 0
        self._generation += 1
        n = len(self.candidates)
        stats = {
            'full_scan': True, 'anchor_updated': True, 'reason': reason,
            'anchor_generation': self._generation, 'anchor_age_before': age_before,
            'anchor_age': 0, 'queries_seen': self._queries_seen,
            'total_candidates': n, 'seed_count': seed_evaluations,
            'eligible_count': n if eligible_count is None else eligible_count,
            'unique_candidates_scored': n,
            'score_evaluations': n + seed_evaluations,
            'scored': n + seed_evaluations,
            'bound_pair_evaluations': int(bound is not None),
            'bound': bound if bound is None or math.isfinite(bound) else None,
            'epsilon': epsilon,
        }
        # Copy returned indexes: changing a caller's result cannot mutate state.
        return top.copy(), scores[top], stats

    def search(
        self,
        query: PreparedFaces,
        query_index: int = 0,
        compensate_roll: bool = True,
    ) -> tuple[np.ndarray, np.ndarray, dict]:
        if not isinstance(query_index, (int, np.integer)) or not 0 <= query_index < len(query):
            raise IndexError('Invalid query index')
        if not isinstance(compensate_roll, (bool, np.bool_)):
            raise ValueError('compensate_roll must be boolean')
        compensate_roll = bool(compensate_roll)
        self._queries_seen += 1
        if self._anchor is None:
            return self._full_scan(query, query_index, compensate_roll, reason='initial')
        if compensate_roll != self._anchor_roll:
            return self._full_scan(query, query_index, compensate_roll, reason='roll_policy_changed')
        if self.k == len(self.candidates):
            return self._full_scan(query, query_index, compensate_roll, reason='all_candidates_requested')

        bound = float(query_change_bound(query, query_index, self._anchor, self._anchor_index,
                                        compensate_roll=compensate_roll))
        if not math.isfinite(bound):
            return self._full_scan(query, query_index, compensate_roll,
                                   reason='nonfinite_change_bound', bound=bound)
        if bound < 0:
            raise ArithmeticError('A query-change bound cannot be negative')
        seed = self._anchor_topk
        seed_scores = score_prepared(query, query_index, self.candidates, seed, compensate_roll=compensate_roll)
        if not np.isfinite(seed_scores).all():
            raise FloatingPointError('Non-finite seed scores cannot supply a valid upper bound')
        # This is an upper bound on the current global kth score because these
        # are k distinct database candidates, regardless of their present rank.
        upper = float(np.max(seed_scores))
        epsilon = BOUND_EPSILON_FACTOR * max(self._anchor_score_scale, 1., abs(bound), abs(upper))
        # Written as addition to avoid subtracting a large nearly equal bound
        # from every anchor score. Equality is retained for canonical-ID ties.
        eligible = self._anchor_scores <= upper + bound + epsilon
        eligible[seed] = True
        eligible_count = int(np.count_nonzero(eligible))
        if eligible_count > REFRESH_FRACTION * len(self.candidates):
            return self._full_scan(query, query_index, compensate_roll,
                                   reason='candidate_fraction', seed_evaluations=len(seed),
                                   eligible_count=eligible_count, bound=bound, epsilon=epsilon)

        indexes = np.flatnonzero(eligible)
        eligible[seed] = False
        remaining = np.flatnonzero(eligible)
        remaining_scores = score_prepared(query, query_index, self.candidates, remaining,
                                          compensate_roll=compensate_roll)
        if not np.isfinite(remaining_scores).all():
            raise FloatingPointError('Non-finite candidate scores cannot be safely ranked')
        scores = np.empty(len(indexes), dtype=np.float64)
        scores[np.searchsorted(indexes, seed)] = seed_scores
        scores[np.searchsorted(indexes, remaining)] = remaining_scores
        top = stable_topk(scores, self.k, indexes)
        top_scores = scores[np.searchsorted(indexes, top)]
        age_before = self._anchor_age
        self._anchor_age += 1
        stats = {
            'full_scan': False, 'anchor_updated': False, 'reason': 'bounded_subset',
            'anchor_generation': self._generation, 'anchor_age_before': age_before,
            'anchor_age': self._anchor_age, 'queries_seen': self._queries_seen,
            'total_candidates': len(self.candidates), 'seed_count': len(seed),
            'eligible_count': eligible_count,
            'unique_candidates_scored': eligible_count,
            'score_evaluations': len(seed) + len(remaining),
            'scored': len(seed) + len(remaining),
            'bound_pair_evaluations': 1,
            'bound': bound, 'epsilon': epsilon,
        }
        return top, top_scores, stats
