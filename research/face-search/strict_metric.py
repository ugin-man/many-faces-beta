"""Vectorized implementation of Many Faces' fixed ``strictTotal`` score.

The specification is ``app/projection-matching.ts`` at the source revision
recorded by the experiment.  This module is an evaluation oracle and common
reranker, not a newly proposed similarity measure.  In particular, the
query-dependent wink coefficient makes the complete score asymmetric; callers
must not assume a metric or use its triangle inequality for pruning.

Inputs use the application's 55 features and 468 normalized 2-D landmarks.
All arithmetic here is float64. NumPy reductions and hypot can differ from
JavaScript by a few rounding bits; ``verify_strict_metric.py`` checks the port
against the unchanged JavaScript implementation and records the error. Stable
candidate-ID tie breaking is an evaluation convention, rather than an assertion
that the application's candidate-admission order is unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import numpy as np


FACE_OVAL = (
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
)
LEFT_EYE = (33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246)
RIGHT_EYE = (362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398)
OUTER_LIPS = (61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78)
INNER_LIPS = (78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95)
MOUTH = tuple(dict.fromkeys((*OUTER_LIPS, *INNER_LIPS)))
NOSE = (168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 97, 99, 126, 327, 326, 328, 355)
BROWS = (46, 53, 52, 65, 55, 70, 63, 105, 66, 107, 276, 283, 282, 295, 285, 300, 293, 334, 296, 336)
GROUP_INDEXES: Mapping[str, tuple[int, ...]] = {
    "contour": FACE_OVAL, "mouth": MOUTH, "left_eye": LEFT_EYE,
    "right_eye": RIGHT_EYE, "brows": BROWS, "nose": NOSE,
}

FACE_ACTION_KEYS = (
    "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker", "mouthSmileLeft",
    "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight", "mouthStretchLeft",
    "mouthStretchRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft",
    "eyeSquintRight", "browInnerUp", "browDownLeft", "browDownRight",
    "browOuterUpLeft", "browOuterUpRight", "cheekPuff", "cheekSquintLeft",
    "cheekSquintRight", "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft",
    "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft",
    "eyeLookUpRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft",
    "jawRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft",
    "mouthPressRight", "mouthRight", "mouthRollLower", "mouthRollUpper",
    "mouthShrugLower", "mouthShrugUpper", "mouthUpperUpLeft",
    "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight", "_neutral",
)
FEATURE_INDEX = {key: i + 3 for i, key in enumerate(FACE_ACTION_KEYS)}
EXPRESSION_WEIGHTS = np.array([2.6, 1.8, 0.7, 2.4, 1.5, 1.5, 0.7, 0.7], dtype=np.float64)
MOUTH_SHAPE_WEIGHTS = np.array([2.2, 2.8, 4.2, 1.8, 4.4, 1.5, 2.2, 2.2], dtype=np.float64)
MOUTH_ACTION_WEIGHTS = {
    "jawOpen": 3.2, "mouthClose": 1.1, "mouthFunnel": 4.6, "mouthPucker": 4.8,
    "mouthSmileLeft": 1.3, "mouthSmileRight": 1.3, "mouthFrownLeft": 1.,
    "mouthFrownRight": 1., "mouthStretchLeft": 3.2, "mouthStretchRight": 3.2,
    "mouthDimpleLeft": 1.1, "mouthDimpleRight": 1.1, "mouthLeft": .8,
    "mouthRight": .8, "mouthLowerDownLeft": 1.5, "mouthLowerDownRight": 1.5,
    "mouthPressLeft": .8, "mouthPressRight": .8, "mouthRollLower": 1.2,
    "mouthRollUpper": 1.2, "mouthShrugLower": 1., "mouthShrugUpper": 1.,
    "mouthUpperUpLeft": 1.5, "mouthUpperUpRight": 1.5,
}
_IMPORTANT_BLEND_WEIGHTS = {
    "jawOpen": 2.8, "mouthClose": .5, "mouthFunnel": .9, "mouthPucker": 1.,
    "mouthSmileLeft": 3.1, "mouthSmileRight": 3.1, "mouthFrownLeft": 1.4,
    "mouthFrownRight": 1.4, "mouthStretchLeft": .8, "mouthStretchRight": .8,
    "eyeBlinkLeft": 2.7, "eyeBlinkRight": 2.7, "eyeSquintLeft": 1.1,
    "eyeSquintRight": 1.1, "eyeWideLeft": 2.2, "eyeWideRight": 2.2,
    "eyeLookUpLeft": 1.35, "eyeLookUpRight": 1.35, "eyeLookDownLeft": 1.35,
    "eyeLookDownRight": 1.35, "browInnerUp": 1.35, "browDownLeft": 1.,
    "browDownRight": 1., "browOuterUpLeft": 1., "browOuterUpRight": 1.,
    "noseSneerLeft": .85, "noseSneerRight": .85,
}
BLEND_ACTION_INDEXES = np.array([FEATURE_INDEX[k] for k in FACE_ACTION_KEYS if k != "_neutral"], dtype=np.intp)
BLEND_ACTION_WEIGHTS = np.array([_IMPORTANT_BLEND_WEIGHTS.get(k, .35) for k in FACE_ACTION_KEYS if k != "_neutral"], dtype=np.float64)
MOUTH_ACTION_INDEXES = np.array([FEATURE_INDEX[k] for k in MOUTH_ACTION_WEIGHTS], dtype=np.intp)
MOUTH_ACTION_WEIGHT_ARRAY = np.array(list(MOUTH_ACTION_WEIGHTS.values()), dtype=np.float64)


@dataclass(frozen=True)
class PreparedFaces:
    features: np.ndarray
    groups: Mapping[str, np.ndarray]
    expression: np.ndarray
    mouth_shape: np.ndarray
    blinks: np.ndarray

    def __len__(self) -> int:
        return self.features.shape[0]

    @property
    def nbytes(self) -> int:
        """Stored array payload only; not process RSS or Python allocator use."""
        return sum(x.nbytes for x in (self.features, *self.groups.values(), self.expression, self.mouth_shape, self.blinks))


def _readonly(array: np.ndarray) -> np.ndarray:
    result = np.ascontiguousarray(array, dtype=np.float64)
    result.setflags(write=False)
    return result


def prepare(features: np.ndarray, projections: np.ndarray) -> PreparedFaces:
    """Prepare immutable candidate/query descriptors without changing the score.

    Only the production 55-feature / 936-projection contract is accepted. Values
    must be finite; shorter legacy arrays are deliberately not silently padded.
    Full projection arrays are not retained after the required groups and ratio
    descriptors are prepared, limiting memory during exhaustive evaluation.
    """
    feature = np.array(features, dtype=np.float64, order="C", copy=True)
    points = np.asarray(projections, dtype=np.float64)
    if feature.ndim != 2 or feature.shape[1] != 55:
        raise ValueError("features must have shape (N, 55)")
    if points.shape != (len(feature), 936):
        raise ValueError("projections must have shape (N, 936)")
    if not np.isfinite(feature).all() or not np.isfinite(points).all():
        raise ValueError("Only finite production feature/projection values are supported")
    points = points.reshape(-1, 468, 2)
    groups = {key: _readonly(points[:, indexes, :].reshape(len(feature), 2 * len(indexes)))
              for key, indexes in GROUP_INDEXES.items()}

    def distance(left: int, right: int) -> np.ndarray:
        delta = points[:, left, :] - points[:, right, :]
        return np.hypot(delta[:, 0], delta[:, 1])

    mouth_width = np.maximum(.05, distance(61, 291))
    left_eye_width = np.maximum(.05, distance(33, 133))
    right_eye_width = np.maximum(.05, distance(362, 263))
    center_y = (points[:, 13, 1] + points[:, 14, 1]) / 2
    corner_y = (points[:, 61, 1] + points[:, 291, 1]) / 2
    expression = np.column_stack((
        distance(13, 14) / mouth_width, distance(82, 87) / mouth_width,
        mouth_width, (center_y - corner_y) / mouth_width,
        distance(159, 145) / left_eye_width, distance(386, 374) / right_eye_width,
        distance(105, 159) / left_eye_width, distance(334, 386) / right_eye_width,
    ))
    outer_width = np.maximum(.04, distance(61, 291))
    inner_width = np.maximum(.025, distance(78, 308))
    inner_height = distance(13, 14)
    mouth_shape = np.column_stack((
        outer_width, distance(0, 17) / outer_width, inner_height / outer_width,
        inner_width / outer_width, inner_height / inner_width,
        (center_y - corner_y) / outer_width,
        distance(82, 87) / outer_width, distance(312, 317) / outer_width,
    ))
    blinks = np.clip(feature[:, [FEATURE_INDEX["eyeBlinkLeft"], FEATURE_INDEX["eyeBlinkRight"]]], 0, 1)
    return PreparedFaces(_readonly(feature), groups, _readonly(expression), _readonly(mouth_shape), _readonly(blinks))


def _weighted_rms(query: np.ndarray, candidates: np.ndarray, weights: np.ndarray) -> np.ndarray:
    difference = candidates - query
    np.square(difference, out=difference)
    difference *= weights
    # float64 reduction is permitted to differ from the scalar JS accumulation
    # within the tolerance established by the independent equivalence check.
    return np.sqrt(difference.sum(axis=1) / sum(float(w) for w in weights))


def score_prepared(
    query: PreparedFaces,
    query_index: int,
    candidates: PreparedFaces,
    indices: np.ndarray | None = None,
    *,
    compensate_roll: bool = True,
    return_components: bool = False,
) -> np.ndarray | dict[str, np.ndarray]:
    """Score all candidates, or exactly the supplied indices, for one query.

    ``query`` may be a prepared batch. Returned rows follow ``indices`` order;
    no candidate is added, omitted, sampled, or selected inside this function.
    Descriptor preparation can consequently be shared across all methods.
    """
    if not isinstance(query_index, (int, np.integer)) or not 0 <= query_index < len(query):
        raise IndexError("Invalid query index")
    if indices is not None:
        indices = np.asarray(indices)
        if indices.ndim != 1 or not np.issubdtype(indices.dtype, np.integer):
            raise ValueError("indices must be a one-dimensional integer array")
        if len(indices) and (indices.min() < 0 or indices.max() >= len(candidates)):
            raise IndexError("Candidate index out of bounds")
    use = slice(None) if indices is None else indices
    f = candidates.features[use]
    qf = query.features[query_index]
    rms: dict[str, np.ndarray] = {}
    for key, count in ((key, len(indexes)) for key, indexes in GROUP_INDEXES.items()):
        difference = candidates.groups[key][use] - query.groups[key][query_index]
        np.square(difference, out=difference)
        rms[key] = np.sqrt(difference.sum(axis=1) / count)
    contour, mouth = rms["contour"], rms["mouth"]
    left_eye, right_eye = rms["left_eye"], rms["right_eye"]
    eyes, brows, nose = np.maximum(left_eye, right_eye), rms["brows"], rms["nose"]
    qe, ce = query.expression[query_index], candidates.expression[use]
    mouth_descriptor = _weighted_rms(qe[:4], ce[:, :4], EXPRESSION_WEIGHTS[:4])
    eye_descriptor = _weighted_rms(qe[4:6], ce[:, 4:6], np.array([1.5, 1.5]))
    brow_descriptor = _weighted_rms(qe[6:8], ce[:, 6:8], np.array([1., 1.]))
    mouth_action = _weighted_rms(qf[MOUTH_ACTION_INDEXES], f[:, MOUTH_ACTION_INDEXES], MOUTH_ACTION_WEIGHT_ARRAY)
    mouth_geometry = _weighted_rms(query.mouth_shape[query_index], candidates.mouth_shape[use], MOUTH_SHAPE_WEIGHTS)
    mouth_shape = mouth_geometry * .62 + mouth_action * .38
    blendshape = _weighted_rms(qf[BLEND_ACTION_INDEXES], f[:, BLEND_ACTION_INDEXES], BLEND_ACTION_WEIGHTS)

    qb, cb = query.blinks[query_index], candidates.blinks[use]
    blink = np.maximum(np.abs(qb[0] - cb[:, 0]), np.abs(qb[1] - cb[:, 1]))
    target_wink = qb[0] - qb[1]
    wink = np.abs(target_wink - (cb[:, 0] - cb[:, 1]))
    wink_activity = max(0., min(1., (abs(target_wink) - .14) / .42))
    yaw, pitch, roll = ((qf[i] - f[:, i]) * 90 for i in range(3))
    # Match the source's degrees -> hypot -> /90 sequence rather than canceling
    # the factor algebraically, so the floating-point disagreement stays small.
    pose_degrees = np.hypot(np.hypot(yaw, pitch), 0 if compensate_roll else roll * .35)
    pose_unit, pitch_unit = pose_degrees / 90, np.abs(pitch) / 90
    shape_gate = contour * .62 + nose * .2 + pose_unit * .08 + pitch_unit * .1
    worst_local = np.maximum.reduce((
        mouth * 1.15, left_eye * 1.6, right_eye * 1.6, brows * 1.2,
        mouth_descriptor * .48, mouth_shape * .95, eye_descriptor * .52,
        brow_descriptor * .4, blendshape * .16, blink * .42,
        wink * (.42 + wink_activity * .58),
    ))
    strict_total = shape_gate * .23 + worst_local * .54 + (mouth + eyes + brows) / 3 * .08 + pitch_unit * .15 + wink * (.12 + wink_activity * .48)
    if not return_components:
        return strict_total
    return {
        "strictTotal": strict_total, "total": strict_total, "contour": contour,
        "mouth": mouth, "leftEye": left_eye, "rightEye": right_eye, "eyes": eyes,
        "brows": brows, "nose": nose, "mouthDescriptor": mouth_descriptor,
        "mouthAction": mouth_action, "mouthShape": mouth_shape,
        "eyeDescriptor": eye_descriptor, "browDescriptor": brow_descriptor,
        "blendshape": blendshape, "wink": wink, "blink": blink,
        "shapeGate": shape_gate, "worstLocal": worst_local,
        "poseDegrees": pose_degrees, "yawDegrees": yaw,
        "pitchDegrees": pitch, "rollDegrees": roll,
    }


def strict_scores(
    query_feature: np.ndarray,
    query_projection: np.ndarray,
    candidates: PreparedFaces,
    indices: np.ndarray | None = None,
    *,
    compensate_roll: bool = True,
    return_components: bool = False,
) -> np.ndarray | dict[str, np.ndarray]:
    """Convenience API that also prepares the supplied single query."""
    query = prepare(np.asarray(query_feature)[None, :], np.asarray(query_projection)[None, :])
    return score_prepared(query, 0, candidates, indices, compensate_roll=compensate_roll, return_components=return_components)


def stable_topk(scores: np.ndarray, k: int, indices: np.ndarray | None = None) -> np.ndarray:
    """Return exact top-k candidate indexes, resolving boundary ties by index.

    Canonical candidate-ID order must be established before scoring. For a
    reranked subset, pass its global candidate indexes as ``indices``.
    """
    values = np.asarray(scores)
    if values.ndim != 1 or not np.isfinite(values).all():
        raise ValueError("scores must be a finite one-dimensional array")
    if not isinstance(k, (int, np.integer)) or k < 0:
        raise ValueError("k must be a nonnegative integer")
    ids = np.arange(len(values), dtype=np.int64) if indices is None else np.asarray(indices)
    if ids.shape != values.shape or not np.issubdtype(ids.dtype, np.integer):
        raise ValueError("indices must be integer indexes matching scores")
    if k == 0 or len(values) == 0:
        return np.empty(0, dtype=ids.dtype)
    count = min(k, len(values))
    if count == len(values):
        pool = np.arange(len(values))
    else:
        threshold = np.partition(values, count - 1)[count - 1]
        pool = np.flatnonzero(values <= threshold)
    order = np.lexsort((ids[pool], values[pool]))[:count]
    return ids[pool[order]]
