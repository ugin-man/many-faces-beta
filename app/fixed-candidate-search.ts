import { FACE_ACTION_FEATURE_INDEX } from "./face-actions.ts";

export type SearchVector = ArrayLike<number>;

export type FixedSearchGeometry = {
  structure: SearchVector;
  projection?: SearchVector;
};

export type FixedSearchCandidate = {
  id: string;
  feature: number[];
  geometry: FixedSearchGeometry;
};

export type FixedSearchFrame = {
  feature: number[];
  geometry: FixedSearchGeometry;
};

export type FixedCandidateIndexOptions = {
  poseStepDegrees?: number;
  maxBucketEntries?: number;
};

export type FixedCandidateQueryOptions = {
  budget?: number;
  maxInspected?: number;
  yawRadiusDegrees?: number;
  pitchRadiusDegrees?: number;
  previousIds?: readonly string[];
};

export type FixedCandidateQueryResult<T> = {
  candidates: T[];
  inspected: number;
  bucketHits: number;
  fallbackCandidates: number;
};

type Sketches = {
  structure: number[];
  action: number[];
  local: number[];
};

type HashTable = {
  source: keyof Sketches;
  dimensions: readonly number[];
  binSize: number;
  buckets: Map<string, number[]>;
};

const ACTION_KEYS = [
  "jawOpen",
  "mouthFunnel",
  "mouthPucker",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeWideLeft",
  "eyeWideRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "browInnerUp",
  "browDownLeft",
  "browDownRight",
  "noseSneerLeft",
  "noseSneerRight",
] as const;

const LOCAL_LANDMARKS = [
  10, 152, 234, 454,
  33, 133, 362, 263,
  1, 98, 327,
  61, 291, 13, 14,
  159, 145, 386, 374,
  105, 334,
] as const;

const TABLE_DEFINITIONS = [
  { source: "structure", dimensions: [0, 1, 2, 3, 4, 5], binSize: 0.09 },
  { source: "structure", dimensions: [1, 6, 7, 8, 10, 14], binSize: 0.075 },
  { source: "action", dimensions: [0, 3, 4, 9, 10, 17], binSize: 0.18 },
  { source: "action", dimensions: [1, 2, 7, 8, 11, 12], binSize: 0.18 },
  { source: "local", dimensions: [8, 9, 20, 21, 24, 25], binSize: 0.12 },
] as const satisfies readonly Omit<HashTable, "buckets">[];

function finite(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function poseDegrees(feature: readonly number[]) {
  return [
    finite(feature[0]) * 90,
    finite(feature[1]) * 90,
    finite(feature[2]) * 90,
  ] as const;
}

function structureSketch(vector: SearchVector) {
  const output = Array.from({ length: Math.min(9, vector.length) }, (_, index) => finite(vector[index]));
  if (vector.length > 9) {
    const remaining = vector.length - 9;
    for (let sample = 0; sample < 18; sample += 1) {
      const index = 9 + Math.floor((remaining - 1) * sample / 17);
      output.push(finite(vector[index]));
    }
  }
  return output;
}

function actionSketch(feature: readonly number[]) {
  return ACTION_KEYS.map((key) => finite(feature[FACE_ACTION_FEATURE_INDEX[key]]));
}

function localSketch(projection: SearchVector | undefined) {
  if (!projection) return Array(LOCAL_LANDMARKS.length * 2).fill(0);
  return LOCAL_LANDMARKS.flatMap((landmark) => [
    finite(projection[landmark * 2]),
    finite(projection[landmark * 2 + 1]),
  ]);
}

function sketchesFor(value: FixedSearchCandidate | FixedSearchFrame): Sketches {
  return {
    structure: structureSketch(value.geometry.structure),
    action: actionSketch(value.feature),
    local: localSketch(value.geometry.projection),
  };
}

function poseCell(yaw: number, pitch: number, step: number) {
  return `${Math.round(yaw / step)}:${Math.round(pitch / step)}`;
}

function hashParts(vector: readonly number[], dimensions: readonly number[], binSize: number) {
  return dimensions.map((dimension) => Math.round(finite(vector[dimension]) / binSize));
}

function hashKey(cell: string, parts: readonly number[]) {
  return `${cell}|${parts.join(",")}`;
}

function neighborPartSets(parts: readonly number[]) {
  const output: number[][] = [[...parts]];
  for (let index = 0; index < parts.length; index += 1) {
    const lower = [...parts];
    lower[index] -= 1;
    output.push(lower);
    const upper = [...parts];
    upper[index] += 1;
    output.push(upper);
  }
  return output;
}

function deterministicBucketSample(bucket: readonly number[], limit: number) {
  if (bucket.length <= limit) return bucket;
  const output: number[] = [];
  const stride = bucket.length / limit;
  for (let index = 0; index < limit; index += 1) {
    output.push(bucket[Math.floor(index * stride)]);
  }
  return output;
}

function squaredDistance(left: readonly number[], right: readonly number[], limit: number) {
  const length = Math.min(left.length, right.length, limit);
  if (!length) return 0;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = finite(left[index]) - finite(right[index]);
    total += delta * delta;
  }
  return total / length;
}

