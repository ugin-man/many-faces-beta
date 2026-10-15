import { createStableLandmarker } from "../app/live/stable-landmarker";
import { catalogFeatureFromResult } from "../app/catalog-feature";
import { faceGeometryFromLandmarks } from "../app/offline-matching";
import { winkEvidence } from "../app/live/wink-evidence";

export async function inspectWinkUrls(rows: Array<{ id: string; url: string }>) {
  const engine = await createStableLandmarker('IMAGE', () => undefined);
  const output = [];
  try {
    for (const row of rows) {
      const image = new Image(); image.src = row.url; await image.decode();
      const result = engine.detect(image), points = result.faceLandmarks[0];
      const geometry = points && faceGeometryFromLandmarks(points, image.width / image.height);
      const feature = geometry && result.faceBlendshapes.length ? catalogFeatureFromResult(result) : null;
      output.push({ id: row.id, evidence: feature && geometry ? winkEvidence(feature, geometry.projection) : null });
    }
    return output;
  } finally { engine.close(); }
}
export { winkEvidence };
