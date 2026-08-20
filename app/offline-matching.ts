export type MeshPoint = { x: number; y: number; z?: number };
export type NumericVector = number[] | Float32Array;

export type FaceGeometry = {
  /** Expression-stable face proportions used only to discourage identity jumps. */
  structure: NumericVector;
  /** Canonical 3D Face Mesh surface used for the actual frame-to-image match. */
  surface: NumericVector;
  /** All 468 landmarks projected into an eye-aligned 2D coordinate system. */
  projection: NumericVector;
  layout: [centerX: number, centerY: number, width: number, height: number];
};

export type SequenceFrame = {
  time: number;
  feature: number[];
  geometry: FaceGeometry;
};

export type SequenceCandidate = {
  id: string;
  feature: number[];
  geometry: FaceGeometry;
};

export type SequenceChoice<T extends SequenceCandidate> = {
  frame: SequenceFrame;
  candidate: T;
  emission: number;
};

export type SequenceOptions = {
  coherence?: number;
  beamWidth?: number;
};

const REQUIRED_LANDMARK = 454;
const FACE_POINT_LIMIT = 468;
export const STABLE_LANDMARKS = [
  // Face oval, eye sockets, and nose. Mouth and brows are deliberately omitted:
  // they should move with expression instead of being treated as identity changes.
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 1, 19, 94,
  98, 327, 129, 358,
] as const;

// A compact but expression-sensitive subset of the 468 point mesh. Keeping the
// same indexes in the browser and the offline catalog builder lets us compare
// faces without downloading or running Face Landmarker on candidate images.
export const DETAIL_LANDMARKS = [...new Set([
  ...STABLE_LANDMARKS,
  ...Array.from({ length: FACE_POINT_LIMIT }, (_, index) => index)
    .filter((index) => index % 3 === 0),
  // Lips, eyelids and brows need denser sampling than the rest of the surface.
  0, 11, 12, 13, 14, 15, 16, 17, 37, 39, 40, 61, 72, 73, 74, 76, 77, 78,
  80, 81, 82, 84, 85, 87, 88, 89, 90, 91, 95, 146, 178, 179, 180, 181,
  183, 184, 185, 191, 267, 269, 270, 291, 302, 303, 304, 306, 307, 308,
  310, 311, 312, 314, 315, 317, 318, 319, 320, 321, 324, 325, 375, 402,
  403, 404, 405, 407, 408, 409, 415,
  33, 133, 144, 145, 153, 154, 155, 157, 158, 159, 160, 161, 163,
  246, 263, 362, 373, 374, 380, 381, 382, 384, 385, 386, 387, 388, 390,
  398, 466,
  46, 52, 53, 55, 63, 65, 66, 70, 105, 107, 276, 282, 283, 285, 293,
  295, 296, 300, 334, 336,
])] as number[];

function pointAt(points: MeshPoint[], index: number) {
  const point = points[index];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? point
    : null;
}

