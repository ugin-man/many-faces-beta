import { pauseTask, throwIfAborted, withDeadline } from "../runtime-io.ts";

export async function captureCameraClip(
  preview: HTMLVideoElement,
  signal: AbortSignal,
  onProgress: (remaining: number) => void,
  seconds = 5,
): Promise<Blob> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("このブラウザではカメラ録画を利用できません。動画ファイルを選んでください。");
  }
  const stream = await withDeadline(async (deadline) => {
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    if (deadline.aborted) {
      acquired.getTracks().forEach((track) => track.stop());
      throwIfAborted(deadline);
    }
    return acquired;
  }, signal, 30_000);
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    throwIfAborted(signal);
    preview.srcObject = stream;
    preview.muted = true;
    preview.playsInline = true;
    await withDeadline(() => preview.play(), signal, 10_000);
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const active = recorder;
    active.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve, reject) => {
      active.onstop = () => resolve();
      active.onerror = () => reject(new Error("カメラ録画が中断されました"));
    });
    // Observe errors immediately, including those emitted before stop is awaited.
    void stopped.catch(() => undefined);
    active.start(250);
    const start = performance.now();
    timer = setInterval(() => onProgress(Math.max(0, seconds - (performance.now() - start) / 1000)), 100);
    await pauseTask(seconds * 1000, signal);
    clearInterval(timer);
    if (active.state !== "inactive") active.stop();
    await withDeadline(() => stopped, signal, 5_000);
    throwIfAborted(signal);
    const blob = new Blob(chunks, { type: active.mimeType || mimeType || "video/webm" });
    if (!blob.size) throw new Error("録画データを作れませんでした");
    return blob;
  } finally {
    clearInterval(timer);
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
    if (preview.srcObject === stream) preview.srcObject = null;
  }
}