function cheapDistance(
  frame: FixedSearchFrame,
  frameSketches: Sketches,
  candidate: FixedSearchCandidate,
  candidateSketches: Sketches,
) {
  const [frameYaw, framePitch, frameRoll] = poseDegrees(frame.feature);
  const [candidateYaw, candidatePitch, candidateRoll] = poseDegrees(candidate.feature);
  const yaw = (frameYaw - candidateYaw) / 18;
  const pitch = (framePitch - candidatePitch) / 21;
  const roll = (frameRoll - candidateRoll) / 45;
  const pose = yaw * yaw * 0.72 + pitch * pitch * 1.0 + roll * roll * 0.08;
  const structure = squaredDistance(frameSketches.structure, candidateSketches.structure, 27);
  const action = squaredDistance(frameSketches.action, candidateSketches.action, ACTION_KEYS.length);
  const local = squaredDistance(frameSketches.local, candidateSketches.local, LOCAL_LANDMARKS.length * 2);
  return pose + structure * 1.55 + action * 1.3 + local * 0.42;
}

function nearbyPoseCells(
  yaw: number,
  pitch: number,
  step: number,
  yawRadius: number,
  pitchRadius: number,
) {
  const centerYaw = Math.round(yaw / step);
  const centerPitch = Math.round(pitch / step);
  const yawSteps = Math.max(0, Math.ceil(yawRadius / step));
  const pitchSteps = Math.max(0, Math.ceil(pitchRadius / step));
  const output: Array<{ key: string; distance: number }> = [];
  for (let y = -yawSteps; y <= yawSteps; y += 1) {
    for (let p = -pitchSteps; p <= pitchSteps; p += 1) {
      output.push({
        key: `${centerYaw + y}:${centerPitch + p}`,
        distance: y * y + p * p * 0.82,
      });
    }
  }
  return output.sort((left, right) => left.distance - right.distance).map((item) => item.key);
}

export class FixedCandidateSearchIndex<T extends FixedSearchCandidate> {
  readonly size: number;
  readonly poseStepDegrees: number;
  readonly maxBucketEntries: number;

  private readonly candidates: readonly T[];
  private readonly sketches: readonly Sketches[];
  private readonly byId = new Map<string, number>();
  private readonly poseBuckets = new Map<string, number[]>();
  private readonly tables: HashTable[];

  constructor(candidates: readonly T[], options: FixedCandidateIndexOptions = {}) {
    this.candidates = candidates;
    this.size = candidates.length;
    this.poseStepDegrees = clamp(Math.round(options.poseStepDegrees ?? 9), 3, 18);
    this.maxBucketEntries = clamp(Math.round(options.maxBucketEntries ?? 40), 8, 256);
    this.sketches = candidates.map(sketchesFor);
    this.tables = TABLE_DEFINITIONS.map((definition) => ({ ...definition, buckets: new Map() }));

    candidates.forEach((candidate, index) => {
      this.byId.set(candidate.id, index);
      const [yaw, pitch] = poseDegrees(candidate.feature);
      const cell = poseCell(yaw, pitch, this.poseStepDegrees);
      const poseEntries = this.poseBuckets.get(cell);
      if (poseEntries) poseEntries.push(index);
      else this.poseBuckets.set(cell, [index]);

      const candidateSketches = this.sketches[index];
      for (const table of this.tables) {
        const parts = hashParts(candidateSketches[table.source], table.dimensions, table.binSize);
        const key = hashKey(cell, parts);
        const bucket = table.buckets.get(key);
        if (bucket) bucket.push(index);
        else table.buckets.set(key, [index]);
      }
    });
  }