function distance(points: MeshPoint[], left: number, right: number) {
  const a = pointAt(points, left);
  const b = pointAt(points, right);
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(points: MeshPoint[], left: number, right: number) {
  const a = pointAt(points, left);
  const b = pointAt(points, right);
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pointDistance(a: MeshPoint | null, b: MeshPoint | null) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function faceGeometryFromLandmarks(
  points: MeshPoint[],
  sourceAspectRatio = 1,
): FaceGeometry | null {
  if (points.length <= REQUIRED_LANDMARK) return null;
  const aspect = Number.isFinite(sourceAspectRatio) && sourceAspectRatio > 0
    ? sourceAspectRatio
    : 1;
  const metricPoints = points.map((point) => ({ ...point, x: point.x * aspect }));
  const leftEye = midpoint(metricPoints, 33, 133);
  const rightEye = midpoint(metricPoints, 362, 263);
  const eyeSpan = pointDistance(leftEye, rightEye);
  if (!eyeSpan || eyeSpan < 0.01) return null;

  const eyesCenter = leftEye && rightEye
    ? { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 }
    : null;
  const ratio = (value: number | null) => value === null ? 0 : value / eyeSpan;
  const structure = [
    ratio(distance(metricPoints, 234, 454)),
    ratio(distance(metricPoints, 10, 152)),
    ratio(distance(metricPoints, 172, 397)),
    ratio(distance(metricPoints, 127, 356)),
    ratio(distance(metricPoints, 98, 327)),
    ratio(pointDistance(eyesCenter, pointAt(metricPoints, 2))),
    ratio(distance(metricPoints, 33, 133)),
    ratio(distance(metricPoints, 362, 263)),
    ratio(distance(metricPoints, 2, 152)),
  ];
  if (!leftEye || !rightEye || !eyesCenter) return null;
  const eyeDx = rightEye.x - leftEye.x;
  const eyeDy = rightEye.y - leftEye.y;
  const cosine = eyeDx / eyeSpan;
  const sine = eyeDy / eyeSpan;
  const canonicalPoint = (point: MeshPoint) => {
    const relativeX = point.x - eyesCenter.x;
    const relativeY = point.y - eyesCenter.y;
    return [
      (relativeX * cosine + relativeY * sine) / eyeSpan,
      (-relativeX * sine + relativeY * cosine) / eyeSpan,
      Number(point.z ?? 0) / eyeSpan,
    ];
  };
  for (const index of STABLE_LANDMARKS) {
    const point = pointAt(metricPoints, index);
    if (!point) return null;
    structure.push(...canonicalPoint(point));
  }
  // Iris points are omitted because gaze changes independently of face shape.
  const surface: number[] = [];
  for (const index of DETAIL_LANDMARKS) {
    const point = pointAt(metricPoints, index);
    if (!point) return null;
    surface.push(...canonicalPoint(point));
  }
  const projection: number[] = [];
  for (let index = 0; index < Math.min(metricPoints.length, FACE_POINT_LIMIT); index += 1) {
    const point = pointAt(metricPoints, index);
    if (!point) return null;
    const [x, y] = canonicalPoint(point);
    projection.push(x, y);
  }
  if (
    structure.some((value) => !Number.isFinite(value)) ||
    surface.some((value) => !Number.isFinite(value)) ||
    projection.some((value) => !Number.isFinite(value))
  ) return null;

  const xs = points.map((point) => point.x).filter(Number.isFinite);
  const ys = points.map((point) => point.y).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    structure,
    surface,
    projection,
    layout: [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      maxX - minX,
      maxY - minY,
    ],
  };
}

function weightedMeanSquared(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  weights: number[],
) {
  let total = 0;
  let weightTotal = 0;
  const length = Math.min(left.length, right.length, weights.length);
  for (let index = 0; index < length; index += 1) {
    const delta = left[index] - right[index];
    total += delta * delta * weights[index];
    weightTotal += weights[index];
  }
  return weightTotal ? total / weightTotal : 0;
}

export function identityGeometryDistance(left: FaceGeometry, right: FaceGeometry) {
  return structureVectorDistance(left.structure, right.structure);
}

export function structureVectorDistance(left: ArrayLike<number>, right: ArrayLike<number>) {
  const ratioWeights = [
    2.2, 2.5, 1.8, 1.4, 1.7, 1.7, 0.8, 0.8, 1.3,
  ];
  let total = 0;
  let weightTotal = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const weight = ratioWeights[index] ?? 0.42;
    const delta = left[index] - right[index];
    total += delta * delta * weight;
    weightTotal += weight;
  }
  return weightTotal ? total / weightTotal : 0;
}

export function surfaceGeometryDistance(left: FaceGeometry, right: FaceGeometry) {
  const length = Math.min(left.surface.length, right.surface.length);
  if (!length) return identityGeometryDistance(left, right);
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < length; index += 1) {
    const weight = index % 3 === 2 ? 0.22 : 1;
    const delta = left.surface[index] - right.surface[index];
    total += delta * delta * weight;
    weightTotal += weight;
  }
  return weightTotal ? total / weightTotal : 0;
}

export function layoutDistance(left: FaceGeometry, right: FaceGeometry) {
  return weightedMeanSquared(left.layout, right.layout, [1.2, 1.5, 2.4, 2.8]);
}

