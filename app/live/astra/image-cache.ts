import type { DisplayCandidate } from "./runtime.ts";

type Record = { bitmap: ImageBitmap; bytes: number };

// This preview fetches only the selected candidates' byte-range image URLs.
// It deliberately does not retain whole multi-megabyte packs in the UI thread.
export class DecodedImageCache {
  private images = new Map<string, Record>();
  private pending = new Map<string, AbortController>();
  private retryAfter = new Map<string, number>();
  private queue: DisplayCandidate[] = [];
  private generation = 0;
  private bytes = 0;
  failures = 0;
  requests = 0;

  constructor(
    private readonly onReady: () => void,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxImages = 64,
    private readonly concurrency = 3,
  ) {}

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
    const timeout = AbortSignal.timeout(5000);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await fetch(candidate.url, { signal: combined, cache: "force-cache" });
    if (!response.ok) throw new Error(`IMAGE ${response.status}`);
    if (Number(response.headers.get("content-length")) > 4 * 1024 * 1024) throw new Error("Image exceeds limit");
    const blob = await response.blob();
    if (blob.size > 4 * 1024 * 1024 || combined.aborted) throw new Error("Invalid image response");
    const bitmap = await createImageBitmap(blob);
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
