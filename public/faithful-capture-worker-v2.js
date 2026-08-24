let running = false;
let reader = null;
let drainPromise = null;
let rawQueue = [];
let sequence = 0;
let encoded = 0;
let previousTimestamp = null;
let expectedIntervalMs = 1000 / 30;
let estimatedSourceDrops = 0;

function postStats() {
  self.postMessage({
    type: "stats",
    rawQueue: rawQueue.length,
    encoded,
    estimatedSourceDrops,
  });
}

async function resizedBitmap(frame, maxDimension) {
  const width = frame.displayWidth || frame.codedWidth || maxDimension;
  const height = frame.displayHeight || frame.codedHeight || maxDimension;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  try {
    return await createImageBitmap(frame, {
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: "high",
    });
  } catch {
    return createImageBitmap(frame);
  }
}

function startDrain(size, quality) {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    let canvas = null;
    let context = null;
    while (rawQueue.length) {
      const item = rawQueue.shift();
      const bitmap = item.bitmap;
      try {
        const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        if (!canvas || canvas.width !== width || canvas.height !== height) {
          canvas = new OffscreenCanvas(width, height);
          context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("OFFSCREEN_CANVAS_UNAVAILABLE");
        }
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
        encoded += 1;
        self.postMessage({
          type: "frame",
          blob,
          timestamp: item.timestamp,
          sequence: item.sequence,
          gapMs: item.gapMs,
          estimatedSourceDrops,
          width,
          height,
          rawQueue: rawQueue.length,
        });
        if (encoded % 30 === 0) postStats();
      } finally {
        bitmap.close();
      }
    }
  })().finally(() => {
    drainPromise = null;
    if (rawQueue.length) void startDrain(size, quality);
  });
  return drainPromise;
}

async function stopReader() {
  running = false;
  try { await reader?.cancel(); } catch {}
}

self.onmessage = async (event) => {
  if (event.data?.type === "stop") {
    await stopReader();
    return;
  }
  if (event.data?.type !== "start" || !event.data.track || running) return;

  running = true;
  rawQueue = [];
  sequence = 0;
  encoded = 0;
  previousTimestamp = null;
  estimatedSourceDrops = 0;
  let failed = false;
  const track = event.data.track;
  const size = Math.max(256, Math.min(960, Number(event.data.size || 512)));
  const quality = Math.max(0.55, Math.min(1, Number(event.data.quality || 0.94)));
  const settings = track.getSettings?.() || {};
  const frameRate = Number(settings.frameRate || 30);
  expectedIntervalMs = frameRate > 0 ? 1000 / frameRate : 1000 / 30;

  try {
    if (typeof MediaStreamTrackProcessor === "undefined" || typeof OffscreenCanvas === "undefined") {
      throw new Error("TRACK_PROCESSOR_UNAVAILABLE");
    }
    const processor = new MediaStreamTrackProcessor({ track });
    reader = processor.readable.getReader();

    while (running) {
      const result = await reader.read();
      if (result.done || !result.value) break;
      const frame = result.value;
      try {
        const timestamp = Number(frame.timestamp || 0) / 1_000_000;
        const gapMs = previousTimestamp === null
          ? 0
          : Math.max(0, (timestamp - previousTimestamp) * 1000);
        if (gapMs > expectedIntervalMs * 1.5) {
          estimatedSourceDrops += Math.max(0, Math.round(gapMs / expectedIntervalMs) - 1);
        }
        previousTimestamp = timestamp;
        const bitmap = await resizedBitmap(frame, size);
        rawQueue.push({
          bitmap,
          timestamp,
          gapMs,
          sequence: sequence += 1,
        });
        void startDrain(size, quality);
      } finally {
        frame.close();
      }
    }
  } catch (error) {
    failed = true;
    if (running) {
      self.postMessage({ type: "error", message: String(error?.message || error) });
    }
  } finally {
    running = false;
    try {
      await drainPromise;
    } catch (error) {
      failed = true;
      self.postMessage({ type: "error", message: String(error?.message || error) });
    }
    try { reader?.releaseLock(); } catch {}
    reader = null;
    try { track.stop(); } catch {}
    postStats();
    if (!failed) self.postMessage({ type: "stopped" });
  }
};
