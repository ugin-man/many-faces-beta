import {
  LivePackedImageBuffer as BaseLivePackedImageBuffer,
} from "./live-packed-image-buffer.ts";
import type { LiveCandidate } from "./live-matching.ts";

export * from "./live-packed-image-buffer.ts";

export type DirectImageReadyCacheOptions = {
  maxReady?: number;
  concurrency?: number;
};

type DirectQueueItem = {
  candidate: LiveCandidate;
  generation: number;
};

/**
 * Small, latest-biased direct-image cache for cold pack misses.
 *
 * The normal live buffer downloads whole packs so nearby candidates become
 * cheap after warm-up. On a cold pack, however, waiting for several megabytes
 * before showing the first face can stall the visual stream. This cache asks
 * the existing per-image range endpoint for only the highest-ranked faces and
 * marks them ready as soon as the browser has decoded them. Pack loading keeps
 * running in parallel and becomes the long-lived path once it is warm.
 */
export class DirectImageReadyCache {
  private readonly maxReady: number;
  private readonly concurrency: number;
  private readonly ready = new Map<string, string>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private queue: DirectQueueItem[] = [];
  private active = 0;
  private generation = 0;

  constructor(options: DirectImageReadyCacheOptions = {}) {
    this.maxReady = Math.max(8, Math.min(128, Math.round(options.maxReady ?? 48)));
    this.concurrency = Math.max(1, Math.min(4, Math.round(options.concurrency ?? 2)));
  }

  urlFor(candidate: LiveCandidate) {
    const url = this.ready.get(candidate.id);
    if (!url) return null;
    this.ready.delete(candidate.id);
    this.ready.set(candidate.id, url);
    return url;
  }

  isReady(candidate: LiveCandidate) {
    return this.ready.has(candidate.id);
  }

  size() {
    return this.ready.size;
  }

  prime(candidates: readonly LiveCandidate[]) {
    const generation = this.generation;
    const latest = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
      .filter((candidate) => !this.ready.has(candidate.id) && !this.pending.has(candidate.id))
      .slice(0, 4);
    this.queue = latest.map((candidate) => ({ candidate, generation }));
    this.pump();
  }

  ensure(candidate: LiveCandidate) {
    if (this.ready.has(candidate.id)) return Promise.resolve(true);
    const existing = this.pending.get(candidate.id);
    if (existing) return existing;
    const generation = this.generation;
    const promise = this.decode(candidate, generation)
      .finally(() => this.pending.delete(candidate.id));
    this.pending.set(candidate.id, promise);
    return promise;
  }

  clear() {
    this.generation += 1;
    this.queue = [];
    this.ready.clear();
    this.pending.clear();
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      if (!item || item.generation !== this.generation) continue;
      if (this.ready.has(item.candidate.id) || this.pending.has(item.candidate.id)) continue;
      this.active += 1;
      const promise = this.decode(item.candidate, item.generation)
        .finally(() => {
          this.pending.delete(item.candidate.id);
          this.active -= 1;
          this.pump();
        });
      this.pending.set(item.candidate.id, promise);
    }
  }

  private decode(candidate: LiveCandidate, generation: number) {
    return new Promise<boolean>((resolve) => {
      if (typeof Image === "undefined") {
        resolve(false);
        return;
      }
      const image = new Image();
      image.decoding = "async";
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (ok && generation === this.generation) {
          this.ready.delete(candidate.id);
          this.ready.set(candidate.id, candidate.url);
          while (this.ready.size > this.maxReady) {
            const oldest = this.ready.keys().next().value as string | undefined;
            if (!oldest) break;
            this.ready.delete(oldest);
          }
        }
        resolve(ok && generation === this.generation);
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = candidate.url;
      void image.decode?.().then(() => finish(true)).catch(() => undefined);
    });
  }
}

/**
 * Pack-first cache with a direct-image fast lane.
 *
 * Existing call sites keep the same API. `urlFor` first uses a locally sliced
 * pack object URL, then falls back to a browser-decoded per-image URL. `prime`
 * starts both paths; the first one ready wins without cancelling useful pack
 * warm-up work.
 */
export class LivePackedImageBuffer extends BaseLivePackedImageBuffer {
  private readonly direct = new DirectImageReadyCache({ maxReady: 56, concurrency: 2 });

  override urlFor(candidate: LiveCandidate) {
    return super.urlFor(candidate) ?? this.direct.urlFor(candidate);
  }

  override prime(candidates: readonly LiveCandidate[]) {
    this.direct.prime(candidates.slice(0, 4));
    return super.prime(candidates);
  }

  ensureUrgent(candidate: LiveCandidate) {
    return this.direct.ensure(candidate);
  }

  urgentReadyCount() {
    return this.direct.size();
  }

  override clear() {
    this.direct.clear();
    return super.clear();
  }
}
