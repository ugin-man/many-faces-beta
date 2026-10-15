import { createStableLandmarker } from "../app/live/stable-landmarker";
import { catalogFeatureFromResult } from "../app/catalog-feature";
import { faceGeometryFromLandmarks } from "../app/offline-matching";
import { FACE_ACTION_FEATURE_INDEX as I } from "../app/face-actions";
import { winkEvidence } from "../app/live/wink-evidence";

export async function examine() {
  const engine = await createStableLandmarker("IMAGE", () => undefined);
  const analyze = (canvas: HTMLCanvasElement) => {
    const result = engine.detect(canvas), points = result.faceLandmarks[0];
    const geometry = points && faceGeometryFromLandmarks(points, canvas.width / canvas.height);
    if (!geometry || !result.faceBlendshapes.length) return null;
    const feature = catalogFeatureFromResult(result), evidence = winkEvidence(feature, geometry.projection);
    return { feature, geometry: { structure: Array.from(geometry.structure), surface: Array.from(geometry.surface), projection: Array.from(geometry.projection), layout: geometry.layout }, points, left: feature[I.eyeBlinkLeft], right: feature[I.eyeBlinkRight], evidence, side: evidence?.side ?? null };
  };
  const load = async (file: string) => {
    const image = new Image(); image.src = `/__wink_qa/${file}`; await image.decode();
    const canvas = document.createElement("canvas"), scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { image, canvas };
  };
  try {
    const current = await (await fetch('/__wink_qa/samples.json')).json(), rechecked = [];
    for (const sample of current) {
      const { canvas } = await load(sample.file), result = analyze(canvas);
      rechecked.push({ id: sample.id, expected: sample.side, stored: { left: sample.stored[I.eyeBlinkLeft], right: sample.stored[I.eyeBlinkRight] }, fresh: result && { left: result.left, right: result.right, evidence: result.evidence, side: result.side, yaw: result.feature[0] * 90, pitch: result.feature[1] * 90 } });
    }
    const sources = await (await fetch('/__wink_qa/commons-sources.json')).json(), candidates = [];
    for (const source of sources) {
      try {
        const { image, canvas } = await load(source.file), located = analyze(canvas);
        if (!located) { candidates.push({ source, rejected: 'No face on original' }); continue; }
        const xs = located.points.map(point => point.x), ys = located.points.map(point => point.y);
        const x0 = Math.min(...xs) * image.width, x1 = Math.max(...xs) * image.width;
        const y0 = Math.min(...ys) * image.height, y1 = Math.max(...ys) * image.height;
        const edge = Math.min(Math.max(x1 - x0, y1 - y0) * 1.38, image.width, image.height);
        if (edge < 180) { candidates.push({ source, rejected: 'Insufficient actual face pixels' }); continue; }
        const x = Math.max(0, Math.min(image.width - edge, (x0 + x1 - edge) / 2));
        const y = Math.max(0, Math.min(image.height - edge, (y0 + y1 - edge) / 2));
        const crop = document.createElement('canvas'); crop.width = crop.height = Math.min(512, Math.floor(edge));
        crop.getContext('2d')!.drawImage(image, x, y, edge, edge, 0, 0, crop.width, crop.height);
        const encoded = crop.toDataURL('image/webp', .92), rendered = new Image(); rendered.src = encoded; await rendered.decode();
        crop.getContext('2d')!.drawImage(rendered, 0, 0);
        const fresh = analyze(crop);
        candidates.push({ source, rejected: fresh?.side ? null : 'No corroborated asymmetric closure after crop', fresh: fresh && { ...fresh, points: undefined }, crop: { x, y, edge, width: crop.width }, imageData: fresh?.side ? encoded : undefined });
      } catch (error) { candidates.push({ source, rejected: String(error) }); }
    }
    return { rechecked, candidates };
  } finally { engine.close(); }
}
