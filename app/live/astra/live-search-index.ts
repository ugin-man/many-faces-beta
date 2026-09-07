import { FACE_ACTION_FEATURE_INDEX } from "../../face-actions.ts";
import type { FixedSearchCandidate, FixedSearchFrame, FixedCandidateQueryOptions, FixedCandidateQueryResult } from "../../fixed-candidate-search.ts";

const ACTIONS = ["jawOpen", "mouthFunnel", "mouthPucker", "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight", "mouthStretchLeft", "mouthStretchRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeWideLeft", "eyeWideRight", "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight", "browInnerUp", "browDownLeft", "browDownRight", "noseSneerLeft", "noseSneerRight"] as const;
const LANDMARKS = [10, 152, 234, 454, 33, 133, 362, 263, 1, 98, 327, 61, 291, 13, 14, 159, 145, 386, 374, 105, 334] as const;
type Prepared = { values: Float64Array; structureLength: number };
const finite = (value: unknown) => { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; };

function prepare(value: FixedSearchCandidate | FixedSearchFrame): Prepared {
  const v = new Float64Array(94);
  for (let i = 0; i < 3; i++) v[i] = finite(value.feature[i]) * 90;
  const structure = value.geometry.structure;
  const head = Math.min(9, structure.length);
  for (let i = 0; i < head; i++) v[3 + i] = finite(structure[i]);
  if (structure.length > 9) {
    for (let i = 0; i < 18; i++) v[12 + i] = finite(structure[9 + Math.floor((structure.length - 10) * i / 17)]);
  }
  for (let i = 0; i < ACTIONS.length; i++) v[30 + i] = finite(value.feature[FACE_ACTION_FEATURE_INDEX[ACTIONS[i]]]);
  for (let i = 0; i < LANDMARKS.length; i++) {
    v[52 + i * 2] = finite(value.geometry.projection?.[LANDMARKS[i] * 2]);
    v[53 + i * 2] = finite(value.geometry.projection?.[LANDMARKS[i] * 2 + 1]);
  }
  return { values: v, structureLength: structure.length > 9 ? 27 : head };
}

function distance(a: Prepared, b: Prepared) {
  const x = a.values, y = b.values;
  const yaw = (x[0] - y[0]) / 18, pitch = (x[1] - y[1]) / 21, roll = (x[2] - y[2]) / 45;
  const count = Math.min(a.structureLength, b.structureLength);
  let structure = 0, action = 0, local = 0;
  for (let i = 3; i < 3 + count; i++) { const d = x[i] - y[i]; structure += d * d; }
  for (let i = 30; i < 52; i++) { const d = x[i] - y[i]; action += d * d; }
  for (let i = 52; i < 94; i++) { const d = x[i] - y[i]; local += d * d; }
  return yaw * yaw * 0.72 + pitch * pitch + roll * roll * 0.08 + (count ? structure / count : 0) * 1.55 + action / 22 * 1.3 + local / 42 * 0.42;
}

// Catalog candidate objects are immutable. Weak keys let evicted shards and
// their descriptors be collected; unlike rebuilding five string-hash tables,
// changing a pose working set only assembles references to existing descriptors.
const preparedCandidates = new WeakMap<object, Prepared>();

export class ReusableLiveSearchIndex<T extends FixedSearchCandidate> {
  readonly size: number;
  private readonly candidates: readonly T[];
  private readonly prepared: Prepared[];

  constructor(candidates: readonly T[]) {
    this.candidates = candidates;
    this.size = candidates.length;
    this.prepared = candidates.map((candidate) => {
      let value = preparedCandidates.get(candidate);
      if (!value) { value = prepare(candidate); preparedCandidates.set(candidate, value); }
      return value;
    });
  }

  query(frame: FixedSearchFrame, options: FixedCandidateQueryOptions = {}): FixedCandidateQueryResult<T> {
    if (!this.size) return { candidates: [], inspected: 0, bucketHits: 0, fallbackCandidates: 0 };
    const budget = Math.min(this.size, Math.max(1, Math.round(options.budget ?? 128)));
    const query = prepare(frame);
    const previous = new Set(options.previousIds ?? []);
    // Exhaustive coarse scoring of the bounded ACTIVE working set. No stride
    // thinning or hash-bucket subsampling can silently erase its rare entries.
    // This is not a claim of exhaustive detailed search across all 70,000 faces.
    const measured = this.candidates.map((candidate, i) => ({ i, score: distance(query, this.prepared[i]) - (previous.has(candidate.id) ? 0.035 : 0) }));
    measured.sort((a, b) => a.score - b.score || a.i - b.i);
    const reserve = Math.min(previous.size, Math.max(1, Math.floor(budget / 4)));
    const forced = measured.filter(({ i }) => previous.has(this.candidates[i].id)).slice(0, reserve);
    const forcedIds = new Set(forced.map(({ i }) => i));
    const selected = [...forced, ...measured.filter(({ i }) => !forcedIds.has(i)).slice(0, budget - forced.length)];
    return { candidates: selected.map(({ i }) => this.candidates[i]), inspected: this.size, bucketHits: 0, fallbackCandidates: 0 };
  }
}
