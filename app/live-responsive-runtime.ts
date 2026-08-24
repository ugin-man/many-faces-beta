export type FeatureMotion = {
  pose: number;
  expression: number;
  total: number;
};

export type ResponsiveSwitchDecision = FeatureMotion & {
  isMoving: boolean;
  shouldSwitch: boolean;
  targetRate: number;
  targetIntervalMs: number;
  accumulatedMotion: number;
};

export type ResponsiveSwitchOptions = {
  deadband?: number;
  switchThreshold?: number;
  movementHoldMs?: number;
  minimumMovingRate?: number;
  maximumMovingRate?: number;
};

const DEFAULT_OPTIONS: Required<ResponsiveSwitchOptions> = {
  deadband: 0.11,
  switchThreshold: 0.42,
  movementHoldMs: 180,
  minimumMovingRate: 10,
  maximumMovingRate: 20,
};

function finite(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function featureMotion(
  previous: ArrayLike<number> | null,
  next: ArrayLike<number>,
): FeatureMotion {
  if (!previous || previous.length < 3 || next.length < 3) {
    return { pose: 0, expression: 0, total: 0 };
  }

  const yaw = (finite(next[0]) - finite(previous[0])) * 90 / 2.5;
  const pitch = (finite(next[1]) - finite(previous[1])) * 90 / 2.2;
  const roll = (finite(next[2]) - finite(previous[2])) * 90 / 6;
  const pose = Math.hypot(yaw, pitch, roll);

  const actionDeltas: number[] = [];
  const length = Math.min(previous.length, next.length);
  for (let index = 3; index < length; index += 1) {
    actionDeltas.push(Math.abs(finite(next[index]) - finite(previous[index])));
  }
  actionDeltas.sort((left, right) => right - left);
  const strongest = actionDeltas[0] ?? 0;
  const top = actionDeltas.slice(0, 8);
  const localMean = top.length
    ? top.reduce((sum, value) => sum + value, 0) / top.length
    : 0;
  const expression = strongest * 4.2 + localMean * 3.2;

  return {
    pose,
    expression,
    total: pose + expression,
  };
}

export class ResponsiveSwitchController {
  private readonly options: Required<ResponsiveSwitchOptions>;
  private lastFeature: number[] | null = null;
  private lastObservationAt = 0;
  private lastSwitchAt = 0;
  private movingUntil = 0;
  private accumulatedMotion = 0;

  constructor(options: ResponsiveSwitchOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(now = 0) {
    this.lastFeature = null;
    this.lastObservationAt = now;
    this.lastSwitchAt = now;
    this.movingUntil = now;
    this.accumulatedMotion = 0;
  }

  commitSwitch(now: number) {
    this.lastSwitchAt = now;
    this.accumulatedMotion *= 0.18;
  }

  observe(
    now: number,
    feature: ArrayLike<number>,
    maximumRate = this.options.maximumMovingRate,
  ): ResponsiveSwitchDecision {
    const motion = featureMotion(this.lastFeature, feature);
    const elapsedObservation = this.lastObservationAt
      ? clamp(now - this.lastObservationAt, 8, 250)
      : 16;
    const decay = Math.exp(-elapsedObservation / 220);
    this.accumulatedMotion = this.accumulatedMotion * decay + motion.total;

    if (motion.total >= this.options.deadband) {
      this.movingUntil = now + this.options.movementHoldMs;
    }
    const isMoving =
      now <= this.movingUntil ||
      this.accumulatedMotion >= this.options.switchThreshold;

    const normalizedMotion = clamp(
      Math.max(motion.total, this.accumulatedMotion * 0.42),
      0,
      2.2,
    );
    const configuredMaximum = clamp(
      maximumRate,
      this.options.minimumMovingRate,
      30,
    );
    const rateSpan = configuredMaximum - this.options.minimumMovingRate;
    const targetRate = isMoving
      ? this.options.minimumMovingRate + rateSpan * clamp(normalizedMotion / 1.4, 0, 1)
      : 0;
    const targetIntervalMs = targetRate > 0 ? 1000 / targetRate : Infinity;
    const shouldSwitch =
      isMoving &&
      now - this.lastSwitchAt >= targetIntervalMs &&
      this.accumulatedMotion >= this.options.switchThreshold;

    this.lastFeature = Array.from(feature, finite);
    this.lastObservationAt = now;

    return {
      ...motion,
      isMoving,
      shouldSwitch,
      targetRate,
      targetIntervalMs,
      accumulatedMotion: this.accumulatedMotion,
    };
  }
}

export type RankedCandidateLike<T> = {
  candidate: T;
  score: number;
};

export function selectReadyRankedCandidate<T extends { id: string }>(
  ranked: readonly RankedCandidateLike<T>[],
  isReady: (candidate: T) => boolean,
  currentId: string | null,
  recentIds: readonly string[] = [],
) {
  const recent = new Set(recentIds);
  const fresh = ranked.find(
    ({ candidate }) =>
      candidate.id !== currentId &&
      !recent.has(candidate.id) &&
      isReady(candidate),
  );
  if (fresh) return fresh;
  const anyDifferent = ranked.find(
    ({ candidate }) => candidate.id !== currentId && isReady(candidate),
  );
  if (anyDifferent) return anyDifferent;
  return ranked.find(
    ({ candidate }) => candidate.id === currentId && isReady(candidate),
  ) ?? null;
}

export function predictedPoseDegrees(
  previous: ArrayLike<number> | null,
  current: ArrayLike<number>,
  elapsedMs: number,
  horizonMs = 120,
) {
  const yaw = finite(current[0]) * 90;
  const pitch = finite(current[1]) * 90;
  if (!previous || elapsedMs <= 0 || previous.length < 2) {
    return { yaw, pitch };
  }
  const safeElapsed = clamp(elapsedMs, 8, 160);
  const yawVelocity = clamp(
    (yaw - finite(previous[0]) * 90) / safeElapsed,
    -0.22,
    0.22,
  );
  const pitchVelocity = clamp(
    (pitch - finite(previous[1]) * 90) / safeElapsed,
    -0.18,
    0.18,
  );
  return {
    yaw: yaw + yawVelocity * horizonMs,
    pitch: pitch + pitchVelocity * horizonMs,
  };
}
