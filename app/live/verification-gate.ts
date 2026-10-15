export type VerificationGateInput = {
  plannedFrames: number;
  faceFrames: number;
  sequenceFrames: number;
  selectedImages: number;
  imageFailures: number;
  outputChanges: number;
  canvasNonBlank: boolean;
};

export type VerificationGateResult = {
  passed: boolean;
  faceCoverage: number;
  reasons: string[];
};

/** Runtime integrity only. This does NOT certify expression/pose similarity. */
export function evaluateVerificationGate(input: VerificationGateInput): VerificationGateResult {
  const reasons: string[] = [];
  const counters = [input.plannedFrames, input.faceFrames, input.sequenceFrames, input.selectedImages, input.imageFailures, input.outputChanges];
  if (!counters.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { passed: false, faceCoverage: 0, reasons: ["検証値に無効な数値があります"] };
  }
  const { plannedFrames, faceFrames, sequenceFrames, selectedImages, imageFailures, outputChanges } = input;
  const faceCoverage = plannedFrames > 0 ? faceFrames / plannedFrames : 0;
  if (plannedFrames < 2) reasons.push("解析対象フレームが不足しています");
  if (faceFrames < 2) reasons.push("顔を検出できたフレームが不足しています");
  if (faceFrames > plannedFrames) reasons.push("顔フレーム数が解析対象数を超えています");
  if (faceCoverage < 0.7) reasons.push(`顔検出率が低すぎます (${(faceCoverage * 100).toFixed(1)}%)`);
  if (sequenceFrames !== faceFrames) reasons.push(`経路フレーム数が一致しません (${sequenceFrames}/${faceFrames})`);
  if (selectedImages < 2 || selectedImages > sequenceFrames) reasons.push("採用画像数が不正です");
  if (imageFailures !== 0) reasons.push(`画像読み込み失敗があります (${imageFailures})`);
  if (outputChanges < 1 || outputChanges >= sequenceFrames || outputChanges < selectedImages - 1) reasons.push("出力の切り替え回数が不正です");
  if (input.canvasNonBlank !== true) reasons.push("出力キャンバスが空白です");
  return { passed: reasons.length === 0, faceCoverage, reasons };
}
