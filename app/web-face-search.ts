export type SearchFrame = { feature: number[] };

function valueAt(feature: number[], index: number) {
  return Math.max(0, Math.min(1, Number(feature[index] ?? 0)));
}

function frameQuery(frame: SearchFrame) {
  const feature = frame.feature;
  const yaw = Number(feature[0] ?? 0) * 90;
  const pitch = Number(feature[1] ?? 0) * 90;
  const smile = (valueAt(feature, 7) + valueAt(feature, 8)) / 2;
  const frown = Math.max(
    (valueAt(feature, 9) + valueAt(feature, 10)) / 2,
    (valueAt(feature, 18) + valueAt(feature, 19)) / 2,
  );
  const mouthOpen = Math.max(valueAt(feature, 3), valueAt(feature, 5) * 0.45);
  const browUp = (valueAt(feature, 17) + valueAt(feature, 20) + valueAt(feature, 21)) / 3;

  let pose = "front view";
  if (yaw <= -18) pose = "left side profile";
  else if (yaw >= 18) pose = "right side profile";
  else if (yaw <= -7) pose = "left three quarter view";
  else if (yaw >= 7) pose = "right three quarter view";
  if (pitch >= 9) pose += " looking up";
  else if (pitch <= -9) pose += " looking down";

  let expression = "neutral";
  if (mouthOpen > 0.36 && browUp > 0.16) expression = "surprised";
  else if (smile > 0.3 && mouthOpen > 0.28) expression = "laughing";
  else if (smile > 0.22) expression = "smiling";
  else if (frown > 0.18) expression = "frowning";
  else if (mouthOpen > 0.28) expression = "mouth open";
  return `${expression} ${pose} face portrait`;
}

function representativeFrames(frames: SearchFrame[]) {
  if (frames.length <= 10) return frames;
  const indexes = new Set<number>([
    0,
    frames.length - 1,
    Math.floor(frames.length * 0.25),
    Math.floor(frames.length * 0.5),
    Math.floor(frames.length * 0.75),
  ]);
  const dimensions = [0, 1, 3, 7, 9, 17];
  for (const dimension of dimensions) {
    let minimum = 0;
    let maximum = 0;
    for (let index = 1; index < frames.length; index += 1) {
      if ((frames[index].feature[dimension] ?? 0) < (frames[minimum].feature[dimension] ?? 0)) {
        minimum = index;
      }
      if ((frames[index].feature[dimension] ?? 0) > (frames[maximum].feature[dimension] ?? 0)) {
        maximum = index;
      }
    }
    indexes.add(minimum);
    indexes.add(maximum);
  }
  return [...indexes].sort((a, b) => a - b).map((index) => frames[index]);
}

export function buildFaceSearchQueries(frames: SearchFrame[]) {
  const generic = [
    "close up face portrait person",
    "headshot portrait person",
    "human face front view portrait",
  ];
  const derived = representativeFrames(frames).map(frameQuery);
  // Broad searches run first: the local mesh score, not keyword ranking, decides
  // the final match. Detailed observed poses still add useful long-tail results.
  return [...new Set([...generic, ...derived])].slice(0, 14);
}

export function roundRobinSearchPlan(queries: string[], target: number, pageSize: number) {
  if (!queries.length || target <= 0 || pageSize <= 0) return [];
  const requests = Math.ceil(target / pageSize);
  return Array.from({ length: requests }, (_, index) => ({
    query: queries[index % queries.length],
    page: Math.floor(index / queries.length) + 1,
    limit: pageSize,
  }));
}