export function offlineFeatureDistance(left: number[], right: number[]) {
  const poseWeights = [4.4, 5.2, 1.8];
  let distanceValue = 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = Number(left[index] ?? 0) - Number(right[index] ?? 0);
    distanceValue += delta * delta * poseWeights[index];
  }
  const valueAt = (feature: number[], index: number) =>
    Math.max(0, Math.min(1, Number(feature[index] ?? 0)));
  const signature = (feature: number[]) => ({
    mouthOpen: Math.max(valueAt(feature, 3), valueAt(feature, 5) * 0.45),
    smile: (valueAt(feature, 7) + valueAt(feature, 8)) / 2,
    frown: Math.max(
      (valueAt(feature, 9) + valueAt(feature, 10)) / 2,
      (valueAt(feature, 18) + valueAt(feature, 19)) / 2,
    ),
    squint: (valueAt(feature, 15) + valueAt(feature, 16)) / 2,
    browUp: (valueAt(feature, 17) + valueAt(feature, 20) + valueAt(feature, 21)) / 3,
    pucker: (valueAt(feature, 5) + valueAt(feature, 6)) / 2,
  });
  const a = signature(left);
  const b = signature(right);
  distanceValue += (a.mouthOpen - b.mouthOpen) ** 2 * 3.2;
  distanceValue += (a.smile - b.smile) ** 2 * 3.4;
  distanceValue += (a.frown - b.frown) ** 2 * 2.1;
  distanceValue += (a.squint - b.squint) ** 2 * 0.7;
  distanceValue += (a.browUp - b.browUp) ** 2 * 1.5;
  distanceValue += (a.pucker - b.pucker) ** 2 * 0.8;
  return distanceValue;
}

export function emissionDistance(frame: SequenceFrame, candidate: SequenceCandidate) {
  return offlineFeatureDistance(frame.feature, candidate.feature) +
    surfaceGeometryDistance(frame.geometry, candidate.geometry) * 1.65 +
    identityGeometryDistance(frame.geometry, candidate.geometry) * 0.35;
}

function transitionDistance(
  previous: SequenceCandidate,
  next: SequenceCandidate,
  coherence: number,
) {
  if (previous.id === next.id) return 0;
  const switchPenalty = 0.018 + coherence * 0.095;
  const identityPenalty = identityGeometryDistance(previous.geometry, next.geometry) *
    (0.75 + coherence * 2.4);
  const placementPenalty = layoutDistance(previous.geometry, next.geometry) *
    (1.2 + coherence * 5.2);
  return switchPenalty + identityPenalty + placementPenalty;
}

export function optimizeFaceSequence<T extends SequenceCandidate>(
  frames: SequenceFrame[],
  candidates: T[],
  options: SequenceOptions = {},
): SequenceChoice<T>[] {
  if (!frames.length || !candidates.length) return [];
  const coherence = Math.max(0, Math.min(1, options.coherence ?? 0.75));
  const beamWidth = Math.max(2, Math.min(24, options.beamWidth ?? 10));
  const beams = frames.map((frame) =>
    candidates
      .map((candidate) => ({
        candidate,
        emission: emissionDistance(frame, candidate),
      }))
      .sort((left, right) => left.emission - right.emission)
      .slice(0, beamWidth),
  );

  const costs: number[][] = [];
  const backPointers: number[][] = [];
  costs[0] = beams[0].map((item) => item.emission);
  backPointers[0] = beams[0].map(() => -1);

  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const previousBeam = beams[frameIndex - 1];
    const currentBeam = beams[frameIndex];
    costs[frameIndex] = [];
    backPointers[frameIndex] = [];
    currentBeam.forEach((current, currentIndex) => {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestPrevious = 0;
      previousBeam.forEach((previous, previousIndex) => {
        const cost = costs[frameIndex - 1][previousIndex] +
          transitionDistance(previous.candidate, current.candidate, coherence) +
          current.emission;
        if (cost < bestCost) {
          bestCost = cost;
          bestPrevious = previousIndex;
        }
      });
      costs[frameIndex][currentIndex] = bestCost;
      backPointers[frameIndex][currentIndex] = bestPrevious;
    });
  }

  const lastCosts = costs[costs.length - 1];
  let cursor = lastCosts.reduce(
    (best, value, index) => value < lastCosts[best] ? index : best,
    0,
  );
  const choices = Array<SequenceChoice<T>>(frames.length);
  for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
    const item = beams[frameIndex][cursor];
    choices[frameIndex] = {
      frame: frames[frameIndex],
      candidate: item.candidate,
      emission: item.emission,
    };
    cursor = backPointers[frameIndex][cursor];
  }
  return choices;
}

/**
 * Dynamic programming over a small, independently retrieved beam per frame.
 * This is the scalable path: search can inspect an entire numeric catalog, but
 * sequence optimization remains O(frames * beam^2), not O(frames * catalog).
 */
