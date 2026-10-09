import { createStableLandmarker } from "../app/live/stable-landmarker";
import { catalogFeatureFromResult } from "../app/catalog-feature";
import { faceGeometryFromLandmarks } from "../app/offline-matching";
import { winkEvidence } from "../app/live/wink-evidence";

export async function checkWinkWinners() {
  const payload = await (await fetch('/__wink_eval/cases.json')).json();
  const engine = await createStableLandmarker('IMAGE', () => undefined);
  const fresh: Record<string, unknown> = {};
  try {
    for (const [id, file] of Object.entries(payload.files)) {
      const image = new Image(); image.src = `/__wink_eval/${file}`; await image.decode();
      const result = engine.detect(image), points = result.faceLandmarks[0];
      const geometry = points && faceGeometryFromLandmarks(points, image.width / image.height);
      const feature = geometry && result.faceBlendshapes.length ? catalogFeatureFromResult(result) : null;
      fresh[id] = feature && geometry ? { feature, evidence: winkEvidence(feature, geometry.projection) } : null;
    }
    return { fresh, cases: payload.cases };
  } finally { engine.close(); }
}
