export type TimedReviewItem = {
  time: number;
};

function finite(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function reviewIndexAtTime<T extends TimedReviewItem>(
  items: readonly T[],
  time: number,
) {
  if (!items.length) return -1;
  const target = finite(time);
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (finite(items[middle]?.time) <= target) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

export function reviewItemAtTime<T extends TimedReviewItem>(
  items: readonly T[],
  time: number,
) {
  const index = reviewIndexAtTime(items, time);
  return index >= 0 ? items[index] : null;
}

export function quantizeReviewTime(
  time: number,
  outputFps: number,
  duration = Number.POSITIVE_INFINITY,
) {
  const fps = Math.max(1, Math.min(60, finite(outputFps) || 12));
  const bounded = Math.max(0, Math.min(finite(time), finite(duration) || 0));
  return Math.floor(bounded * fps + 1e-7) / fps;
}

export function processingSecondsPerOutputSecond(
  processingMilliseconds: number,
  clipDurationSeconds: number,
) {
  const duration = Math.max(0, finite(clipDurationSeconds));
  if (!duration) return 0;
  return Math.max(0, finite(processingMilliseconds)) / 1_000 / duration;
}

export function sourceGapEstimate(
  previousSeconds: number | null,
  nextSeconds: number,
  expectedFps = 30,
) {
  if (previousSeconds === null) return 0;
  const expected = 1 / Math.max(1, finite(expectedFps) || 30);
  const gap = Math.max(0, finite(nextSeconds) - finite(previousSeconds));
  if (gap <= expected * 1.5) return 0;
  return Math.max(0, Math.round(gap / expected) - 1);
}
