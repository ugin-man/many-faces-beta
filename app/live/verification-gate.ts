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

function finite(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function evaluateVerificationGate(
  input: VerificationGateInput,
): VerificationGateResult {
  const plannedFrames = Math.max(0, Math.floor(finite(input.plannedFrames)));
  const faceFrames = Math.max(0, Math.floor(finite(input.faceFrames)));
  const sequenceFrames = Math.max(0, Math.floor(finite(input.sequenceFrames)));
  const selectedImages = Math.max(0, Math.floor(finite(input.selectedImages)));
  const imageFailures = Math.max(0, Math.floor(finite(input.imageFailures)));
  const faceCoverage = plannedFrames > 0 ? faceFrames / plannedFrames : 0;
  const reasons: string[] = [];

  if (plannedFrames < 2) reasons.push("解析対象フレームが不足しています");
  if (faceFrames < 2) reasons.push("顔を検出できたフレームが不足しています");
  if (faceCoverage < 0.7) {
    reasons.push(`顔検出率が低すぎます (${(faceCoverage * 100).toFixed(1)}%)`);
  }
  if (sequenceFrames !== faceFrames) {
    reasons.push(
      `経路フレーム数が一致しません (${sequenceFrames}/${faceFrames})`,
    );
  }
  if (selectedImages < 1) reasons.push("表示できる採用画像がありません");
  if (imageFailures > Math.max(2, Math.ceil(selectedImages * 0.1))) {
    reasons.push(`画像読み込み失敗が多すぎます (${imageFailures})`);
  }
  if (!input.canvasNonBlank) reasons.push("出力キャンバスが空白です");

  return {
    passed: reasons.length === 0,
    faceCoverage,
    reasons,
  };
}
