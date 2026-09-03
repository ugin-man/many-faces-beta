export type AdaptiveSearchCadenceOptions = {
  targetFps?: number;
  minimumIntervalMs?: number;
  maximumIntervalMs?: number;
};

/**
 * Keeps detailed projection ranking off the hot path when the previous search
 * is already expensive. Face detection can continue at its native cadence,
 * while ranking runs only as often as a 10–20fps output can actually consume.
 */
export class AdaptiveSearchCadence {
  private readonly targetIntervalMs: number;
  private readonly minimumIntervalMs: number;
  private readonly maximumIntervalMs: number;
  private lastSearchAt = Number.NEGATIVE_INFINITY;
  private durationEma = 0;

  constructor(options: AdaptiveSearchCadenceOptions = {}) {
    const targetFps = Math.max(10, Math.min(24, options.targetFps ?? 20));
    this.targetIntervalMs = 1_000 / targetFps;
    this.minimumIntervalMs = Math.max(24, options.minimumIntervalMs ?? 32);
    this.maximumIntervalMs = Math.max(
      this.minimumIntervalMs,
      Math.min(120, options.maximumIntervalMs ?? 84),
    );
  }

  shouldSearch(now: number, urgent = false) {
    const interval = urgent
      ? this.minimumIntervalMs
      : this.currentIntervalMs();
    if (now - this.lastSearchAt < interval) return false;
    this.lastSearchAt = now;
    return true;
  }

  record(durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.durationEma = this.durationEma
      ? this.durationEma * 0.78 + durationMs * 0.22
      : durationMs;
  }

  intervalMs() {
    return this.currentIntervalMs();
  }

  reset() {
    this.lastSearchAt = Number.NEGATIVE_INFINITY;
    this.durationEma = 0;
  }

  private currentIntervalMs() {
    const pressure = Math.max(0, this.durationEma - 3.5);
    const adaptive = this.targetIntervalMs + pressure * 3.4;
    return Math.max(
      this.minimumIntervalMs,
      Math.min(this.maximumIntervalMs, adaptive),
    );
  }
}
