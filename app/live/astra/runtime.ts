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
};

// There is no FIFO: a busy processor drops incoming frames and samples the
// next fresh video frame after completion. Memory and queue age are bounded.
export class LatestFrameGate {
  private nextId = 0;
  private active: { id: number; capturedAt: number } | null = null;
  private lastAcceptedAt = -Infinity;
  private lastMediaTime = -Infinity;
  busyDrops = 0;
  staleResults = 0;
  accepted = 0;
  completed = 0;

  reserve(now: number, mediaTime: number, fps = 20) {
    if (!Number.isFinite(now) || !Number.isFinite(mediaTime)) return null;
    if (this.active) { this.busyDrops += 1; return null; }
    if (mediaTime === this.lastMediaTime || now - this.lastAcceptedAt < 1000 / fps - 1) return null;
    this.lastAcceptedAt = now;
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
    if (age > maxAgeMs || age < 0) { this.staleResults += 1; return false; }
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

// getUserMedia itself cannot be aborted. A late permission grant must not
// resurrect a cancelled session or leave its camera indicator switched on.
export async function acquireCurrentStream(
  request: () => Promise<MediaStream>,
  isCurrent: () => boolean,
  timeoutMs = 25000,
) {
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
    return await Promise.race([
      streamPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("カメラの許可待ちが長いため停止しました。許可を確認して再開してください。"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function qualityBoundedReadyChoice(
  ranked: readonly DisplayCandidate[],
  ready: (candidate: DisplayCandidate) => boolean,
  currentId: string | null,
  allowChange: boolean,
) {
  if (!ranked.length) return null;
  // Never choose an arbitrarily bad match just to inflate output FPS.
  const ceiling = ranked[0].score + Math.max(0.025, Math.abs(ranked[0].score) * 0.15);
  const eligible = ranked.filter((candidate) => Number.isFinite(candidate.score) && candidate.score <= ceiling);
  if (currentId && !allowChange) return eligible.find((candidate) => candidate.id === currentId && ready(candidate)) ?? null;
  return eligible.find(ready) ?? null;
}
