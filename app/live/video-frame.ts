import { throwIfAborted, withDeadline } from "../runtime-io.ts";

/** Register the presentation callback BEFORE seeking. A timeout is never success. */
export async function seekDecodedVideoFrame(
  video: HTMLVideoElement,
  time: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!Number.isFinite(time) || time < 0) throw new RangeError("Invalid video time");
  const target = Math.min(time, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : time);
  if (!video.seeking && Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) return;
  await withDeadline((deadline) => new Promise<void>((resolve, reject) => {
    let callback: number | undefined;
    let done = false;
    const cleanup = () => {
      deadline.removeEventListener("abort", aborted);
      video.removeEventListener("error", failed);
      video.removeEventListener("seeked", seeked);
      if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
    };
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(deadline.reason);
    const failed = () => finish(new Error("動画フレームを読み込めませんでした"));
    const seeked = () => {
      // Browsers without rVFC expose no presentation timestamp. This fallback
      // requires completed seeking AND decoded current data; it never waits
      // for a timer and then silently accepts an unready frame.
      if (!video.requestVideoFrameCallback && !video.seeking && video.readyState >= 2) finish();
    };
    const presented: VideoFrameRequestCallback = (_now, metadata) => {
      if (done) return;
      const delta = target - metadata.mediaTime;
      if (Number.isFinite(metadata.mediaTime) && delta >= -0.02 && delta <= 0.15 && video.readyState >= 2) finish();
      else callback = video.requestVideoFrameCallback(presented);
    };
    deadline.addEventListener("abort", aborted, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.addEventListener("seeked", seeked);
    if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(presented);
    video.currentTime = target;
  }), signal, 8_000);
}
