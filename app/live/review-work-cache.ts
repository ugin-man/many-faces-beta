/** Video-only scheduling and reference caches. Neither helper changes scores,
 * candidate order, frame count, assets, or the realtime pipeline. */
export function createReviewYield(budgetMs = 8) {
  const channel = new MessageChannel();
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nextId = 0, lastYield = performance.now(), closed = false;
  const stats = { yields: 0, waitMs: 0 };
  channel.port1.onmessage = (event: MessageEvent<number>) => {
    const task = pending.get(event.data);
    if (!task) return;
    pending.delete(event.data); task.resolve();
  };
  return {
    stats,
    checkpoint(force = false): Promise<void> | null {
      if (closed) throw new DOMException("Review work cancelled", "AbortError");
      if (!force && performance.now() - lastYield < budgetMs) return null;
      const started = performance.now(), id = ++nextId;
      stats.yields++;
      return new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve: () => {
          lastYield = performance.now(); stats.waitMs += lastYield - started; resolve();
        }, reject });
        channel.port2.postMessage(id);
      });
    },
    close() {
      closed = true; channel.port1.close(); channel.port2.close();
      for (const task of pending.values()) task.reject(new DOMException("Review work cancelled", "AbortError"));
      pending.clear();
    },
  };
}

// These arrays only retain references to the already session-cached candidates.
// Ordered file identities are the key: tie-breaking order must not change.
export class ReviewWindowCache<T> {
  private windows = new Map<string, readonly T[]>();
  private references = 0;
  private readonly maxWindows: number;
  private readonly maxReferences: number;
  hits = 0;
  misses = 0;
  constructor(maxWindows = 8, maxReferences = 100000) {
    this.maxWindows = Math.max(1, Math.floor(maxWindows));
    this.maxReferences = Math.max(1, Math.floor(maxReferences));
  }
  get(files: readonly string[]) {
    const key = JSON.stringify(files), items = this.windows.get(key);
    if (!items) { this.misses++; return null; }
    this.hits++; this.windows.delete(key); this.windows.set(key, items); return items;
  }
  set(files: readonly string[], items: readonly T[]) {
    const key = JSON.stringify(files), previous = this.windows.get(key);
    if (previous) { this.references -= previous.length; this.windows.delete(key); }
    if (items.length > this.maxReferences) return;
    while (this.windows.size && (this.windows.size >= this.maxWindows || this.references + items.length > this.maxReferences)) {
      const oldest = this.windows.keys().next().value!;
      this.references -= this.windows.get(oldest)!.length; this.windows.delete(oldest);
    }
    this.windows.set(key, items); this.references += items.length;
  }
  clear() { this.windows.clear(); this.references = 0; }
  stats() { return { windows: this.windows.size, references: this.references, hits: this.hits, misses: this.misses }; }
}

/** Static decoded catalog. During a job every acquired shard stays pinned, so
 * overlapping pose windows never refetch or decode the same shard. The complete
 * 70k catalog is about 366 MiB by the payload estimate; 512 MiB bounds active
 * retention. Between jobs, trim to the smaller warm LRU. These limits measure
 * estimated decoded payload, not total browser RSS. */
