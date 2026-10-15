type PoseFrame = { time: number; feature: readonly number[] };

export type UncertainProfileInterval = {
  start: number;
  end: number;
  anchorTime: number;
  rejectedTimes: number[];
};

/**
 * A near-profile can fool the landmarker into fitting the opposite side of the
 * face. In an offline clip we can check both neighbours before selecting photos.
 * Treat a short opposite-profile island with no observed frontal transition,
 * or a collapsed profile accompanied by a large roll jump, as uncertain.
 * Never relabel its yaw while retaining the unreliable face mesh.
 */
export function filterVideoProfileIslands<T extends PoseFrame>(frames: readonly T[], fps: number) {
  const rejected = new Set<number>();
  const intervals: UncertainProfileInterval[] = [];
  const yaw = (index: number) => frames[index].feature[0] * 90;
  const roll = (index: number) => frames[index].feature[2] * 90;
  const step = 1 / Math.max(1, fps);
  for (let index = 1; index < frames.length - 1; index++) {
    if (rejected.has(index - 1)) continue;
    const anchor = frames[index - 1], direction = Math.sign(yaw(index - 1));
    if (!Number.isFinite(yaw(index - 1)) || !Number.isFinite(yaw(index))) continue;
    if (Math.abs(yaw(index - 1)) < 30) continue;
    const collapsed = (cursor: number) => yaw(cursor) * direction < 20 &&
      Math.abs(roll(cursor) - roll(index - 1)) >= 30;
    const opposite = (cursor: number, threshold: number) => yaw(cursor) * direction <= -threshold;
    if (!opposite(index, 30) && !collapsed(index)) continue;
    let end = index;
    while (end < frames.length && frames[end].time - anchor.time <= 1.25 &&
      (opposite(end, 20) || collapsed(end))) end++;
    if (end === frames.length || frames[end].time - anchor.time > 1.25 ||
      !Number.isFinite(yaw(end)) || yaw(end) * direction < 30) continue;
    const rejectedTimes = frames.slice(index, end).map(frame => frame.time);
    for (let cursor = index; cursor < end; cursor++) rejected.add(cursor);
    intervals.push({ start: anchor.time + step, end: frames[end].time, anchorTime: anchor.time, rejectedTimes });
    index = end;
  }
  return { frames: frames.filter((_, index) => !rejected.has(index)), intervals };
}

export function uncertainProfileAtTime<T extends UncertainProfileInterval>(intervals: readonly T[], time: number): T | undefined {
  return intervals.find(interval => time + 1e-7 >= interval.start && time < interval.end - 1e-7);
}