  query(frame: FixedSearchFrame, options: FixedCandidateQueryOptions = {}): FixedCandidateQueryResult<T> {
    if (!this.candidates.length) {
      return { candidates: [], inspected: 0, bucketHits: 0, fallbackCandidates: 0 };
    }
    const budget = clamp(Math.round(options.budget ?? 512), 16, Math.max(16, this.candidates.length));
    const maxInspected = clamp(
      Math.round(options.maxInspected ?? Math.max(768, budget * 4)),
      budget,
      Math.max(budget, this.candidates.length),
    );
    const [yaw, pitch] = poseDegrees(frame.feature);
    const cells = nearbyPoseCells(
      yaw,
      pitch,
      this.poseStepDegrees,
      options.yawRadiusDegrees ?? 18,
      options.pitchRadiusDegrees ?? 24,
    );
    const frameSketches = sketchesFor(frame);
    const selected = new Set<number>();
    let bucketHits = 0;

    const addBucket = (bucket: readonly number[] | undefined) => {
      if (!bucket || selected.size >= maxInspected) return;
      bucketHits += 1;
      const room = maxInspected - selected.size;
      const sampled = deterministicBucketSample(bucket, Math.min(this.maxBucketEntries, room));
      for (const index of sampled) {
        selected.add(index);
        if (selected.size >= maxInspected) break;
      }
    };

    // Exact quantized buckets are checked first for every descriptor family.
    for (const cell of cells) {
      for (const table of this.tables) {
        const parts = hashParts(frameSketches[table.source], table.dimensions, table.binSize);
        addBucket(table.buckets.get(hashKey(cell, parts)));
      }
      if (selected.size >= Math.min(maxInspected, budget * 2)) break;
    }

    // Then expand one quantized dimension at a time. This catches boundaries
    // without a combinatorial neighborhood explosion.
    if (selected.size < Math.min(maxInspected, budget * 2)) {
      for (const cell of cells) {
        for (const table of this.tables) {
          const base = hashParts(frameSketches[table.source], table.dimensions, table.binSize);
          for (const parts of neighborPartSets(base).slice(1)) {
            addBucket(table.buckets.get(hashKey(cell, parts)));
            if (selected.size >= Math.min(maxInspected, budget * 3)) break;
          }
          if (selected.size >= Math.min(maxInspected, budget * 3)) break;
        }
        if (selected.size >= Math.min(maxInspected, budget * 3)) break;
      }
    }

    for (const id of options.previousIds ?? []) {
      const index = this.byId.get(id);
      if (index !== undefined) selected.add(index);
    }

    let fallbackCandidates = 0;
    if (selected.size < budget) {
      for (const cell of cells) {
        const bucket = this.poseBuckets.get(cell);
        if (!bucket) continue;
        const needed = Math.min(budget - selected.size, this.maxBucketEntries);
        for (const index of deterministicBucketSample(bucket, needed)) {
          const before = selected.size;
          selected.add(index);
          if (selected.size > before) fallbackCandidates += 1;
          if (selected.size >= budget || selected.size >= maxInspected) break;
        }
        if (selected.size >= budget || selected.size >= maxInspected) break;
      }
    }

    if (selected.size < budget) {
      const needed = budget - selected.size;
      const fallback = deterministicBucketSample(
        Array.from({ length: this.candidates.length }, (_, index) => index),
        Math.min(this.candidates.length, needed * 2),
      );
      for (const index of fallback) {
        const before = selected.size;
        selected.add(index);
        if (selected.size > before) fallbackCandidates += 1;
        if (selected.size >= budget) break;
      }
    }

    const previous = new Set(options.previousIds ?? []);
    const measured = [...selected]
      .map((index) => ({
        index,
        score: cheapDistance(frame, frameSketches, this.candidates[index], this.sketches[index]) -
          (previous.has(this.candidates[index].id) ? 0.035 : 0),
      }))
      .sort((left, right) => left.score - right.score || left.index - right.index);
    // Reserve a small part of the beam for recent identities. They still need
    // to be in the indexed catalog, but cannot disappear solely because a new
    // hash bucket was entered between adjacent frames.
    const previousLimit = Math.min(previous.size, Math.max(1, Math.floor(budget / 4)));
    const forcedPrevious = measured.filter((item) => previous.has(this.candidates[item.index].id)).slice(0, previousLimit);
    const forcedIndexes = new Set(forcedPrevious.map((item) => item.index));
    const ranked = [
      ...forcedPrevious,
      ...measured.filter((item) => !forcedIndexes.has(item.index)).slice(0, budget - forcedPrevious.length),
    ].map((item) => this.candidates[item.index]);

    return {
      candidates: ranked,
      inspected: selected.size,
      bucketHits,
      fallbackCandidates,
    };
  }
}
