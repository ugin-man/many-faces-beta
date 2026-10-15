import { alignmentTransform, objectFitCoverLayout, type FaceGeometry } from "./offline-matching.ts";
import { screenRoll, shortestAngle } from "./live/video-motion.ts";

export type DemoFrame = { time: number; geometry: FaceGeometry; feature?: number[] };
export type DemoCandidate = { geometry: FaceGeometry; feature?: number[] };
export type DemoChoice = { frame: DemoFrame; candidate: DemoCandidate };

export const DEMO_BACKGROUND = "#0a0c10";

/** Fail closed on missing/stale detections rather than revealing an unmasked source face. */
export function demoFrameIsSafe(
  videoReady: boolean,
  videoTime: number,
  requestedTime: number,
  detectedTime: number,
  fps: number,
): boolean {
  const tolerance = Math.min(0.13, 1.6 / Math.max(1, fps));
  return videoReady && Number.isFinite(videoTime) && Number.isFinite(detectedTime) &&
    Math.abs(videoTime - requestedTime) <= tolerance &&
    Math.abs(detectedTime - requestedTime) <= tolerance;
}

export function demoMaskGeometry(layout: FaceGeometry["layout"]) {
  const [x, y, width, height] = layout;
  return {
    cx: x, cy: y,
    coverRx: Math.max(0.13, width * 0.86),
    coverRy: Math.max(0.18, height * 0.86),
    imageRx: Math.max(0.09, width * 0.66),
    imageRy: Math.max(0.12, height * 0.66),
  };
}

function drawCover(ctx: CanvasRenderingContext2D, image: CanvasImageSource, iw: number, ih: number, width: number, height: number) {
  const scale = Math.max(width / iw, height / ih);
  const w = iw * scale, h = ih * scale;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

const layers = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
const lastSafeComposites = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

/** Drop a previous recording's protected frame before loading a different input. */
export function resetDemoFaceComposite(canvas: HTMLCanvasElement | null) {
  if (canvas) lastSafeComposites.delete(canvas);
}

/** The fallback never draws the source video, even when tracking or decoding fails. */
function drawProtectedFallback(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
  prepared?: HTMLCanvasElement, mirror = false) {
  const retained = prepared ?? lastSafeComposites.get(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (retained && retained.width === canvas.width && retained.height === canvas.height) {
    // Prepared frames are stored unmirrored; the ordinary playback cache already
    // contains the complete presentation transform.
    if (prepared && mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(retained, 0, 0);
    return;
  }
  // Neutral privacy slate only before the first safe composited frame.
  ctx.fillStyle = "#29313b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `${Math.max(16, Math.round(canvas.width * .025))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("顔を保護しています", canvas.width / 2, canvas.height / 2);
}

function rememberProtectedFrame(canvas: HTMLCanvasElement) {
  let saved = lastSafeComposites.get(canvas);
  if (!saved) {
    saved = document.createElement("canvas");
    lastSafeComposites.set(canvas, saved);
  }
  if (saved.width !== canvas.width || saved.height !== canvas.height) {
    saved.width = canvas.width;
    saved.height = canvas.height;
  }
  const context = saved.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(canvas, 0, 0);
}

/**
 * Demo-only composite. Never display source pixels if a matching detected face,
 * decoded source frame, or replacement photograph is missing.
 * This is a privacy aid, not certified anonymization.
 */
export function drawDemoFaceComposite(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement | null,
  replacement: (CanvasImageSource & { width: number; height: number }) | undefined,
  choice: DemoChoice | null,
  options: { time: number; fps: number; sourceAspectRatio: number; mirror?: boolean; protectedFrame?: HTMLCanvasElement },
): boolean {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return false;
  const { width, height } = canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = DEMO_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  if (options.mirror) { ctx.translate(width, 0); ctx.scale(-1, 1); }

  if (options.protectedFrame) {
    drawProtectedFallback(canvas, ctx, options.protectedFrame, options.mirror);
    ctx.restore();
    return false;
  }

  if (!video || !replacement || !choice ||
      !demoFrameIsSafe(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking,
        video.currentTime, options.time, choice.frame.time, options.fps) ||
      !video.videoWidth || !video.videoHeight) {
    drawProtectedFallback(canvas, ctx);
    ctx.restore();
    return false;
  }

  try {
  const target = objectFitCoverLayout(choice.frame.geometry.layout, options.sourceAspectRatio);
  const cover = objectFitCoverLayout(choice.frame.geometry.protectionLayout ?? choice.frame.geometry.layout, options.sourceAspectRatio);
  const targetMask = demoMaskGeometry(cover);
  drawCover(ctx, video, video.videoWidth, video.videoHeight, width, height);

  // Opaque backing must extend beyond the feathered replacement boundary.
  // A fade directly over the source video would expose the original face.
  ctx.fillStyle = DEMO_BACKGROUND;
  ctx.beginPath();
  ctx.ellipse(targetMask.cx * width, targetMask.cy * height,
    targetMask.coverRx * width, targetMask.coverRy * height, 0, 0, Math.PI * 2);
  ctx.fill();

  let layer = layers.get(canvas);
  if (!layer) { layer = document.createElement("canvas"); layers.set(canvas, layer); }
  if (layer.width !== width || layer.height !== height) { layer.width = width; layer.height = height; }
  const lctx = layer.getContext("2d");
  if (!lctx) { drawProtectedFallback(canvas, ctx); ctx.restore(); return false; }
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = "source-over";
  lctx.clearRect(0, 0, width, height);
  drawCover(lctx, replacement, replacement.width, replacement.height, width, height);

  const sourceMask = demoMaskGeometry(choice.candidate.geometry.layout);
  lctx.globalCompositeOperation = "destination-in";
  lctx.save();
  lctx.translate(sourceMask.cx * width, sourceMask.cy * height);
  lctx.scale(sourceMask.imageRx * width, sourceMask.imageRy * height);
  const feather = lctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  feather.addColorStop(0, "rgba(0,0,0,1)");
  feather.addColorStop(0.79, "rgba(0,0,0,1)");
  feather.addColorStop(1, "rgba(0,0,0,0)");
  lctx.fillStyle = feather;
  lctx.beginPath();
  lctx.arc(0, 0, 1, 0, Math.PI * 2);
  lctx.fill();
  lctx.restore();
  lctx.globalCompositeOperation = "source-over";

  const transform = alignmentTransform(choice.candidate.geometry, target);
  const rotation = shortestAngle(screenRoll(choice.frame.geometry, choice.frame.feature) -
    screenRoll(choice.candidate.geometry, choice.candidate.feature));
  ctx.translate(target[0] * width, target[1] * height);
  if (rotation) ctx.rotate(rotation);
  ctx.scale(transform.scale, transform.scale);
  ctx.translate(-sourceMask.cx * width, -sourceMask.cy * height);
  // Rotate the opaque backing with the photograph too. Keep the conservative
  // axis-aligned source cover above: rotating it alone could uncover a corner.
  ctx.fillStyle = DEMO_BACKGROUND;
  ctx.beginPath();
  ctx.ellipse(sourceMask.cx * width, sourceMask.cy * height,
    sourceMask.coverRx * width, sourceMask.coverRy * height, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
  rememberProtectedFrame(canvas);
  return true;
  } catch {
    // A decode/canvas/transform exception must never leave an uncovered source frame.
    drawProtectedFallback(canvas, ctx);
    ctx.restore();
    return false;
  }
}
