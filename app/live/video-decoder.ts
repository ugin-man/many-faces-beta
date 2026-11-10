import { captureVideoFrameAt, type DecodedVideoFrame } from "./video-frame.ts";

export type ReviewDecoderBackend = "webcodecs" | "video-element";
export type ReviewDecodedFrame = Omit<DecodedVideoFrame, "evidence"> & {
  evidence: DecodedVideoFrame["evidence"] | "webcodecs";
  backend: ReviewDecoderBackend;
};
export type ReviewDecoderOptions = {
  signal?: AbortSignal;
  /** video-element is retained as the pixel/reference and compatibility path. */
  backend?: "auto" | ReviewDecoderBackend;
  frameTimeoutMs?: number;
  onBackend?: (event: { backend: ReviewDecoderBackend; fallbackReason?: string }) => void;
};
type FrameStreamFactory = (times: readonly number[]) => AsyncIterable<ReviewDecodedFrame>;
const cancelled = () => new DOMException("動画解析を取り消しました", "AbortError");
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? cancelled(); }

/** A range flag alone does not declare a YUV matrix, primaries or transfer. */
export function hasDeclaredVideoColorSpace(colorSpace: VideoColorSpaceInit | undefined): boolean {
  return Boolean(colorSpace?.primaries || colorSpace?.matrix || colorSpace?.transfer);
}

/** A decoder/bitmap operation may finish after cancellation. Dispose that late result. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, disposeLate?: (value: T) => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(signal?.reason ?? cancelled());
    const timer = setTimeout(() => fail(new Error("VIDEO_DECODER_TIMEOUT: 動画の連続読み出しが進みませんでした")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(value => {
      if (settled) { disposeLate?.(value); return; }
      settled = true; cleanup(); resolve(value);
    }, fail);
    if (signal?.aborted) abort();
  });
}

/**
 * Keep sample coverage when an optional decoder fails halfway through a clip.
 * Already delivered samples are never replayed; cancellation never starts a fallback.
 * Factories own their decoder resources, while callers own each yielded bitmap.
 */
export async function* continueWithFrameFallback(
  times: readonly number[], preferred: FrameStreamFactory, fallback: FrameStreamFactory,
  options: { signal?: AbortSignal; onFallback?: (reason: string) => void } = {},
): AsyncGenerator<ReviewDecodedFrame> {
  for (const time of times) if (!Number.isFinite(time) || time < 0) throw new RangeError("動画の時刻が不正です");
  checkAbort(options.signal);
  let delivered = 0;
  try {
    for await (const frame of preferred(times)) {
      try {
        checkAbort(options.signal);
        if (delivered >= times.length || frame.requestedTime !== times[delivered]) {
          throw new Error("VIDEO_DECODER_ORDER: 連続読み出しのサンプル時刻が一致しません");
        }
      } catch (error) { frame.bitmap.close(); throw error; }
      delivered++;
      yield frame;
    }
    if (delivered !== times.length) throw new Error("VIDEO_DECODER_INCOMPLETE: 動画の全サンプルを読み出せませんでした");
    return;
  } catch (error) {
    checkAbort(options.signal);
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    options.onFallback?.(error instanceof Error ? error.message : "VIDEO_DECODER_UNAVAILABLE");
  }
  for await (const frame of fallback(times.slice(delivered))) {
    try {
      checkAbort(options.signal);
      if (frame.requestedTime !== times[delivered]) throw new Error("VIDEO_FALLBACK_ORDER: 互換読み出しの時刻が一致しません");
    } catch (error) { frame.bitmap.close(); throw error; }
    delivered++;
    yield frame;
  }
  if (delivered !== times.length) throw new Error("VIDEO_FALLBACK_INCOMPLETE: 動画の全サンプルを読み出せませんでした");
}

