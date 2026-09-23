export type DisplayCandidate = {
  id: string;
  name: string;
  url: string;
  score: number;
  sourceName?: string;
  sourceUrl?: string;
  creator?: string;
};

export type FrameResult = {
  type: "frame";
  id: number;
  capturedAt: number;
  face: boolean;
  feature: number[];
  ranked: DisplayCandidate[];
  inferenceMs: number;
  searchMs: number;
  candidates: number;
  shards: number;
  pendingShards: number;
  catalogError: string | null;
  diagnostics?: Record<string, number>;
};

// A phase-preserving sampler, not a delay after every accepted frame. At a
// 30 Hz input, resetting a 50 ms delay each time silently limits 20 Hz to 15 Hz.
// Missed deadlines are skipped; there is still no FIFO or catch-up backlog.
export class LatestFrameGate {
  private nextId = 0;
  private active: { id: number; capturedAt: number } | null = null;
  private nextDueAt = -Infinity;
  private intervalMs = 0;
  private lastMediaTime = -Infinity;
  busyDrops = 0;
  staleResults = 0;
  accepted = 0;
  completed = 0;

  reserve(now: number, mediaTime: number, fps = 20) {
    if (!Number.isFinite(now) || !Number.isFinite(mediaTime) || !Number.isFinite(fps) || fps <= 0) return null;
    if (this.active) { this.busyDrops += 1; return null; }
    if (mediaTime === this.lastMediaTime) return null;
    const interval = 1000 / Math.min(fps, 60);
    if (interval !== this.intervalMs || !Number.isFinite(this.nextDueAt)) {
      this.intervalMs = interval;
      this.nextDueAt = now;
    }
    if (now + 0.001 < this.nextDueAt) return null;
    this.nextDueAt += (Math.floor(Math.max(0, now + 0.001 - this.nextDueAt) / interval) + 1) * interval;
    this.lastMediaTime = mediaTime;
    this.active = { id: ++this.nextId, capturedAt: now };
    this.accepted += 1;
    return this.active.id;
  }

  complete(id: number, now: number, maxAgeMs = 500) {
    if (this.active?.id !== id) return false;
    const age = now - this.active.capturedAt;
    this.active = null;
    this.completed += 1;
    if (!Number.isFinite(age) || age > maxAgeMs || age < 0) { this.staleResults += 1; return false; }
    return true;
  }

  stalled(now: number, timeoutMs = 8000) {
    return this.active !== null && now - this.active.capturedAt > timeoutMs;
  }

  get inFlight() { return this.active ? 1 : 0; }
}

export function cameraErrorMessage(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "カメラの許可がありません。ブラウザの設定を確認して、もう一度開始してください。";
  if (name === "NotFoundError") return "利用できるカメラが見つかりません。動画ファイルでも試せます。";
  if (name === "NotReadableError") return "カメラを開けません。他のアプリで使用していないか確認してください。";
  return error instanceof Error ? error.message : String(error);
}

// getUserMedia itself cannot be aborted: cancelled late streams are released.
export async function acquireCurrentStream(request: () => Promise<MediaStream>, isCurrent: () => boolean, timeoutMs = 25000) {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const streamPromise = request().then((stream) => {
    if (expired || !isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("カメラの開始を取り消しました", "AbortError");
    }
    return stream;
  });
  try {
    return await Promise.race([streamPromise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error("カメラの許可待ちが長いため停止しました。許可を確認して再開してください。")); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Prefetch and presentation must use the same quality envelope. Otherwise
// three ready but unusable images can prevent the actual winner loading forever.
export function qualityEligibleCandidates(ranked: readonly DisplayCandidate[]) {
  const finite = ranked.filter((candidate) => Number.isFinite(candidate.score));
  if (!finite.length) return [];
  const best = Math.min(...finite.map((candidate) => candidate.score));
  const ceiling = best + Math.max(0.025, Math.abs(best) * 0.15);
  return finite.filter((candidate) => candidate.score <= ceiling);
}

export function qualityBoundedReadyChoice(ranked: readonly DisplayCandidate[], ready: (candidate: DisplayCandidate) => boolean, currentId: string | null, allowChange: boolean) {
  const eligible = qualityEligibleCandidates(ranked);
  if (currentId && !allowChange) {
    const held = eligible.find((candidate) => candidate.id === currentId && ready(candidate));
    if (held) return held;
    // Motion may end before a slow image download completes. Holding an
    // out-of-envelope face forever is a freeze, not useful static hysteresis.
  }
  return eligible.find(ready) ?? null;
}
