import type { LiveCandidate } from "./live-matching.ts";

export type LiveImageBufferStats = {
  readyImages: number;
  pendingImages: number;
  loadedPacks: number;
  pendingPacks: number;
  packBytes: number;
  packRequests: number;
  fallbackRequests: number;
  failures: number;
  primeRequests: number;
  primePasses: number;
};

export type LivePackedImageBufferOptions = {
  catalogBasePath?: string;
  maxImageUrls?: number;
  maxPackBytes?: number;
  preloadConcurrency?: number;
  decodeTimeoutMs?: number;
};

type PackRecord = {
  promise: Promise<ArrayBuffer>;
  controller: AbortController;
  bytes: number;
  touchedAt: number;
  settled: boolean;
  generation: number;
};

type ImageRecord = {
  url: string;
  touchedAt: number;
  revoke: boolean;
};

function validPackedReference(candidate: LiveCandidate) {
  return (
    Boolean(candidate.pack) &&
    Number.isSafeInteger(candidate.offset) &&
    Number.isSafeInteger(candidate.length) &&
    Number(candidate.offset) >= 0 &&
    Number(candidate.length) > 0
  );
}

function uniqueCandidates(candidates: readonly LiveCandidate[]) {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

export function choosePreloadCandidates(
  candidates: readonly LiveCandidate[],
  knownPacks: ReadonlySet<string>,
  maxImages = 36,
  maxNewPacks = 2,
) {
  const unique = uniqueCandidates(candidates);
  const selectedPacks = new Set(knownPacks);
  let newPacks = 0;
  for (const candidate of unique) {
    if (!candidate.pack || selectedPacks.has(candidate.pack)) continue;
    if (newPacks >= maxNewPacks) break;
    selectedPacks.add(candidate.pack);
    newPacks += 1;
  }

  const priority = (candidate: LiveCandidate) => {
    if (candidate.image) return 0;
    if (candidate.pack && knownPacks.has(candidate.pack)) return 0;
    if (candidate.pack && selectedPacks.has(candidate.pack)) return 1;
    return 2;
  };

  return unique
    .filter(
      (candidate) =>
        Boolean(candidate.image) ||
        !candidate.pack ||
        selectedPacks.has(candidate.pack),
    )
    .map((candidate, index) => ({ candidate, index, priority: priority(candidate) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, Math.max(1, maxImages))
    .map(({ candidate }) => candidate);
}

export class LivePackedImageBuffer {
  private readonly basePath: string;
  private readonly maxImageUrls: number;
  private readonly maxPackBytes: number;
  private readonly preloadConcurrency: number;
  private readonly decodeTimeoutMs: number;
  private readonly packs = new Map<string, PackRecord>();
  private readonly images = new Map<string, ImageRecord>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private primeQueue: LiveCandidate[] = [];
  private primeLoop: Promise<void> | null = null;
  private generation = 0;
  private packRequests = 0;
  private fallbackRequests = 0;
  private failures = 0;
  private primeRequests = 0;
  private primePasses = 0;

  constructor(options: LivePackedImageBufferOptions = {}) {
    this.basePath = (options.catalogBasePath ?? "/seed-catalog").replace(/\/$/, "");
    this.maxImageUrls = Math.max(24, options.maxImageUrls ?? 192);
    this.maxPackBytes = Math.max(8 * 1024 * 1024, options.maxPackBytes ?? 36 * 1024 * 1024);
    this.preloadConcurrency = Math.max(1, Math.min(8, options.preloadConcurrency ?? 4));
    this.decodeTimeoutMs = Math.max(500, Math.min(15_000, options.decodeTimeoutMs ?? 4_000));
  }

  stats(): LiveImageBufferStats {
    let packBytes = 0;
    let loadedPacks = 0;
    let pendingPacks = 0;
    for (const record of this.packs.values()) {
      packBytes += record.bytes;
      if (record.settled) loadedPacks += 1;
      else pendingPacks += 1;
    }
    return {
      readyImages: this.images.size,
      pendingImages: this.pending.size,
      loadedPacks,
      pendingPacks,
      packBytes,
      packRequests: this.packRequests,
      fallbackRequests: this.fallbackRequests,
      failures: this.failures,
      primeRequests: this.primeRequests,
      primePasses: this.primePasses,
    };
  }

  loadedPackNames() {
    return new Set(
      [...this.packs.entries()]
        .filter(([, record]) => record.settled)
        .map(([name]) => name),
    );
  }

  knownPackNames() {
    return new Set(this.packs.keys());
  }

  isReady(candidate: LiveCandidate) {
    return this.images.has(candidate.id);
  }

  urlFor(candidate: LiveCandidate) {
    const record = this.images.get(candidate.id);
    if (!record) return null;
    record.touchedAt = performance.now();
    this.images.delete(candidate.id);
    this.images.set(candidate.id, record);
    return record.url;
  }

  ensure(candidate: LiveCandidate) {
    const ready = this.urlFor(candidate);
    if (ready) return Promise.resolve(ready);
    const existing = this.pending.get(candidate.id);
    if (existing) return existing;

    const generation = this.generation;
    const promise = this.prepare(candidate, generation).catch((error) => {
      if (generation === this.generation && !this.isAbortError(error)) {
        console.warn("Live candidate image preparation failed.", candidate.id, error);
        this.failures += 1;
      }
      return null;
    });
    this.pending.set(candidate.id, promise);
    void promise.finally(() => {
      if (this.pending.get(candidate.id) === promise) {
        this.pending.delete(candidate.id);
      }
    });
    return promise;
  }

  prime(
    ranked: readonly LiveCandidate[],
    options: { maxImages?: number; maxNewPacks?: number } = {},
  ) {
    this.primeRequests += 1;
    const candidates = choosePreloadCandidates(
      ranked,
      this.knownPackNames(),
      options.maxImages ?? 36,
      options.maxNewPacks ?? 2,
    ).filter((candidate) => !this.isReady(candidate));

    // Every detection frame may submit a new ranking. Keep only the newest
    // not-yet-started plan; at most one small batch from the previous plan is
    // allowed to finish. This prevents dozens of overlapping worker pools and
    // pack downloads when the face moves quickly.
    this.primeQueue = candidates;
    return this.startPrimeLoop();
  }

  clear() {
    this.generation += 1;
    this.primeQueue = [];
    this.primeLoop = null;
    for (const record of this.packs.values()) record.controller.abort();
    for (const record of this.images.values()) {
      if (record.revoke) URL.revokeObjectURL(record.url);
    }
    this.images.clear();
    this.pending.clear();
    this.packs.clear();
  }

  private startPrimeLoop() {
    if (this.primeLoop) return this.primeLoop;
    const generation = this.generation;
    const loop = this.drainPrimeQueue(generation).finally(() => {
      if (this.primeLoop === loop) this.primeLoop = null;
      if (generation === this.generation && this.primeQueue.length) {
        void this.startPrimeLoop();
      }
    });
    this.primeLoop = loop;
    return loop;
  }

  private async drainPrimeQueue(generation: number) {
    while (generation === this.generation && this.primeQueue.length) {
      const batch = this.primeQueue.splice(0, this.preloadConcurrency);
      this.primePasses += 1;
      await Promise.allSettled(batch.map((candidate) => this.ensure(candidate)));
    }
  }

  private rememberImage(
    id: string,
    url: string,
    revoke: boolean,
    generation: number,
  ) {
    if (generation !== this.generation) {
      if (revoke) URL.revokeObjectURL(url);
      return null;
    }
    const previous = this.images.get(id);
    if (previous?.revoke && previous.url !== url) URL.revokeObjectURL(previous.url);
    this.images.delete(id);
    this.images.set(id, { url, touchedAt: performance.now(), revoke });
    while (this.images.size > this.maxImageUrls) {
      const oldest = this.images.entries().next().value as
        | [string, ImageRecord]
        | undefined;
      if (!oldest) break;
      this.images.delete(oldest[0]);
      if (oldest[1].revoke) URL.revokeObjectURL(oldest[1].url);
    }
    return url;
  }

  private async prepare(candidate: LiveCandidate, generation: number) {
    if (candidate.image) {
      const directUrl = `${this.basePath}/images/${encodeURIComponent(candidate.image)}`;
      if (await this.decode(directUrl, generation)) {
        return this.rememberImage(candidate.id, directUrl, false, generation);
      }
    }

    if (validPackedReference(candidate)) {
      try {
        const pack = await this.loadPack(candidate.pack as string, generation);
        if (generation !== this.generation) return null;
        const offset = Number(candidate.offset);
        const length = Number(candidate.length);
        if (offset + length > pack.byteLength) {
          throw new RangeError("Packed image exceeds the downloaded pack");
        }
        const bytes = new Uint8Array(pack, offset, length);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
        if (await this.decode(objectUrl, generation)) {
          return this.rememberImage(candidate.id, objectUrl, true, generation);
        }
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        if (!this.isAbortError(error)) {
          console.warn("Direct bundled pack read failed; using API fallback.", candidate.pack, error);
        }
      }
    }

    if (generation !== this.generation) return null;
    this.fallbackRequests += 1;
    if (await this.decode(candidate.url, generation)) {
      return this.rememberImage(candidate.id, candidate.url, false, generation);
    }
    throw new Error("Candidate image could not be decoded");
  }

  private decode(url: string, generation: number) {
    return new Promise<boolean>((resolve) => {
      if (generation !== this.generation) {
        resolve(false);
        return;
      }
      const image = new Image();
      image.decoding = "async";
      let settled = false;
      const timeout = globalThis.setTimeout(() => finish(false), this.decodeTimeoutMs);
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        resolve(value && generation === this.generation);
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
      void image.decode?.().then(() => finish(true)).catch(() => undefined);
    });
  }

  private loadPack(name: string, generation: number) {
    const existing = this.packs.get(name);
    if (existing) {
      existing.touchedAt = performance.now();
      this.packs.delete(name);
      this.packs.set(name, existing);
      return existing.promise;
    }

    const controller = new AbortController();
    const record: PackRecord = {
      controller,
      generation,
      bytes: 0,
      touchedAt: performance.now(),
      settled: false,
      promise: Promise.resolve(new ArrayBuffer(0)),
    };
    this.packRequests += 1;
    record.promise = fetch(
      `${this.basePath}/packs/${encodeURIComponent(name)}`,
      { cache: "force-cache", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`PACK ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (generation !== this.generation) {
          throw new DOMException("Stale image-buffer generation", "AbortError");
        }
        record.bytes = buffer.byteLength;
        record.settled = true;
        record.touchedAt = performance.now();
        this.evictPacks(name);
        return buffer;
      })
      .catch((error) => {
        if (this.packs.get(name) === record) this.packs.delete(name);
        throw error;
      });
    this.packs.set(name, record);
    return record.promise;
  }

  private evictPacks(protectedName: string) {
    let total = 0;
    for (const record of this.packs.values()) total += record.bytes;
    if (total <= this.maxPackBytes) return;
    const settled = [...this.packs.entries()]
      .filter(([name, record]) => name !== protectedName && record.settled)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (const [name, record] of settled) {
      this.packs.delete(name);
      total -= record.bytes;
      if (total <= this.maxPackBytes) break;
    }
  }

  private isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
  }
}
