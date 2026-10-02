import { catalogPoseFromWebMatrix } from "./catalog-pose.ts";
import { faceFeatureFromScores } from "./face-actions.ts";

type FeatureResult = {
  facialTransformationMatrixes: Array<{ data: ArrayLike<number> }>;
  faceBlendshapes: Array<{ categories: Array<{ categoryName: string; score: number }> }>;
};

/** Use the same absolute pose and action values as the stored photograph catalog.
 * A source-only resting-face subtraction changes the matching coordinates and
 * erases sustained expressions. Presentation mirroring never enters this path.
 */
export function catalogFeatureFromResult(result: FeatureResult): number[] {
  const pose = catalogPoseFromWebMatrix(result.facialTransformationMatrixes[0]?.data) ?? [0, 0, 0];
  const scores = new Map((result.faceBlendshapes[0]?.categories ?? []).map(category => [category.categoryName, category.score]));
  return faceFeatureFromScores(pose, scores);
}
