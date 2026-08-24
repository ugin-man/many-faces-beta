let running = false;
let reader = null;

self.onmessage = async (event) => {
  if (event.data?.type === "stop") {
    running = false;
    try { await reader?.cancel(); } catch {}
    reader = null;
    return;
  }
  if (event.data?.type !== "start" || !event.data.track) return;

  running = true;
  const track = event.data.track;
  const size = Math.max(192, Math.min(720, Number(event.data.size || 384)));
  const quality = Math.max(0.5, Math.min(1, Number(event.data.quality || 0.9)));
  try {
    if (typeof MediaStreamTrackProcessor === "undefined" || typeof OffscreenCanvas === "undefined") {
      throw new Error("TRACK_PROCESSOR_UNAVAILABLE");
    }
    const processor = new MediaStreamTrackProcessor({ track });
    reader = processor.readable.getReader();
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("OFFSCREEN_CANVAS_UNAVAILABLE");

    while (running) {
      const result = await reader.read();
      if (result.done || !result.value) break;
      const frame = result.value;
      try {
        const width = frame.displayWidth || frame.codedWidth || size;
        const height = frame.displayHeight || frame.codedHeight || size;
        const side = Math.min(width, height);
        const sx = Math.max(0, (width - side) / 2);
        const sy = Math.max(0, (height - side) / 2);
        context.drawImage(frame, sx, sy, side, side, 0, 0, size, size);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
        self.postMessage({
          type: "frame",
          blob,
          timestamp: Number(frame.timestamp || 0) / 1_000_000,
        });
      } finally {
        frame.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.message || error) });
  } finally {
    try { track.stop(); } catch {}
    try { reader?.releaseLock(); } catch {}
    reader = null;
    running = false;
    self.postMessage({ type: "stopped" });
  }
};
