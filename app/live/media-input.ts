export class MediaInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaInputError";
    this.code = code;
  }
}

export type CameraEnvironment = { secure: boolean; available: boolean; embedded: boolean; cameraAllowed: boolean | null };

export function cameraEnvironment(): CameraEnvironment {
  const policyDocument = document as Document & { permissionsPolicy?: { allowsFeature(feature: string): boolean }; featurePolicy?: { allowsFeature(feature: string): boolean } };
  let cameraAllowed: boolean | null = null;
  try {
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
    cameraAllowed = policy ? policy.allowsFeature("camera") : null;
  } catch { /* Some browsers expose no usable policy-query API. */ }
  return { secure: window.isSecureContext, available: Boolean(navigator.mediaDevices?.getUserMedia), embedded: window.self !== window.top, cameraAllowed };
}

export function assertCameraEnvironment(environment: CameraEnvironment) {
  if (!environment.secure) throw new MediaInputError("CAMERA_INSECURE", "カメラはHTTPSのサイト、またはlocalhostで開いてください。");
  if (!environment.available) throw new MediaInputError("CAMERA_UNAVAILABLE", "この画面ではカメラAPIを利用できません。サイトを通常のブラウザで開いてください。");
  if (environment.cameraAllowed === false) throw new MediaInputError("CAMERA_POLICY_BLOCKED", "この埋め込み画面ではカメラの利用が制限されています。「サイトを別タブで開く」から開き、カメラの許可を確認してください。");
}

export function inputError(error: unknown): { code: string; message: string } {
  if (error instanceof MediaInputError) return { code: error.code, message: error.message };
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return { code: "CAMERA_PERMISSION_DENIED", message: "カメラの許可がありません。サイトとOSのカメラ設定を確認してください。埋め込み表示の場合は別タブで開いて試してください。" };
  if (name === "NotFoundError") return { code: "CAMERA_NOT_FOUND", message: "カメラが見つかりません。接続、または使用するカメラを確認してください。" };
  if (name === "NotReadableError") return { code: "CAMERA_BUSY", message: "カメラを開けません。他のアプリで使用中でないか、OS側で許可されているか確認してください。" };
  if (name === "OverconstrainedError") return { code: "CAMERA_CONSTRAINTS", message: "選択したカメラの設定を利用できません。カメラの選択を変更してください。" };
  return { code: name || "INPUT_ERROR", message: error instanceof Error ? error.message : String(error) };
}

const aborted = () => new DOMException("入力の開始を取り消しました", "AbortError");

export async function openCameraStream(
  request: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  options: { signal: AbortSignal; deviceId?: string; timeoutMs?: number },
) {
  const { signal, deviceId } = options;
  if (signal.aborted) throw aborted();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => undefined;
  const preferred: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "user" } }) };
  const pending = (async () => {
    let stream: MediaStream;
    try { stream = await request({ video: preferred, audio: false }); }
    catch (error) {
      if (signal.aborted || expired) throw aborted();
      // Never retry a permission denial, and never silently switch away from an
      // explicitly chosen device. Only relax optional capture constraints.
      if (!error || typeof error !== "object" || !("name" in error) || error.name !== "OverconstrainedError") throw error;
      stream = await request({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
    }
    if (expired || signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      throw aborted();
    }
    return stream;
  })();
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { expired = true; reject(new MediaInputError("CAMERA_PERMISSION_TIMEOUT", "カメラの許可待ちが長いため停止しました。許可を確認して、もう一度開始してください。")); }, options.timeoutMs ?? 25000);
      if (signal.aborted) onAbort();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function waitForPlayableVideo(video: HTMLVideoElement, signal: AbortSignal, timeoutMs = 12000) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let played = false;
    let timer: ReturnType<typeof setTimeout>;
    let poll: ReturnType<typeof setInterval>;
    const clean = () => { clearTimeout(timer); clearInterval(poll); signal.removeEventListener("abort", cancel); video.removeEventListener("error", failed); };
    const finish = (error?: Error) => { if (settled) return; settled = true; clean(); if (error) reject(error); else resolve(); };
    const cancel = () => finish(aborted());
    const failed = () => finish(new MediaInputError("VIDEO_DECODE_ERROR", `入力映像を再生できませんでした（media code ${video.error?.code ?? 0}）。`));
    const ready = () => { if (played && !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish(); };
    timer = setTimeout(() => finish(new MediaInputError("VIDEO_START_TIMEOUT", "カメラは取得しましたが映像が届きません。使用するカメラ、OSの許可、他のアプリとの競合を確認してください。")), timeoutMs);
    poll = setInterval(ready, 50);
    signal.addEventListener("abort", cancel, { once: true });
    video.addEventListener("error", failed, { once: true });
    if (signal.aborted) { cancel(); return; }
    video.muted = true;
    video.playsInline = true;
    void video.play().then(() => { played = true; ready(); }, error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export type FrameClock = "video-callback" | "playback-clock";

// Some live MediaStreams play normally but fail to dispatch rVFC. A bounded
// watchdog samples their advancing playback clock instead. LatestFrameGate
// still rejects duplicate frames and keeps the entire pipeline single-flight.
export function startVideoFramePump(video: HTMLVideoElement, onFrame: (now: number, mediaTime: number, mode: FrameClock) => void) {
  let stopped = false;
  let callbackId: number | null = null;
  let lastCallbackAt = performance.now();
  const sample = (now: number, time: number, mode: FrameClock) => {
    if (!stopped && !video.paused && !video.ended && !video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) onFrame(now, time, mode);
  };
  const schedule = () => {
    if (stopped || typeof video.requestVideoFrameCallback !== "function") return;
    callbackId = video.requestVideoFrameCallback((_now, metadata) => {
      lastCallbackAt = performance.now();
      sample(lastCallbackAt, metadata.mediaTime, "video-callback");
      schedule();
    });
  };
  schedule();
  const timer = setInterval(() => {
    const now = performance.now();
    if (typeof video.requestVideoFrameCallback !== "function" || now - lastCallbackAt > 500) sample(now, video.currentTime, "playback-clock");
  }, 33);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
  };
}

// Draw from the decoder into a reusable canvas before bitmap conversion.
// This also works on browsers that reject createImageBitmap(video) for a live
// MediaStream. There is never a mirrored analysis frame: mirror is UI-only.
export function createInputFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  if (video.readyState < 2 || video.seeking || video.videoWidth < 1 || video.videoHeight < 1) throw new MediaInputError("VIDEO_FRAME_NOT_READY", "入力映像のフレームがまだ届いていません。");
  const ratio = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * ratio));
  const height = Math.max(1, Math.round(video.videoHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new MediaInputError("VIDEO_CANVAS_UNAVAILABLE", "入力映像のキャンバスを作れませんでした。");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(video, 0, 0, width, height);
  return createImageBitmap(canvas);
}
