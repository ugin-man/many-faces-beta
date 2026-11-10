import type { EngineProgress } from "./stable-landmarker";
import { runtimeIdentity } from "../runtime-identity";
import { createFrameAnalysisSession, type ReviewAnalysisMode, type ReviewAnalysisDelegate, type ReviewAnalysisInfo, type ReviewAnalysisResult } from "./face-analysis-core.ts";
import { createConfiguredReviewEngine } from "./face-analysis-engine.ts";

export type ReviewFaceAnalyzer = {
  info: ReviewAnalysisInfo;
  /** Ownership is consumed on every call; never reuse the bitmap after calling. */
  analyze(bitmap: ImageBitmap, timeSeconds: number): Promise<ReviewAnalysisResult>;
  close(): void;
};
export type ReviewFaceAnalyzerOptions = {
  mode: ReviewAnalysisMode;
  delegate: ReviewAnalysisDelegate;
  execution?: "auto" | "worker" | "main-thread";
  signal?: AbortSignal;
  onProgress?: (event: EngineProgress) => void;
};
const cancelled = () => new DOMException("顔解析を取り消しました", "AbortError");

function workerAnalyzer(options: ReviewFaceAnalyzerOptions): Promise<ReviewFaceAnalyzer> {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return Promise.reject(new Error("ANALYSIS_WORKER_UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    // Vite serves ES imports directly in development. The matching module WASM
    // loader also makes MediaPipe initialization work in a module worker.
    const worker = new Worker(new URL("./face-analysis.worker.ts", import.meta.url), { type: "module" });
    let ready = false, closed = false, sequence = 0, requestId = 0;
    let lastProgress = performance.now();
    const started = lastProgress;
    let pending: { id: number; resolve: (value: ReviewAnalysisResult) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> } | null = null;
    const close = (reason: unknown = cancelled()) => {
      if (closed) return;
      closed = true; clearInterval(startupTimer); options.signal?.removeEventListener("abort", abort);
      worker.onmessage = null; worker.onerror = null; worker.terminate();
      if (pending) { clearTimeout(pending.timer); pending.reject(reason); pending = null; }
      if (!ready) reject(reason);
    };
    const abort = () => close(options.signal?.reason ?? cancelled());
    const startupTimer = setInterval(() => {
      if (!ready && (performance.now() - lastProgress > 30000 || performance.now() - started > 120000)) {
        close(new Error("ANALYSIS_ENGINE_TIMEOUT: 顔解析エンジンの準備が進みませんでした"));
      }
    }, 1000);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = event => close(new Error(`ANALYSIS_WORKER_ERROR: ${event.message}`));
    worker.onmessage = (event: MessageEvent) => {
      if (closed || options.signal?.aborted) return;
      const message = event.data;
      if (message.build !== runtimeIdentity.build) { close(new Error("BUILD_MISMATCH: 顔解析が古い版です")); return; }
      if (message.type === "progress") {
        if (Number.isSafeInteger(message.sequence) && message.sequence > sequence) {
          sequence = message.sequence; lastProgress = performance.now();
          options.onProgress?.({ stage: message.stage, bytes: message.bytes });
        }
      } else if (message.type === "ready") {
        if (ready) { close(new Error("ANALYSIS_DUPLICATE_READY")); return; }
        ready = true; clearInterval(startupTimer);
        resolve({
          info: message.info as ReviewAnalysisInfo,
          analyze(bitmap, timeSeconds) {
            if (closed || options.signal?.aborted) { bitmap.close(); return Promise.reject(options.signal?.reason ?? cancelled()); }
            if (pending) { bitmap.close(); return Promise.reject(new Error("ANALYSIS_BUSY: 顔解析は1コマずつ実行してください")); }
            return new Promise((resolveFrame, rejectFrame) => {
              const id = ++requestId;
              const timer = setTimeout(() => close(new Error("ANALYSIS_FRAME_TIMEOUT: 顔解析が完了しませんでした")), 30000);
              pending = { id, resolve: resolveFrame, reject: rejectFrame, timer };
              try { worker.postMessage({ type: "frame", id, bitmap, time: timeSeconds, build: runtimeIdentity.build }, [bitmap]); }
              catch (error) { bitmap.close(); close(error); }
            });
          },
          close: () => close(),
        });
      } else if (message.type === "result") {
        if (!pending || message.id !== pending.id) return;
        const task = pending; pending = null; clearTimeout(task.timer);
        task.resolve({ result: message.result, timingsMs: message.timingsMs, inferenceTimestampMs: message.inferenceTimestampMs });
      } else if (message.type === "error") {
        // No mid-frame fallback: the transferred bitmap may already be closed.
        close(new Error(message.message || "ANALYSIS_WORKER_ERROR"));
      }
    };
    try { worker.postMessage({ type: "init", mode: options.mode, delegate: options.delegate, origin: location.origin, build: runtimeIdentity.build }); }
    catch (error) { close(error); }
    if (options.signal?.aborted) abort();
  });
}

async function mainThreadAnalyzer(options: ReviewFaceAnalyzerOptions, fallbackReasons: string[]): Promise<ReviewFaceAnalyzer> {
  const configured = await createConfiguredReviewEngine(options);
  const session = createFrameAnalysisSession(configured.engine, options.mode, (width, height) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
  });
  let closed = false;
  const close = () => { if (closed) return; closed = true; options.signal?.removeEventListener("abort", close); session.close(); };
  options.signal?.addEventListener("abort", close, { once: true });
  if (options.signal?.aborted) { close(); throw options.signal.reason ?? cancelled(); }
  return {
    info: { mode: options.mode, delegate: configured.delegate, execution: "main-thread", fallbackReasons: [...fallbackReasons, ...configured.fallbackReasons] },
    async analyze(bitmap, timeSeconds) {
      if (closed || options.signal?.aborted) { bitmap.close(); throw options.signal?.reason ?? cancelled(); }
      try {
        const output = session.analyze(bitmap, timeSeconds);
        if (options.signal?.aborted) throw options.signal.reason ?? cancelled();
        return output;
      } catch (error) { close(); throw error; }
    },
    close,
  };
}

/** IMAGE/CPU remains an explicit reference. VIDEO/GPU can be compared independently. */
export async function createReviewFaceAnalyzer(options: ReviewFaceAnalyzerOptions): Promise<ReviewFaceAnalyzer> {
  if (options.signal?.aborted) throw options.signal.reason ?? cancelled();
  if (options.execution !== "main-thread") {
    try { return await workerAnalyzer(options); }
    catch (error) {
      if (options.signal?.aborted || options.execution === "worker" || (error instanceof Error && error.message.startsWith("BUILD_MISMATCH"))) throw error;
      const reason = `WORKER_INITIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      return mainThreadAnalyzer(options, [reason]);
    }
  }
  return mainThreadAnalyzer(options, []);
}