export function optimizeFaceSequenceBeams<T extends SequenceCandidate>(
  frames: SequenceFrame[],
  candidateBeams: T[][],
  options: SequenceOptions = {},
): SequenceChoice<T>[] {
  if (!frames.length || frames.length !== candidateBeams.length) return [];
  const coherence = Math.max(0, Math.min(1, options.coherence ?? 0.75));
  const beamWidth = Math.max(2, Math.min(48, options.beamWidth ?? 24));
  const beams = frames.map((frame, frameIndex) =>
    candidateBeams[frameIndex]
      .map((candidate) => ({ candidate, emission: emissionDistance(frame, candidate) }))
      .sort((left, right) => left.emission - right.emission)
      .slice(0, beamWidth),
  );
  if (beams.some((beam) => !beam.length)) return [];
  const transitionCache = new Map<string, number>();
  const cachedTransition = (previous: T, next: T) => {
    const key = previous.id < next.id
      ? `${previous.id}\u0000${next.id}`
      : `${next.id}\u0000${previous.id}`;
    const cached = transitionCache.get(key);
    if (cached !== undefined) return cached;
    const value = transitionDistance(previous, next, coherence);
    transitionCache.set(key, value);
    return value;
  };

  const costs: number[][] = [beams[0].map((item) => item.emission)];
  const backPointers: number[][] = [beams[0].map(() => -1)];
  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const previousBeam = beams[frameIndex - 1];
    const currentBeam = beams[frameIndex];
    costs[frameIndex] = [];
    backPointers[frameIndex] = [];
    currentBeam.forEach((current, currentIndex) => {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestPrevious = 0;
      previousBeam.forEach((previous, previousIndex) => {
        const cost = costs[frameIndex - 1][previousIndex] +
          cachedTransition(previous.candidate, current.candidate) +
          current.emission;
        if (cost < bestCost) {
          bestCost = cost;
          bestPrevious = previousIndex;
        }
      });
      costs[frameIndex][currentIndex] = bestCost;
      backPointers[frameIndex][currentIndex] = bestPrevious;
    });
  }

  const lastCosts = costs[costs.length - 1];
  let cursor = lastCosts.reduce(
    (best, value, index) => value < lastCosts[best] ? index : best,
    0,
  );
  const choices = Array<SequenceChoice<T>>(frames.length);
  for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
    const item = beams[frameIndex][cursor];
    choices[frameIndex] = {
      frame: frames[frameIndex],
      candidate: item.candidate,
      emission: item.emission,
    };
    cursor = backPointers[frameIndex][cursor];
  }
  return choices;
}

export function medianSequenceLayout(choices: SequenceChoice<SequenceCandidate>[]) {
  if (!choices.length) return [0.5, 0.5, 0.62, 0.76] as FaceGeometry["layout"];
  return [0, 1, 2, 3].map((index) => {
    const values = choices
      .map((choice) => choice.candidate.geometry.layout[index])
      .sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)];
  }) as FaceGeometry["layout"];
}

export function objectFitCoverLayout(
  layout: FaceGeometry["layout"],
  sourceAspectRatio: number,
  containerAspectRatio = 1,
): FaceGeometry["layout"] {
  const sourceAspect = Number.isFinite(sourceAspectRatio) && sourceAspectRatio > 0
    ? sourceAspectRatio
    : 1;
  const containerAspect = Number.isFinite(containerAspectRatio) && containerAspectRatio > 0
    ? containerAspectRatio
    : 1;
  const widthScale = Math.max(1, sourceAspect / containerAspect);
  const heightScale = Math.max(1, containerAspect / sourceAspect);
  const [centerX, centerY, width, height] = layout;
  return [
    0.5 + (centerX - 0.5) * widthScale,
    0.5 + (centerY - 0.5) * heightScale,
    width * widthScale,
    height * heightScale,
  ];
}

export function alignmentTransform(
  geometry: FaceGeometry,
  target: FaceGeometry["layout"],
) {
  const [centerX, centerY, width, height] = geometry.layout;
  const scaleFromHeight = target[3] / Math.max(0.01, height);
  const scaleFromWidth = target[2] / Math.max(0.01, width);
  // One global crop transform only; facial parts are never warped independently.
  const scale = Math.max(0.5, Math.min(2.5, (scaleFromHeight * 0.7 + scaleFromWidth * 0.3)));
  const scaledCenterX = 0.5 + (centerX - 0.5) * scale;
  const scaledCenterY = 0.5 + (centerY - 0.5) * scale;
  return {
    xPercent: (target[0] - scaledCenterX) * 100,
    yPercent: (target[1] - scaledCenterY) * 100,
    scale,
  };
}
