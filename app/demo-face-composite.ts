import { alignmentTransform, objectFitCoverLayout, type FaceGeometry } from "./offline-matching.ts";

export type DemoFrame = { time: number; geometry: FaceGeometry };
export type DemoCandidate = { geometry: FaceGeometry };
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
  options: { time: number; fps: number; sourceAspectRatio: number; mirror?: boolean },
): boolean {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return false;
  const { width, height } = canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = DEMO_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  if (options.mirror) { ctx.translate(width, 0); ctx.scale(-1, 1); }

  if (!video || !replacement || !choice ||
      !demoFrameIsSafe(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking,
        video.currentTime, options.time, choice.frame.time, options.fps) ||
      !video.videoWidth || !video.videoHeight) {
    ctx.restore();
    return false;
  }

  const target = objectFitCoverLayout(choice.frame.geometry.layout, options.sourceAspectRatio);
  const targetMask = demoMaskGeometry(target);
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
  if (!lctx) { ctx.restore(); return false; }
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
  ctx.translate(width / 2 + transform.xPercent * width / 100,
    height / 2 + transform.yPercent * height / 100);
  ctx.scale(transform.scale, transform.scale);
  ctx.drawImage(layer, -width / 2, -height / 2);
  ctx.restore();
  return true;
}
