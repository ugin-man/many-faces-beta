import { FACE_ACTION_FEATURE_INDEX as I } from "../face-actions.ts";
import type { NumericVector } from "../offline-matching.ts";

export type WinkSide = "left" | "right";
export type WinkEvidence = { side: WinkSide; leftBlink: number; rightBlink: number; leftAperture: number; rightAperture: number };

/** Anatomical left/right, not viewer left/right. A blendshape value is not a
 * calibrated confidence probability. Keep the raw values and corroborate an
 * asymmetric action with an actually asymmetric eyelid opening. This remains
 * a provisional automatic screen, not a human-verified expression label.
 */
export function winkEvidence(feature: readonly number[], projection: NumericVector): WinkEvidence | null {
  if (feature.length <= Math.max(I.eyeBlinkLeft, I.eyeBlinkRight) || projection.length < 936) return null;
  const leftBlink = feature[I.eyeBlinkLeft], rightBlink = feature[I.eyeBlinkRight];
  if (![leftBlink, rightBlink, feature[0], feature[1]].every(Number.isFinite)) return null;
  if (Math.abs(feature[0] * 90) > 30 || Math.abs(feature[1] * 90) > 30) return null;
  const side: WinkSide = leftBlink > rightBlink ? "left" : "right";
  const high = Math.max(leftBlink, rightBlink), low = Math.min(leftBlink, rightBlink);
  if (high < 0.35 || low > 0.40 || high - low < 0.18) return null;
  const distance = (a: number, b: number) => Math.hypot(projection[a * 2] - projection[b * 2], projection[a * 2 + 1] - projection[b * 2 + 1]);
  const leftWidth = distance(362, 263), rightWidth = distance(33, 133);
  if (leftWidth < 0.04 || rightWidth < 0.04) return null;
  const leftAperture = distance(386, 374) / leftWidth;
  const rightAperture = distance(159, 145) / rightWidth;
  if (![leftAperture, rightAperture].every(Number.isFinite)) return null;
  const closed = side === "left" ? leftAperture : rightAperture;
  const open = side === "left" ? rightAperture : leftAperture;
  if (closed > 0.15 || open < 0.18 || closed > open * 0.65) return null;
  return { side, leftBlink, rightBlink, leftAperture, rightAperture };
}
