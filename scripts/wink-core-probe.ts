import { createStableLandmarker } from "../app/live/stable-landmarker";
import { catalogFeatureFromResult } from "../app/catalog-feature";
import { faceGeometryFromLandmarks } from "../app/offline-matching";
import { winkEvidence } from "../app/live/wink-evidence";

export async function reanalyzeCore() {
  const samples = await (await fetch('/__wink_core/samples.json')).json();
  const engine = await createStableLandmarker('IMAGE', () => undefined);
  const accepted = [], audit = [];
  try {
    for (const sample of samples) {
      try {
        const image = new Image(); image.src = `/__wink_core/${sample.file}`; await image.decode();
        const result = engine.detect(image), points = result.faceLandmarks[0];
        const geometry = points && faceGeometryFromLandmarks(points, image.width / image.height);
        const feature = geometry && result.faceBlendshapes.length ? catalogFeatureFromResult(result) : null;
        const evidence = feature && geometry && winkEvidence(feature, geometry.projection);
        audit.push({ id: sample.entry.id, storedSide: sample.storedSide, freshSide: evidence?.side ?? null, evidence });
        if (feature && geometry && evidence) accepted.push({ entry: sample.entry, imageSha256: sample.imageSha256, feature, geometry: { structure: Array.from(geometry.structure), surface: Array.from(geometry.surface), projection: Array.from(geometry.projection), layout: geometry.layout }, evidence });
      } catch (error) { audit.push({ id: sample.entry.id, error: String(error) }); }
    }
    return { accepted, audit };
  } finally { engine.close(); }
}
