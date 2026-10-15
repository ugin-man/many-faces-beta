import type { SequenceFrame } from "../offline-matching";
import type { LiveCandidate } from "../live-matching";
import type { ProjectionChoice } from "../projection-matching";
import { ProgressDeadline } from "./asset-reader";
import { runtimeIdentity } from "../runtime-identity";
export type SearchProgress = {
  type: "progress"; sequence: number; phase: "searching" | "optimizing";
  label: string; bytes: number; files: number; decoded: number;
  completed: number; total: number; peakCandidates: number;
};
export type SearchResult = { type: "result"; choices: ProjectionChoice<LiveCandidate>[]; candidateSearchMs: number; pathOptimizationMs: number; build: string };

export function searchReviewFrames(frames: SequenceFrame[], signal: AbortSignal, onProgress: (event: SearchProgress) => void): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL("./review-search.worker.ts", import.meta.url));
    const deadline = new ProgressDeadline(performance.now());
    let settled = false;
    const finish = (error?: unknown, result?: SearchResult) => {
      if (settled) return; settled = true;
      clearInterval(timer); signal.removeEventListener("abort", cancel); worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    const timer = setInterval(() => {
      if (deadline.expired(performance.now(), 90000, 1800000)) finish(new Error("SEARCH_IDLE_TIMEOUT: 照合データの受信・解析が90秒間進んでいません。"));
    }, 250);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = event => finish(new Error(`SEARCH_WORKER_ERROR: ${event.message}`));
    worker.onmessage = (event: MessageEvent<SearchProgress | SearchResult | { type: "error"; message: string }>) => {
      if (settled || signal.aborted) return;
      const message = event.data;
      if (message.type === "progress") {
        if (deadline.observe(message.sequence, performance.now())) onProgress(message);
      } else if (message.type === "error") finish(new Error(message.message));
      else if (message.build !== runtimeIdentity.build) finish(new Error("BUILD_MISMATCH: 照合処理が古い版です。ページを再読み込みしてください。"));
      else finish(undefined, message);
    };
    try { worker.postMessage({ frames, origin: location.origin, build: runtimeIdentity.build }); }
    catch (error) { finish(error); }
    if (signal.aborted) cancel();
  });
}
