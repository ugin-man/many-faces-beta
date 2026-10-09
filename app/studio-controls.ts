export type StudioMode = "video" | "camera";
export type SwipePoint = { x: number; y: number; at: number };

// Only deliberate downward or left-edge gestures exit. Sliders and buttons
// never call this helper, and a slow drag is not an accidental dismissal.
export function shouldExitSwipe(start: SwipePoint, end: SwipePoint) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const elapsed = end.at - start.at;
  if (elapsed < 60 || elapsed > 1400) return false;
  return (dy > 120 && Math.abs(dx) < dy * 0.45) ||
    (start.x <= 28 && dx > 95 && Math.abs(dy) < dx * 0.45);
}

export function clipPlaybackTime(time: number, duration: number) {
  return Math.min(Math.max(0, Number.isFinite(time) ? time : 0), Math.max(0, duration));
}
export function timeLabel(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