async function* webCodecsFrames(
  source: Blob | string, times: readonly number[], options: ReviewDecoderOptions,
): AsyncGenerator<ReviewDecodedFrame> {
  checkAbort(options.signal);
  if (typeof VideoDecoder === "undefined") throw new Error("VIDEO_DECODER_UNAVAILABLE: WebCodecsを利用できません");
  const { Input, BlobSource, UrlSource, ALL_FORMATS, CanvasSink } = await import("mediabunny");
  checkAbort(options.signal);
  const input = new Input({
    formats: ALL_FORMATS,
    source: typeof source === "string"
      ? new UrlSource(source, { maxCacheSize: 16 * 1024 * 1024, getRetryDelay: attempts => attempts < 2 ? 0.25 * (attempts + 1) : null })
      : new BlobSource(source),
  });
  const timeoutMs = options.frameTimeoutMs ?? 15000;
  const abort = () => input.dispose();
  options.signal?.addEventListener("abort", abort, { once: true });
  let iterator: AsyncGenerator<import("mediabunny").WrappedCanvas | null, void, unknown> | null = null;
  try {
    checkAbort(options.signal);
    const track = await bounded(input.getPrimaryVideoTrack(), options.signal, timeoutMs);
    if (!track) {
      throw new Error("VIDEO_CODEC_UNSUPPORTED: この動画形式は互換読み出しを使用します");
    }
    if (options.backend !== "webcodecs") {
      const colorSpace = await bounded(track.getColorSpace(), options.signal, timeoutMs);
      // Mediabunny fills unspecified Chromium color metadata with BT.709.
      // The video element may choose another matrix (observed for untagged SD).
      // Preserve its existing rendering when the source provides no color tags.
      if (!hasDeclaredVideoColorSpace(colorSpace)) {
        throw new Error("VIDEO_COLORSPACE_UNSPECIFIED: 色空間が未指定の動画は色を保持する互換読み出しを使用します");
      }
    }
    if (!await bounded(track.canDecode(), options.signal, timeoutMs)) {
      throw new Error("VIDEO_CODEC_UNSUPPORTED: この動画形式は互換読み出しを使用します");
    }
    // No resize/rotation overrides: preserve display dimensions, pixel aspect,
    // rotation and flip metadata. A single canvas is reused after bitmap capture.
    const sink = new CanvasSink(track, { poolSize: 1, alpha: false });
    iterator = sink.canvasesAtTimestamps(times);
    for (const time of times) {
      checkAbort(options.signal);
      const started = performance.now();
      const next = await bounded(iterator.next(), options.signal, timeoutMs);
      const decodeMs = performance.now() - started;
      const wrapped = next.value;
      if (next.done || !wrapped || wrapped.canvas.width < 1 || wrapped.canvas.height < 1 || wrapped.timestamp > time + 0.000001) {
        throw new Error("VIDEO_FRAME_UNAVAILABLE: 指定時刻のフレームを連続読み出しできませんでした");
      }
      const bitmapStarted = performance.now();
      const bitmap = await bounded(createImageBitmap(wrapped.canvas), options.signal, timeoutMs, value => value.close());
      if (options.signal?.aborted) { bitmap.close(); checkAbort(options.signal); }
      yield {
        bitmap, requestedTime: time, mediaTime: wrapped.timestamp, evidence: "webcodecs", backend: "webcodecs",
        timingsMs: { position: decodeMs, paint: 0, bitmap: performance.now() - bitmapStarted, total: performance.now() - started },
      };
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    // dispose also cancels an in-flight network read or decoder after timeout.
    input.dispose();
    if (iterator) { try { await iterator.return(); } catch { /* already disposed */ } }
  }
}

/** Decode exactly the supplied sample times; consume/close each bitmap before advancing. */
export async function* decodeReviewFrames(
  video: HTMLVideoElement, source: Blob | string, times: readonly number[], options: ReviewDecoderOptions = {},
): AsyncGenerator<ReviewDecodedFrame> {
  for (const time of times) if (!Number.isFinite(time) || time < 0) throw new RangeError("動画の時刻が不正です");
  checkAbort(options.signal);
  if (!times.length) return;
  const legacy: FrameStreamFactory = async function* (remaining) {
    for (const time of remaining) {
      checkAbort(options.signal);
      const frame = await captureVideoFrameAt(video, time, { signal: options.signal });
      yield { ...frame, backend: "video-element" };
    }
  };
  if (options.backend === "video-element") {
    options.onBackend?.({ backend: "video-element" });
    yield* legacy(times);
    return;
  }
  options.onBackend?.({ backend: "webcodecs" });
  if (options.backend === "webcodecs") { yield* webCodecsFrames(source, times, options); return; }
  yield* continueWithFrameFallback(times, t => webCodecsFrames(source, t, options), legacy, {
    signal: options.signal,
    onFallback: fallbackReason => options.onBackend?.({ backend: "video-element", fallbackReason }),
  });
}