export class ReviewShardCache<T> {
  private identity = "";
  private items = new Map<string, { value: T; bytes: number; records: number }>();
  private bytes = 0;
  private records = 0;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private jobActive = false;
  private jobMaxBytes = 512 * 1024 * 1024;
  private jobMaxRecords = 70000;
  private jobPeakBytes = 0;
  private jobPeakRecords = 0;
  private jobPeakShards = 0;
  private jobStartEvictions = 0;
  private evictionsDuringJob = 0;
  private evictionsAfterJob = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  constructor(maxBytes = 96 * 1024 * 1024, maxRecords = 30000) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.maxRecords = Math.max(0, Math.floor(maxRecords));
  }
  setIdentity(identity: string) {
    if (identity !== this.identity) { this.clear(); this.identity = identity; }
  }
  beginJob(maxBytes = 512 * 1024 * 1024, maxRecords = 70000) {
    if (this.jobActive) throw new Error("CATALOG_JOB_ACTIVE: Previous search has not released its catalog");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxRecords) || maxRecords < 0)
      throw new RangeError("Invalid active catalog limit");
    if (this.bytes > maxBytes || this.records > maxRecords)
      throw new RangeError("CATALOG_WORKING_SET_TOO_LARGE: Warm catalog exceeds active limit");
    this.jobActive = true; this.jobMaxBytes = maxBytes; this.jobMaxRecords = maxRecords;
    this.jobPeakBytes = this.bytes; this.jobPeakRecords = this.records; this.jobPeakShards = this.items.size;
    this.jobStartEvictions = this.evictions; this.evictionsDuringJob = 0; this.evictionsAfterJob = 0;
  }
  endJob() {
    if (!this.jobActive) return;
    this.evictionsDuringJob = this.evictions - this.jobStartEvictions;
    this.jobActive = false;
    const before = this.evictions;
    while (this.items.size && (this.bytes > this.maxBytes || this.records > this.maxRecords)) this.evictOldest();
    this.evictionsAfterJob = this.evictions - before;
  }
  private evictOldest() {
    const oldest = this.items.keys().next().value!;
    const removed = this.items.get(oldest)!;
    this.bytes -= removed.bytes; this.records -= removed.records; this.items.delete(oldest); this.evictions++;
  }
  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) { this.misses++; return undefined; }
    this.hits++; this.items.delete(key); this.items.set(key, item); return item.value;
  }
  set(key: string, value: T, bytes: number, records: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(records) || records < 0) throw new RangeError("Invalid shard cache weight");
    const old = this.items.get(key);
    const nextBytes = this.bytes - (old?.bytes ?? 0) + bytes;
    const nextRecords = this.records - (old?.records ?? 0) + records;
    // Never turn a too-large active catalog into an eviction/refetch loop.
    // Check before mutation so an unsuccessful insertion leaves existing pins intact.
    if (this.jobActive && (nextBytes > this.jobMaxBytes || nextRecords > this.jobMaxRecords))
      throw new RangeError("CATALOG_WORKING_SET_TOO_LARGE: Decoded catalog exceeds the active byte/record limit");
    if (old) { this.bytes -= old.bytes; this.records -= old.records; this.items.delete(key); }
    if (!this.jobActive) {
      if (bytes > this.maxBytes || records > this.maxRecords) return;
      while (this.items.size && (this.bytes + bytes > this.maxBytes || this.records + records > this.maxRecords)) this.evictOldest();
    }
    this.items.set(key, { value, bytes, records }); this.bytes += bytes; this.records += records;
    if (this.jobActive) {
      this.jobPeakBytes = Math.max(this.jobPeakBytes, this.bytes);
      this.jobPeakRecords = Math.max(this.jobPeakRecords, this.records);
      this.jobPeakShards = Math.max(this.jobPeakShards, this.items.size);
    }
  }
  clear() {
    this.items.clear(); this.bytes = 0; this.records = 0; this.hits = 0; this.misses = 0; this.evictions = 0;
    this.jobActive = false; this.jobPeakBytes = 0; this.jobPeakRecords = 0; this.jobPeakShards = 0;
    this.jobStartEvictions = 0; this.evictionsDuringJob = 0; this.evictionsAfterJob = 0;
  }
  stats() {
    return {
      shards: this.items.size, bytes: this.bytes, records: this.records, hits: this.hits, misses: this.misses, evictions: this.evictions,
      maxBytes: this.maxBytes, maxRecords: this.maxRecords,
      jobActive: Number(this.jobActive), jobMaxBytes: this.jobMaxBytes, jobMaxRecords: this.jobMaxRecords,
      jobPinnedShards: this.jobActive ? this.items.size : 0,
      jobPinnedBytes: this.jobActive ? this.bytes : 0,
      jobPinnedRecords: this.jobActive ? this.records : 0,
      jobPeakShards: this.jobPeakShards, jobPeakBytes: this.jobPeakBytes, jobPeakRecords: this.jobPeakRecords,
      evictionsDuringJob: this.jobActive ? this.evictions - this.jobStartEvictions : this.evictionsDuringJob,
      evictionsAfterJob: this.evictionsAfterJob,
    };
  }
}
