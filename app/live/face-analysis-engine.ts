import { createStableLandmarker, type EngineProgress } from "./stable-landmarker";
import type { ReviewAnalysisDelegate, ReviewAnalysisMode } from "./face-analysis-core.ts";

export async function createConfiguredReviewEngine(options: {
  mode: ReviewAnalysisMode; delegate: ReviewAnalysisDelegate; signal?: AbortSignal;
  origin?: string; moduleWasm?: boolean; onProgress?: (event: EngineProgress) => void;
}) {
  let stage = "";
  const progress = (event: EngineProgress) => { stage = event.stage; options.onProgress?.(event); };
  try {
    const engine = await createStableLandmarker(options.mode, progress, options.signal, { delegate: options.delegate, origin: options.origin, moduleWasm: options.moduleWasm });
    return { engine, delegate: options.delegate, fallbackReasons: [] as string[] };
  } catch (error) {
    if (options.signal?.aborted || options.delegate !== "GPU" || stage !== "engine-initialize") throw error;
    const reason = `GPU_INITIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    const engine = await createStableLandmarker(options.mode, progress, options.signal, { delegate: "CPU", origin: options.origin, moduleWasm: options.moduleWasm });
    return { engine, delegate: "CPU" as const, fallbackReasons: [reason] };
  }
}
