#!/usr/bin/env python3
"""Avoid recomputing overlapping landmark deltas in full projection scoring.

Every RMS term still sums the exact same squared distances in the exact same
index order.  A single Float64 scratch array is reused candidate-by-candidate,
so the optimization is deterministic and does not create a large temporary
array for every candidate.
"""

from pathlib import Path

PATH = Path("app/projection-matching.ts")
text = PATH.read_text(encoding="utf-8")

if "PROJECTION_ERROR_INDEXES" in text:
    print("Projection distance scratch optimization already applied.")
    raise SystemExit(0)

indexes_marker = '''const EXPRESSION_INDEXES = [...new Set([
  ...MOUTH_INDEXES, ...EYE_INDEXES, ...BROWS,
])] as number[];
'''
indexes_replacement = indexes_marker + '''
const PROJECTION_ERROR_INDEXES = [...new Set([
  ...FACE_OVAL,
  ...FEATURE_INDEXES,
  ...MOUTH_INDEXES,
  ...LEFT_EYE,
  ...RIGHT_EYE,
  ...BROWS,
  ...NOSE,
  ...COARSE_INDEXES,
])].sort((left, right) => left - right) as number[];

const PROJECTION_DISTANCE_SCRATCH_LENGTH =
  Math.max(...PROJECTION_ERROR_INDEXES) + 1;
'''
if indexes_marker not in text:
    raise SystemExit("Expression index marker not found")
text = text.replace(indexes_marker, indexes_replacement, 1)

rms_marker = '''function rmsAtIndexes(left: NumericVector, right: NumericVector, indexes: readonly number[]) {
  if (!indexes.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  let count = 0;
  for (const index of indexes) {
    if (index * 2 + 1 >= left.length || index * 2 + 1 >= right.length) continue;
    total += pointDistanceSquared(left, right, index);
    count += 1;
  }
  return count ? Math.sqrt(total / count) : Number.POSITIVE_INFINITY;
}
'''
rms_replacement = rms_marker + '''
function fillProjectionDistanceScratch(
  left: NumericVector,
  right: NumericVector,
  scratch: Float64Array,
) {
  for (const index of PROJECTION_ERROR_INDEXES) {
    scratch[index] = index * 2 + 1 < left.length && index * 2 + 1 < right.length
      ? pointDistanceSquared(left, right, index)
      : Number.NaN;
  }
}

function rmsAtIndexesFromScratch(
  scratch: Float64Array,
  indexes: readonly number[],
) {
  if (!indexes.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  let count = 0;
  for (const index of indexes) {
    const distance = scratch[index];
    if (!Number.isFinite(distance)) continue;
    total += distance;
    count += 1;
  }
  return count ? Math.sqrt(total / count) : Number.POSITIVE_INFINITY;
}
'''
if rms_marker not in text:
    raise SystemExit("rmsAtIndexes marker not found")
text = text.replace(rms_marker, rms_replacement, 1)

signature = '''export function projectionError(
  frame: SequenceFrame,
  candidate: ProjectionCandidate,
): ProjectionError {
  const left = frame.geometry.projection;
  const right = candidate.geometry.projection;
  const contour = rmsAtIndexes(left, right, FACE_OVAL);
  const balancedFeatures = rmsAtIndexes(left, right, FEATURE_INDEXES);
  const mouth = rmsAtIndexes(left, right, MOUTH_INDEXES);
  const leftEye = rmsAtIndexes(left, right, LEFT_EYE);
  const rightEye = rmsAtIndexes(left, right, RIGHT_EYE);
'''
replacement = '''export function projectionError(
  frame: SequenceFrame,
  candidate: ProjectionCandidate,
  distanceScratch?: Float64Array,
): ProjectionError {
  const left = frame.geometry.projection;
  const right = candidate.geometry.projection;
  const scratch = distanceScratch ?? new Float64Array(
    PROJECTION_DISTANCE_SCRATCH_LENGTH,
  );
  fillProjectionDistanceScratch(left, right, scratch);
  const contour = rmsAtIndexesFromScratch(scratch, FACE_OVAL);
  const balancedFeatures = rmsAtIndexesFromScratch(scratch, FEATURE_INDEXES);
  const mouth = rmsAtIndexesFromScratch(scratch, MOUTH_INDEXES);
  const leftEye = rmsAtIndexesFromScratch(scratch, LEFT_EYE);
  const rightEye = rmsAtIndexesFromScratch(scratch, RIGHT_EYE);
'''
if signature not in text:
    raise SystemExit("projectionError signature marker not found")
text = text.replace(signature, replacement, 1)

for before, after, label in (
    (
        '  const brows = rmsAtIndexes(left, right, BROWS);\n',
        '  const brows = rmsAtIndexesFromScratch(scratch, BROWS);\n',
        "brows",
    ),
    (
        '  const nose = rmsAtIndexes(left, right, NOSE);\n',
        '  const nose = rmsAtIndexesFromScratch(scratch, NOSE);\n',
        "nose",
    ),
    (
        '  const surface = rmsAtIndexes(left, right, COARSE_INDEXES);\n',
        '  const surface = rmsAtIndexesFromScratch(scratch, COARSE_INDEXES);\n',
        "surface",
    ),
):
    if before not in text:
        raise SystemExit(f"projectionError {label} marker not found")
    text = text.replace(before, after, 1)

measured_marker = '''  const measured = candidates.map((candidate) => ({
    candidate,
    error: projectionError(frame, candidate),
  }));
'''
measured_replacement = '''  const distanceScratch = new Float64Array(
    PROJECTION_DISTANCE_SCRATCH_LENGTH,
  );
  const measured = candidates.map((candidate) => ({
    candidate,
    error: projectionError(frame, candidate, distanceScratch),
  }));
'''
if measured_marker not in text:
    raise SystemExit("rankProjectionCandidateModes measured marker not found")
text = text.replace(measured_marker, measured_replacement, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied exact reusable projection distance scratch optimization.")
