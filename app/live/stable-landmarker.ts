import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { readAssetBytes } from "./asset-reader";
export type EngineProgress = { stage: string; bytes: number };

/** One measured baseline engine: no second GPU/CPU graph inside a live frame. */
export async function createStableLandmarker(mode: "IMAGE" | "VIDEO", onProgress: (event: EngineProgress) => void, signal?: AbortSignal): Promise<FaceLandmarker> {
  let bytes = 0;
  const report = (stage: string, delta = 0) => { bytes += delta; onProgress({ stage, bytes }); };
  report("engine-import");
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  if (signal?.aborted) throw signal.reason;
  const fileset = await FilesetResolver.forVisionTasks(new URL("/api/mediapipe", location.origin).href);
  // Preload real bytes with progress. The model uses its byte buffer, and the
  // WASM binary is loaded from these bytes rather than fetched a second time.
  report("model-download");
  const model = await readAssetBytes(new URL("/api/mediapipe/face_landmarker.task", location.origin).href, { signal, onBytes: (_, delta) => report("model-download", delta) });
  report("wasm-download");
  const wasm = await readAssetBytes(fileset.wasmBinaryPath, { signal, onBytes: (_, delta) => report("wasm-download", delta) });
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
  try {
    report("engine-initialize");
    const engine = await FaceLandmarker.createFromOptions({ ...fileset, wasmBinaryPath: wasmUrl }, {
      baseOptions: { modelAssetBuffer: model, delegate: "CPU" },
      runningMode: mode, numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.45, minTrackingConfidence: 0.45,
    });
    if (signal?.aborted) { engine.close(); throw signal.reason; }
    report("engine-ready");
    return engine;
  } finally { URL.revokeObjectURL(wasmUrl); }
}
