import type { DisplayCandidate } from "./runtime.ts";

type Record = { bitmap: ImageBitmap; bytes: number };

function decodeBitmap(blob: Blob, signal: AbortSignal) {
  return new Promise<ImageBitmap>((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    void createImageBitmap(blob).then((bitmap) => {
      if (settled) { bitmap.close(); return; }
      settled = true;
      signal.removeEventListener("abort", aborted);
      resolve(bitmap);
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      reject(error);
    });
  });
}

async function boundedImageBlob(response: Response, signal: AbortSignal) {
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit || !response.body) throw new Error("Image exceeds limit or has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Image exceeds limit");
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get("content-type") || "image/webp" });
}

// Only selected byte-range images are retained, never their entire packs.
export class DecodedImageCache {
  private images = new Map<string, Record>();
  private pending = new Map<string, AbortController>();
  private retryAfter = new Map<string, number>();
  private queue: DisplayCandidate[] = [];
  private generation = 0;
  private bytes = 0;
  private readonly onReady: () => void;
  private readonly maxBytes: number;
  private readonly maxImages: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  failures = 0;
  requests = 0;

  constructor(onReady: () => void, maxBytes = 32 * 1024 * 1024, maxImages = 64, concurrency = 3, timeoutMs = 5000) {
    this.onReady = onReady;
    this.maxBytes = maxBytes;
    this.maxImages = maxImages;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
  }

  has(candidate: DisplayCandidate) { return this.images.has(candidate.id); }

  get(id: string) {
    const record = this.images.get(id);
    if (!record) return null;
    this.images.delete(id);
    this.images.set(id, record);
    return record.bitmap;
  }

  stats() {
    return { readyImages: this.images.size, pendingImages: this.pending.size, imageBytes: this.bytes, imageFailures: this.failures, imageRequests: this.requests };
  }

  prime(ranked: readonly DisplayCandidate[]) {
    const now = performance.now();
    this.queue = [...new Map(ranked.slice(0, 8).map((candidate) => [candidate.id, candidate])).values()]
      .filter((candidate) => !this.images.has(candidate.id) && !this.pending.has(candidate.id) && (this.retryAfter.get(candidate.id) ?? 0) <= now);
    this.drain();
  }

  clear() {
    this.generation += 1;
    this.queue = [];
    for (const controller of this.pending.values()) controller.abort();
    for (const record of this.images.values()) record.bitmap.close();
    this.pending.clear();
    this.images.clear();
    this.retryAfter.clear();
    this.bytes = 0;
  }

  private drain() {
    while (this.pending.size < this.concurrency && this.queue.length) {
      const candidate = this.queue.shift()!;
      if (this.images.has(candidate.id) || this.pending.has(candidate.id)) continue;
      const generation = this.generation;
      const controller = new AbortController();
      this.pending.set(candidate.id, controller);
      void this.load(candidate, controller.signal, generation).catch(() => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.failures += 1;
        this.retryAfter.set(candidate.id, performance.now() + 5000);
        while (this.retryAfter.size > 128) this.retryAfter.delete(this.retryAfter.keys().next().value!);
      }).finally(() => {
        if (this.pending.get(candidate.id) === controller) this.pending.delete(candidate.id);
        if (generation === this.generation) this.drain();
      });
    }
  }

  private async load(candidate: DisplayCandidate, signal: AbortSignal, generation: number) {
    this.requests += 1;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await fetch(candidate.url, { signal: combined, cache: "force-cache" });
    if (!response.ok) throw new Error(`IMAGE ${response.status}`);
    const blob = await boundedImageBlob(response, combined);
    const bitmap = await decodeBitmap(blob, combined);
    if (generation !== this.generation || combined.aborted) { bitmap.close(); return; }
    const bytes = bitmap.width * bitmap.height * 4;
    if (bytes > this.maxBytes) { bitmap.close(); throw new Error("Decoded image exceeds cache budget"); }
    while (this.images.size && (this.bytes + bytes > this.maxBytes || this.images.size >= this.maxImages)) {
      const id = this.images.keys().next().value!;
      const oldest = this.images.get(id)!;
      this.bytes -= oldest.bytes;
      oldest.bitmap.close();
      this.images.delete(id);
    }
    this.images.set(candidate.id, { bitmap, bytes });
    this.bytes += bytes;
    this.onReady();
  }
}
