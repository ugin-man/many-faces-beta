export type DecodedVideoFrame = {
  bitmap: ImageBitmap;
  timingsMs: { position: number; paint: number; bitmap: number; total: number };
  requestedTime: number;
  mediaTime: number | null;
  evidence: "presentation-callback" | "decoded-paused-readback";
};

const active = new WeakSet<HTMLVideoElement>();
const readbackCanvases = new WeakMap<HTMLVideoElement, HTMLCanvasElement>();
const abortError = () => new DOMException("動画解析を取り消しました", "AbortError");

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}

function paint(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { cancelAnimationFrame(id); reject(signal.reason ?? abortError()); };
    const id = requestAnimationFrame(() => { signal.removeEventListener("abort", cancel); resolve(); });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function recoverableSnapshotFailure(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return name === "InvalidStateError" || name === "NotSupportedError" || name === "TypeError";
}

async function snapshotVideoFrame(video: HTMLVideoElement, signal: AbortSignal, positioned: () => boolean): Promise<ImageBitmap> {
  try {
    // Keep the normal decoder snapshot at the existing point in the capture
    // operation. A successful native readback needs no canvas or extra wait.
    return await createImageBitmap(video);
  } catch (error) {
    if (!recoverableSnapshotFailure(error)) throw error;
    let failure = error;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Only a failed canvas readback gets one further paint opportunity.
      // The existing capture deadline also bounds a suspended paint callback.
      if (attempt) await paint(signal);
      if (signal.aborted) throw signal.reason ?? abortError();
      if (!positioned() || !video.paused) throw new Error("VIDEO_POSITION_CHANGED: 取得中に動画の時刻が変わりました");
      let canvas = readbackCanvases.get(video);
      if (!canvas) {
        canvas = document.createElement("canvas");
        readbackCanvases.set(video, canvas);
      }
      // Unlike the live-camera input helper, fixed-video readback must retain
      // every source pixel. Never resize the analysis frame to 480 pixels.
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("VIDEO_CANVAS_UNAVAILABLE: 動画のフレームを読み取るキャンバスを作れませんでした");
      try {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return await createImageBitmap(canvas);
      } catch (readbackError) {
        if (!recoverableSnapshotFailure(readbackError)) throw readbackError;
        failure = readbackError;
      }
    }
    throw failure;
  }
}

// Seek and capture form one operation. The presentation callback is armed
// BEFORE seeking. A paused frame that is already current (or a second sample
// within the same encoded frame) does not owe us another rVFC notification.
// Once paused seek/data/position are valid, cross two paint boundaries and
// acquire a decoded bitmap. The rVFC is evidence only: a future callback is not
// owed for repeated/paused frames. Waiting 100 ms for it added a per-frame
// delay without strengthening the subsequent decoded-pixel checks.
// Neither a timeout nor a seek notification alone is treated as success.
export async function captureVideoFrameAt(
  video: HTMLVideoElement,
  time: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DecodedVideoFrame> {
  if (!Number.isFinite(time)) throw new RangeError("動画の時刻が不正です");
  if (active.has(video)) throw new Error("同じ動画のフレーム取得を同時に実行できません");
  if (options.signal?.aborted) throw abortError();
  active.add(video);
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(abortError());
  options.signal?.addEventListener("abort", cancel, { once: true });
  const startedAt = performance.now();
  let positionMs = 0, paintMs = 0;
  let stage = "position";
  const deadline = setTimeout(() => controller.abort(new Error(`VIDEO_FRAME_TIMEOUT: 指定時刻の映像を取得できませんでした（${stage}; request=${time.toFixed(4)}, current=${video.currentTime.toFixed(4)}, ready=${video.readyState}, seeking=${video.seeking}）。ページを開いたまま再試行してください。`)), options.timeoutMs ?? 8000);
  const duration = Number.isFinite(video.duration) ? video.duration : Math.max(5, time + 1);
  const target = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)));
  let callbackId: number | null = null;
  let mediaTime: number | null = null;
  const source = video.currentSrc;
  const positioned = () => !video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && Math.abs(video.currentTime - target) < 0.004 && video.currentSrc === source;
  try {
    video.pause();
    const arm = () => {
      if (signal.aborted || typeof video.requestVideoFrameCallback !== "function") return;
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        if (positioned() && Number.isFinite(metadata.mediaTime) && metadata.mediaTime <= target + 0.005) {
          mediaTime = metadata.mediaTime;
        } else arm();
      });
    };
    arm();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearInterval(poll); video.removeEventListener("seeked", check); video.removeEventListener("loadeddata", check); video.removeEventListener("error", failed); signal.removeEventListener("abort", abort); };
      const check = () => { if (positioned()) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error(`VIDEO_DECODE_ERROR: 動画を読み込めませんでした（${video.error?.code ?? 0}）`)); };
      const abort = () => { cleanup(); reject(signal.reason ?? abortError()); };
      const poll = setInterval(check, 40);
      video.addEventListener("seeked", check);
      video.addEventListener("loadeddata", check);
      video.addEventListener("error", failed);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (Math.abs(video.currentTime - target) >= 0.002) video.currentTime = target;
        check();
        if (signal.aborted) abort();
      } catch (error) { cleanup(); reject(error); }
    });
    positionMs = performance.now() - startedAt;
    stage = "paint";
    const paintStartedAt = performance.now();
    await paint(signal);
    await paint(signal);
    paintMs = performance.now() - paintStartedAt;
    if (!positioned() || !video.paused) throw new Error("VIDEO_POSITION_CHANGED: 取得中に動画の時刻が変わりました");
    stage = "bitmap";
    const bitmapStartedAt = performance.now();
    const snapshot = snapshotVideoFrame(video, signal, positioned);
    void snapshot.then(bitmap => { if (signal.aborted) bitmap.close(); }, () => undefined);
    const bitmap = await abortable(snapshot, signal);
    if (signal.aborted || !positioned() || bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close();
      throw new Error("VIDEO_FRAME_INVALID: 指定時刻の映像を確認できませんでした");
    }
    return { bitmap, timingsMs: { position: positionMs, paint: paintMs, bitmap: performance.now() - bitmapStartedAt, total: performance.now() - startedAt }, requestedTime: target, mediaTime, evidence: mediaTime === null ? "decoded-paused-readback" : "presentation-callback" };
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
    active.delete(video);
  }
}
