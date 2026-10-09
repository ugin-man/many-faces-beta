import { alignmentTransform, objectFitCoverLayout, type FaceGeometry, type SequenceChoice } from "./offline-matching.ts";

export type FacePresentationOptions = { sourceAspectRatio: number; trackFace: boolean; faceOnly: boolean; background?: string };

export function facePresentationTransform(candidate: FaceGeometry, target: FaceGeometry, sourceAspectRatio: number, trackFace: boolean) {
  if (!trackFace) return { xPercent: 0, yPercent: 0, scale: 1 };
  return alignmentTransform(candidate, objectFitCoverLayout(target.layout, sourceAspectRatio));
}

export function faceMaskSpec(layout: FaceGeometry["layout"]) {
  const [centerX, centerY, width, height] = layout;
  return {
    centerX: Math.max(0.15, Math.min(0.85, centerX)),
    centerY: Math.max(0.15, Math.min(0.85, centerY)),
    radiusX: Math.max(0.19, Math.min(0.43, width * 0.52)),
    radiusY: Math.max(0.25, Math.min(0.49, height * 0.54)),
  };
}

const layerCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

function coverRect(canvas: HTMLCanvasElement, image: { width: number; height: number }) {
  const width = Math.max(1, image.width), height = Math.max(1, image.height);
  const scale = Math.max(canvas.width / width, canvas.height / height);
  const drawWidth = width * scale, drawHeight = height * scale;
  return { x: (canvas.width - drawWidth) / 2, y: (canvas.height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

function applyFaceMask(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, layout: FaceGeometry["layout"]) {
  const mask = faceMaskSpec(layout);
  context.save();
  context.globalCompositeOperation = "destination-in";
  context.translate(mask.centerX * canvas.width, mask.centerY * canvas.height);
  context.scale(mask.radiusX * canvas.width, mask.radiusY * canvas.height);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(0.70, "rgba(0,0,0,1)");
  gradient.addColorStop(0.82, "rgba(0,0,0,.92)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.beginPath(); context.arc(0, 0, 1, 0, Math.PI * 2); context.fill();
  context.restore();
  context.globalCompositeOperation = "source-over";
}

export function drawFacePresentation<T extends { geometry: FaceGeometry }>(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource & { width: number; height: number },
  choice: SequenceChoice<T>,
  options: FacePresentationOptions,
) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = options.background ?? "#0a0c10"; context.fillRect(0, 0, canvas.width, canvas.height);
  let layer = layerCache.get(canvas);
  if (!layer) { layer = document.createElement("canvas"); layerCache.set(canvas, layer); }
  if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
  const layerContext = layer.getContext("2d");
  if (!layerContext) { context.restore(); return; }
  layerContext.setTransform(1, 0, 0, 1, 0, 0);
  layerContext.globalCompositeOperation = "source-over";
  layerContext.clearRect(0, 0, layer.width, layer.height);
  const rect = coverRect(canvas, image);
  layerContext.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  if (options.faceOnly) applyFaceMask(layerContext, layer, choice.candidate.geometry.layout);
  const transform = facePresentationTransform(choice.candidate.geometry, choice.frame.geometry, options.sourceAspectRatio, options.trackFace);
  context.translate(canvas.width / 2 + transform.xPercent / 100 * canvas.width, canvas.height / 2 + transform.yPercent / 100 * canvas.height);
  context.scale(transform.scale, transform.scale);
  context.drawImage(layer, -canvas.width / 2, -canvas.height / 2);
  context.restore();
}