import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";

export type ReviewAnalysisMode = "IMAGE" | "VIDEO";
export type ReviewAnalysisDelegate = "CPU" | "GPU";
export type ReviewAnalysisInfo = {
  mode: ReviewAnalysisMode;
  delegate: ReviewAnalysisDelegate;
  execution: "worker" | "main-thread";
  fallbackReasons: string[];
};
export type ReviewAnalysisResult = {
  result: FaceLandmarkerResult;
  timingsMs: { copy: number; inference: number; total: number };
  inferenceTimestampMs: number | null;
};
type AnalysisCanvas = HTMLCanvasElement | OffscreenCanvas;
type Engine = Pick<FaceLandmarker, "detect" | "detectForVideo" | "close">;

/** MediaPipe needs increasing inference timestamps even for repeated sample times. */
export function nextInferenceTimestampMs(timeSeconds: number, previousMs: number | null): number {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw new RangeError("顔解析の時刻が不正です");
  const milliseconds = timeSeconds * 1000;
  if (!Number.isFinite(milliseconds)) throw new RangeError("顔解析の時刻が大きすぎます");
  return previousMs === null ? milliseconds : Math.max(milliseconds, previousMs + 0.001);
}

/** One session per clip: tracking state never crosses into a different recording. */
export function createFrameAnalysisSession(engine: Engine, mode: ReviewAnalysisMode, createCanvas: (width: number, height: number) => AnalysisCanvas) {
  let canvas: AnalysisCanvas | null = null;
  let previousTimestampMs: number | null = null;
  let previousTimeSeconds = -Infinity;
  let closed = false;
  return {
    analyze(bitmap: ImageBitmap, timeSeconds: number): ReviewAnalysisResult {
      const started = performance.now();
      try {
        if (closed) throw new DOMException("顔解析を終了しました", "AbortError");
        if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw new RangeError("顔解析の時刻が不正です");
        if (mode === "VIDEO" && timeSeconds < previousTimeSeconds) throw new RangeError("VIDEO_ANALYSIS_TIME_ORDER: 別の動画には新しい解析セッションが必要です");
        if (bitmap.width < 1 || bitmap.height < 1) throw new Error("ANALYSIS_FRAME_INVALID: 顔解析の画像が空です");
        canvas ??= createCanvas(bitmap.width, bitmap.height);
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
        const context = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new Error("ANALYSIS_CANVAS_UNAVAILABLE: 顔解析のキャンバスを作成できません");
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const copyMs = performance.now() - started;
        const inferenceTimestampMs = mode === "VIDEO" ? nextInferenceTimestampMs(timeSeconds, previousTimestampMs) : null;
        const inferenceStarted = performance.now();
        const result = mode === "VIDEO" ? engine.detectForVideo(canvas, inferenceTimestampMs!) : engine.detect(canvas);
        previousTimestampMs = inferenceTimestampMs;
        previousTimeSeconds = timeSeconds;
        return { result, inferenceTimestampMs, timingsMs: { copy: copyMs, inference: performance.now() - inferenceStarted, total: performance.now() - started } };
      } finally { bitmap.close(); }
    },
    close() {
      if (closed) return;
      closed = true;
      engine.close();
      if (canvas) { canvas.width = 1; canvas.height = 1; canvas = null; }
    },
  };
}
