import type { LiveCandidate } from "./live-matching.ts";

export type LiveImageBufferStats = {
  readyImages: number;
  pendingImages: number;
  loadedPacks: number;
  packBytes: number;
  packRequests: number;
  fallbackRequests: number;
  failures: number;
};

export type LivePackedImageBufferOptions = {
  catalogBasePath?: string;
  maxImageUrls?: number;
  maxPackBytes?: number;
  preloadConcurrency?: number;
};

type PackRecord = {
  promise: Promise<ArrayBuffer>;
  bytes: number;
  touchedAt: number;
  settled: boolean;
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

export function choosePreloadCandidates(
  candidates: readonly LiveCandidate[],
  loadedPacks: ReadonlySet<string>,
  maxImages = 36,
  maxNewPacks = 2,
) {
  const selectedPacks = new Set(loadedPacks);
  let newPacks = 0;
  for (const candidate of candidates) {
    if (!candidate.pack || selectedPacks.has(candidate.pack)) continue;
    if (newPacks >= maxNewPacks) break;
    selectedPacks.add(candidate.pack);
    newPacks += 1;
  }
  return candidates
    .filter(
      (candidate) =>
        Boolean(candidate.image) ||
        !candidate.pack ||
        selectedPacks.has(candidate.pack),
    )
    .slice(0, Math.max(1, maxImages));
}

export class LivePackedImageBuffer {
  private readonly basePath: string;
  private readonly maxImageUrls: number;
  private readonly maxPackBytes: number;
  private readonly preloadConcurrency: number;
  private readonly packs = new Map<string, PackRecord>();
  private readonly images = new Map<string, ImageRecord>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private packRequests = 0;
  private fallbackRequests = 0;
  private failures = 0;

  constructor(options: LivePackedImageBufferOptions = {}) {
    this.basePath = (options.catalogBasePath ?? "/seed-catalog").replace(/\/$/, "");
    this.maxImageUrls = Math.max(24, options.maxImageUrls ?? 192);
    this.maxPackBytes = Math.max(8 * 1024 * 1024, options.maxPackBytes ?? 36 * 1024 * 1024);
    this.preloadConcurrency = Math.max(1, Math.min(8, options.preloadConcurrency ?? 4));
  }

  stats(): LiveImageBufferStats {
    let packBytes = 0;
    for (const record of this.packs.values()) packBytes += record.bytes;
    return {
      readyImages: this.images.size,
      pendingImages: this.pending.size,
      loadedPacks: [...this.packs.values()].filter((record) => record.settled).length,
      packBytes,
      packRequests: this.packRequests,
      fallbackRequests: this.fallbackRequests,
      failures: this.failures,
    };
  }

  loadedPackNames() {
    return new Set(
      [...this.packs.entries()]
        .filter(([, record]) => record.settled)
        .map(([name]) => name),
    );
  }

  isReady(candidate: LiveCandidate) {
    return this.images.has(candidate.id);
  }

  urlFor(candidate: LiveCandidate) {
    const record = this.images.get(candidate.id);
    if (!record) return null;
    record.touchedAt = performance.now();
    return record.url;
  }

  ensure(candidate: LiveCandidate) {
    const ready = this.urlFor(candidate);
    if (ready) return Promise.resolve(ready);
    const existing = this.pending.get(candidate.id);
    if (existing) return existing;
    const promise = this.prepare(candidate)
      .catch((error) => {
        console.warn("Live candidate image preparation failed.", candidate.id, error);
        this.failures += 1;
        return null;
      })
      .finally(() => {
        this.pending.delete(candidate.id);
      });
    this.pending.set(candidate.id, promise);
    return promise;
  }

  async prime(
    ranked: readonly LiveCandidate[],
    options: { maxImages?: number; maxNewPacks?: number } = {},
  ) {
    const candidates = choosePreloadCandidates(
      ranked,
      this.loadedPackNames(),
      options.maxImages ?? 36,
      options.maxNewPacks ?? 2,
    );
    let index = 0;
    const workers = Array.from(
      { length: Math.min(this.preloadConcurrency, candidates.length) },
      async () => {
        while (index < candidates.length) {
          const candidate = candidates[index];
          index += 1;
          await this.ensure(candidate);
        }
      },
    );
    await Promise.allSettled(workers);
  }

  clear() {
    for (const record of this.images.values()) {
      if (record.revoke) URL.revokeObjectURL(record.url);
    }
    this.images.clear();
    this.pending.clear();
    this.packs.clear();
  }

  private rememberImage(id: string, url: string, revoke: boolean) {
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

  private async prepare(candidate: LiveCandidate) {
    if (candidate.image) {
      const directUrl = `${this.basePath}/images/${encodeURIComponent(candidate.image)}`;
      if (await this.decode(directUrl)) {
        return this.rememberImage(candidate.id, directUrl, false);
      }
    }

    if (validPackedReference(candidate)) {
      try {
        const pack = await this.loadPack(candidate.pack as string);
        const offset = Number(candidate.offset);
        const length = Number(candidate.length);
        if (offset + length > pack.byteLength) {
          throw new RangeError("Packed image exceeds the downloaded pack");
        }
        const bytes = new Uint8Array(pack, offset, length);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
        if (await this.decode(objectUrl)) {
          return this.rememberImage(candidate.id, objectUrl, true);
        }
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        console.warn("Direct bundled pack read failed; using API fallback.", candidate.pack, error);
      }
    }

    this.fallbackRequests += 1;
    if (await this.decode(candidate.url)) {
      return this.rememberImage(candidate.id, candidate.url, false);
    }
    throw new Error("Candidate image could not be decoded");
  }

  private async decode(url: string) {
    return new Promise<boolean>((resolve) => {
      const image = new Image();
      image.decoding = "async";
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        resolve(value);
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
      void image.decode?.().then(() => finish(true)).catch(() => undefined);
    });
  }

  private loadPack(name: string) {
    const existing = this.packs.get(name);
    if (existing) {
      existing.touchedAt = performance.now();
      this.packs.delete(name);
      this.packs.set(name, existing);
      return existing.promise;
    }

    const record: PackRecord = {
      bytes: 0,
      touchedAt: performance.now(),
      settled: false,
      promise: Promise.resolve(new ArrayBuffer(0)),
    };
    this.packRequests += 1;
    record.promise = fetch(
      `${this.basePath}/packs/${encodeURIComponent(name)}`,
      { cache: "force-cache" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`PACK ${response.status}`);
        const buffer = await response.arrayBuffer();
        record.bytes = buffer.byteLength;
        record.settled = true;
        this.evictPacks(name);
        return buffer;
      })
      .catch((error) => {
        this.packs.delete(name);
        throw error;
      });
    this.packs.set(name, record);
    return record.promise;
  }

  private evictPacks(protectedName: string) {
    let total = 0;
    for (const record of this.packs.values()) total += record.bytes;
    if (total <= this.maxPackBytes) return;
    for (const [name, record] of this.packs) {
      if (name === protectedName || !record.settled) continue;
      this.packs.delete(name);
      total -= record.bytes;
      if (total <= this.maxPackBytes) break;
    }
  }
}
