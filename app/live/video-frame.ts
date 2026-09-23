export type DecodedVideoFrame = {
  bitmap: ImageBitmap;
  requestedTime: number;
  mediaTime: number | null;
  evidence: "presentation-callback" | "decoded-paused-readback";
};

const active = new WeakSet<HTMLVideoElement>();
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

// Seek and capture form one operation. The presentation callback is armed
// BEFORE seeking. A paused frame that is already current (or a second sample
// within the same encoded frame) does not owe us another rVFC notification.
// In that case we explicitly verify seek/data/position, cross two paint
// boundaries and acquire a decoded bitmap. No timeout is treated as success.
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
  let stage = "position";
  const deadline = setTimeout(() => controller.abort(new Error(`VIDEO_FRAME_TIMEOUT: 指定時刻の映像を取得できませんでした（${stage}; request=${time.toFixed(4)}, current=${video.currentTime.toFixed(4)}, ready=${video.readyState}, seeking=${video.seeking}）。ページを開いたまま再試行してください。`)), options.timeoutMs ?? 8000);
  const duration = Number.isFinite(video.duration) ? video.duration : Math.max(5, time + 1);
  const target = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)));
  let callbackId: number | null = null;
  let mediaTime: number | null = null;
  let notifyPresented: () => void = () => undefined;
  const presented = new Promise<void>(resolve => { notifyPresented = resolve; });
  const source = video.currentSrc;
  const positioned = () => !video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && Math.abs(video.currentTime - target) < 0.004 && video.currentSrc === source;
  try {
    video.pause();
    const arm = () => {
      if (signal.aborted || typeof video.requestVideoFrameCallback !== "function") return;
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        if (positioned() && Number.isFinite(metadata.mediaTime) && metadata.mediaTime <= target + 0.005) {
          mediaTime = metadata.mediaTime;
          notifyPresented();
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
    stage = "presentation";
    let grace: ReturnType<typeof setTimeout> | undefined;
    try { await abortable(Promise.race([presented, new Promise<void>(resolve => { grace = setTimeout(resolve, 100); })]), signal); }
    finally { if (grace) clearTimeout(grace); }
    stage = "paint";
    await paint(signal);
    await paint(signal);
    if (!positioned() || !video.paused) throw new Error("VIDEO_POSITION_CHANGED: 取得中に動画の時刻が変わりました");
    stage = "bitmap";
    const snapshot = createImageBitmap(video);
    void snapshot.then(bitmap => { if (signal.aborted) bitmap.close(); }, () => undefined);
    const bitmap = await abortable(snapshot, signal);
    if (signal.aborted || !positioned() || bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close();
      throw new Error("VIDEO_FRAME_INVALID: 指定時刻の映像を確認できませんでした");
    }
    return { bitmap, requestedTime: target, mediaTime, evidence: mediaTime === null ? "decoded-paused-readback" : "presentation-callback" };
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
    active.delete(video);
  }
}
