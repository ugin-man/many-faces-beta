export type PitchLandmark = { x: number; y: number; z?: number };

export type LandmarkPitchTracker = {
  baseline: number | null;
  calibrationFrames: number;
  calibrationTotal: number;
  filteredRatio: number | null;
};

const CALIBRATION_FRAMES = 12;
const PITCH_SCALE_DEGREES = 720;
const PITCH_LIMIT_DEGREES = 24;
const POSE_STEP_DEGREES = 1.5;

export function createLandmarkPitchTracker(): LandmarkPitchTracker {
  return {
    baseline: null,
    calibrationFrames: 0,
    calibrationTotal: 0,
    filteredRatio: null,
  };
}

function meanPoint(landmarks: PitchLandmark[], indexes: number[]) {
  const total = indexes.reduce(
    (sum, index) => ({
      x: sum.x + landmarks[index].x,
      y: sum.y + landmarks[index].y,
    }),
    { x: 0, y: 0 },
  );
  return { x: total.x / indexes.length, y: total.y / indexes.length };
}

function landmarkRatio(landmarks: PitchLandmark[]) {
  if (landmarks.length <= 362) return null;
  const forehead = landmarks[10];
  const nose = landmarks[1];
  const upperLip = landmarks[13];
  const chin = landmarks[152];
  const eyes = meanPoint(landmarks, [33, 133, 362, 263]);
  if (!forehead || !nose || !upperLip || !chin) return null;

  // Project each point onto the forehead-to-chin axis so roll and lateral motion
  // cannot masquerade as pitch.
  const axisX = chin.x - forehead.x;
  const axisY = chin.y - forehead.y;
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength < 0.02) return null;
  const unitX = axisX / axisLength;
  const unitY = axisY / axisLength;
  const project = (point: PitchLandmark) =>
    (point.x - forehead.x) * unitX + (point.y - forehead.y) * unitY;

  const eyePosition = project(eyes);
  const nosePosition = project(nose);
  const lipPosition = project(upperLip);
  const chinPosition = project(chin);
  const eyeToChin = chinPosition - eyePosition;
  const eyeToLip = lipPosition - eyePosition;
  if (eyeToChin < 0.03 || eyeToLip < 0.015) return null;

  // The chin ratio has the largest pitch signal; the lip ratio reduces false
  // movement from opening the jaw.
  const chinRatio = (nosePosition - eyePosition) / eyeToChin;
  const lipRatio = (nosePosition - eyePosition) / eyeToLip;
  return chinRatio * 0.65 + lipRatio * 0.35;
}

export function landmarkPitchDegrees(
  landmarks: PitchLandmark[],
  tracker: LandmarkPitchTracker,
  sensitivity = 1,
) {
  const ratio = landmarkRatio(landmarks);
  if (ratio === null || !Number.isFinite(ratio)) return null;

  tracker.filteredRatio = tracker.filteredRatio === null
    ? ratio
    : tracker.filteredRatio * 0.55 + ratio * 0.45;

  if (tracker.calibrationFrames < CALIBRATION_FRAMES) {
    tracker.calibrationFrames += 1;
    tracker.calibrationTotal += tracker.filteredRatio;
    if (tracker.calibrationFrames === CALIBRATION_FRAMES) {
      tracker.baseline = tracker.calibrationTotal / CALIBRATION_FRAMES;
    }
    return 0;
  }

  const baseline = tracker.baseline ?? tracker.filteredRatio;
  const rawDegrees = -(tracker.filteredRatio - baseline) *
    PITCH_SCALE_DEGREES * sensitivity;
  const bounded = Math.max(
    -PITCH_LIMIT_DEGREES,
    Math.min(PITCH_LIMIT_DEGREES, rawDegrees),
  );
  const quantized = Math.round(bounded / POSE_STEP_DEGREES) * POSE_STEP_DEGREES;
  return Object.is(quantized, -0) ? 0 : quantized;
}
