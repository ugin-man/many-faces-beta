/** Explicit overrides keep repeatable comparisons on the real upload path.
 * Defaults preserve independent-frame inference while using sequential decode.
 * Invalid query values never change the processing policy. */
export type ReviewProcessingOptions = {
  decoder: "auto" | "webcodecs" | "video-element";
  mode: "IMAGE" | "VIDEO";
  delegate: "CPU" | "GPU";
  execution: "auto" | "worker" | "main-thread";
};

export function reviewProcessingOptions(search = ""): ReviewProcessingOptions {
  const values = new URLSearchParams(search);
  const decoder = values.get("mfDecoder");
  const mode = values.get("mfFaceMode");
  const delegate = values.get("mfFaceDelegate");
  const execution = values.get("mfFaceExecution");
  return {
    decoder: decoder === "webcodecs" || decoder === "video-element" ? decoder : "auto",
    mode: mode === "VIDEO" ? "VIDEO" : "IMAGE",
    delegate: delegate === "GPU" ? "GPU" : "CPU",
    execution: execution === "worker" || execution === "main-thread" ? execution : "auto",
  };
}
