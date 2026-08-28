export function canStartFaithfulCapture(
  capturing: boolean,
  draining: boolean,
) {
  return !capturing && !draining;
}

export function canProcessFaithfulQueue(
  hasLandmarker: boolean,
  candidateCount: number,
) {
  return hasLandmarker && candidateCount >= 4;
}
