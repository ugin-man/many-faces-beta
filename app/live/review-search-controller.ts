import { ProgressDeadline } from "./asset-reader.ts";

export type ReviewWorkerPort = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};
type Job = { id: number; cancel: () => void };

/** One video search at a time. Keep decoded static catalog data between jobs,
 * never old video results. IDs isolate cancelled jobs and late messages. */
export class ReviewSearchController {
  private worker: ReviewWorkerPort | null = null;
  private active: Job | null = null;
  private nextId = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly factory: () => ReviewWorkerPort;
  private readonly build: string;
  private readonly idleMs: number;
  constructor(factory: () => ReviewWorkerPort, build: string, idleMs = 120000) {
    this.factory = factory; this.build = build; this.idleMs = idleMs;
  }

  run<T extends { type: "result"; build: string }, P extends { type: "progress"; sequence: number }>(
    frames: unknown[], origin: string, signal: AbortSignal, onProgress: (event: P) => void,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    this.active?.cancel();
    clearTimeout(this.idleTimer);
    const worker = this.worker ??= this.factory();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const deadline = new ProgressDeadline(performance.now());
      let settled = false;
      const finish = (error?: unknown, result?: T, broken = false) => {
        if (settled) return;
        settled = true; clearInterval(timer); signal.removeEventListener("abort", cancel);
        if (this.active?.id === id) this.active = null;
        if (broken && this.worker === worker) { worker.terminate(); this.worker = null; }
        if (!this.active && this.worker === worker) this.idleTimer = setTimeout(() => this.dispose(), this.idleMs);
        // AbortSignal.reason may legally be 0, false, or an empty string.
        // Only an actual result is success; truthiness is not an error test.
        if (result !== undefined) resolve(result); else reject(error);
      };
      const cancel = () => {
        worker.postMessage({ type: "cancel", jobId: id });
        finish(signal.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      const timer = setInterval(() => {
        if (deadline.expired(performance.now(), 90000, 1800000))
          finish(new Error("SEARCH_IDLE_TIMEOUT: 照合データの受信・解析が90秒間進んでいません。"), undefined, true);
      }, 250);
      this.active = { id, cancel };
      signal.addEventListener("abort", cancel, { once: true });
      worker.onerror = event => finish(new Error(`SEARCH_WORKER_ERROR: ${event.message}`), undefined, true);
      worker.onmessage = event => {
        const message = event.data;
        if (settled || signal.aborted || message.jobId !== id) return;
        if (message.type === "progress") {
          if (deadline.observe(message.sequence, performance.now())) onProgress(message);
        } else if (message.type === "error") finish(new Error(message.message));
        else if (message.type === "result") {
          if (message.build !== this.build) finish(new Error("BUILD_MISMATCH: 照合処理が古い版です。ページを再読み込みしてください。"), undefined, true);
          else finish(undefined, message);
        }
      };
      try { worker.postMessage({ type: "search", jobId: id, frames, origin, build: this.build }); }
      catch (error) { finish(error, undefined, true); }
      if (signal.aborted) cancel();
    });
  }

  dispose() {
    this.active?.cancel();
    clearTimeout(this.idleTimer);
    this.worker?.terminate(); this.worker = null;
  }
}
