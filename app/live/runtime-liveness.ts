export type RuntimeReadiness = "loading" | "ready" | "failed";

export const PREPARATION_TIMEOUT_MS = 45_000;
export const OPERATION_STALL_TIMEOUT_MS = 90_000;

export function preparationFailureReason(
  model: RuntimeReadiness,
  manifest: RuntimeReadiness,
  elapsedMs: number,
  timeoutMs = PREPARATION_TIMEOUT_MS,
) {
  if (manifest === "failed") {
    return "顔カタログを読み込めませんでした";
  }
  if (model === "failed") {
    return "顔解析モデルを読み込めませんでした";
  }
  if (Math.max(0, elapsedMs) >= Math.max(1, timeoutMs)) {
    return `解析準備が${Math.ceil(timeoutMs / 1_000)}秒以内に完了しませんでした`;
  }
  return null;
}

export function operationIsStalled(
  busy: boolean,
  now: number,
  lastProgressAt: number,
  timeoutMs = OPERATION_STALL_TIMEOUT_MS,
) {
  if (!busy) return false;
  if (!Number.isFinite(now) || !Number.isFinite(lastProgressAt)) return true;
  return now - lastProgressAt >= Math.max(1, timeoutMs);
}

export function progressSignature(
  phase: string,
  progress?: { done: number; total: number; label: string } | null,
) {
  return [
    phase,
    progress?.label ?? "",
    Number(progress?.done ?? 0),
    Number(progress?.total ?? 0),
  ].join("|");
}
