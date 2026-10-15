import type { FaceGeometry, SequenceFrame } from "../offline-matching.ts";
import { reviewIndexAtTime } from "./review-timeline.ts";

export function shortestAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function screenRoll(geometry: FaceGeometry, feature?: readonly number[]) {
  if (Number.isFinite(geometry.roll)) return geometry.roll!;
  // Catalog matrices use Y-up, whereas Canvas and the measured eye axis use Y-down.
  return Number.isFinite(feature?.[2]) ? -feature![2] * Math.PI / 2 : 0;
}

type Choice = { frame: SequenceFrame; candidate: { geometry: FaceGeometry; feature: number[] } };

/** Keep photo identity discrete while evaluating placement at the actual video time.
 * Never extrapolate across missing detections. Only short, bounded gaps qualify.
 * The caller additionally blocks every interval rejected by the pose audit.
 */
export function motionChoiceAtTime<T extends Choice>(
  items: readonly { time: number; choice: T }[], time: number, fps: number,
): T | null {
  if (!Number.isFinite(time) || !items.length || time < items[0].time - 1e-6) return null;
  const index = reviewIndexAtTime(items, time);
  const left = items[index], right = items[index + 1];
  if (Math.abs(time - left.time) < 1e-6) return left.choice;
  const step = 1 / Math.max(1, fps);
  if (!right) return time - left.time <= step + 1e-6 ? left.choice : null;
  const gap = right.time - left.time;
  if (gap <= 0 || gap > Math.max(step * 1.5, 0.101)) return null;
  const a = left.choice.frame, b = right.choice.frame;
  const x = a.geometry.layout, y = b.geometry.layout;
  if (![...x, ...y].every(Number.isFinite) || Math.min(x[2], x[3], y[2], y[3]) <= 0) return null;
  const missing = gap > step * 1.5;
  const angle = shortestAngle(screenRoll(b.geometry, b.feature) - screenRoll(a.geometry, a.feature));
  const movement = Math.hypot((y[0] - x[0]) / Math.min(x[2], y[2]), (y[1] - x[1]) / Math.min(x[3], y[3]));
  const sizeRatio = Math.max(x[2] / y[2], y[2] / x[2], x[3] / y[3], y[3] / x[3]);
  const poseJump = Math.max(Math.abs(a.feature[0] - b.feature[0]), Math.abs(a.feature[1] - b.feature[1])) * 90;
  if (!Number.isFinite(poseJump) || movement > (missing ? .35 : 1) ||
      sizeRatio > (missing ? 1.25 : 1.6) || Math.abs(angle) > (missing ? 15 : 45) * Math.PI / 180 ||
      poseJump > (missing ? 15 : 45)) return null;
  const alpha = (time - left.time) / gap;
  const layout = x.map((v, i) => v + (y[i] - v) * alpha) as FaceGeometry["layout"];
  const loX = Math.min(x[0] - x[2] / 2, y[0] - y[2] / 2);
  const hiX = Math.max(x[0] + x[2] / 2, y[0] + y[2] / 2);
  const loY = Math.min(x[1] - x[3] / 2, y[1] - y[3] / 2);
  const hiY = Math.max(x[1] + x[3] / 2, y[1] + y[3] / 2);
  return { ...left.choice, frame: { ...a, time, geometry: { ...a.geometry, layout,
    roll: screenRoll(a.geometry, a.feature) + angle * alpha,
    protectionLayout: [(loX + hiX) / 2, (loY + hiY) / 2, hiX - loX, hiY - loY],
  } } };
}
