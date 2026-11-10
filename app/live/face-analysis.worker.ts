/// <reference lib="webworker" />
import { runtimeIdentity } from "../runtime-identity";
import { createFrameAnalysisSession, type ReviewAnalysisMode, type ReviewAnalysisDelegate } from "./face-analysis-core.ts";
import { createConfiguredReviewEngine } from "./face-analysis-engine.ts";

type Input =
  | { type: "init"; mode: ReviewAnalysisMode; delegate: ReviewAnalysisDelegate; origin: string; build: string }
  | { type: "frame"; id: number; bitmap: ImageBitmap; time: number; build: string };
const scope = self as unknown as DedicatedWorkerGlobalScope;
let session: ReturnType<typeof createFrameAnalysisSession> | null = null;
let initializing = false;
let sequence = 0;
scope.onmessage = async (event: MessageEvent<Input>) => {
  const message = event.data;
  if (message.build !== runtimeIdentity.build) {
    if (message.type === "frame") message.bitmap.close();
    scope.postMessage({ type: "error", id: message.type === "frame" ? message.id : undefined, message: "BUILD_MISMATCH: 顔解析が古い版です", build: runtimeIdentity.build });
    return;
  }
  if (message.type === "init") {
    if (initializing || session) { scope.postMessage({ type: "error", message: "ANALYSIS_ALREADY_INITIALIZED", build: runtimeIdentity.build }); return; }
    initializing = true;
    try {
      const configured = await createConfiguredReviewEngine({
        mode: message.mode, delegate: message.delegate, origin: message.origin, moduleWasm: true,
        onProgress: event => scope.postMessage({ type: "progress", ...event, sequence: ++sequence, build: runtimeIdentity.build }),
      });
      session = createFrameAnalysisSession(configured.engine, message.mode, (width, height) => new OffscreenCanvas(width, height));
      scope.postMessage({ type: "ready", info: { mode: message.mode, delegate: configured.delegate, execution: "worker", fallbackReasons: configured.fallbackReasons }, build: runtimeIdentity.build });
    } catch (error) {
      scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error), build: runtimeIdentity.build });
    } finally { initializing = false; }
    return;
  }
  if (!session) {
    message.bitmap.close();
    scope.postMessage({ type: "error", id: message.id, message: "ANALYSIS_NOT_READY", build: runtimeIdentity.build });
    return;
  }
  try {
    const output = session.analyze(message.bitmap, message.time);
    scope.postMessage({ type: "result", id: message.id, ...output, build: runtimeIdentity.build });
  } catch (error) {
    // analyze always closes the transferred bitmap, including error paths.
    scope.postMessage({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error), build: runtimeIdentity.build });
  }
};
