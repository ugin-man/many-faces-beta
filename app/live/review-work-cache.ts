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

/** Bounded decoded static-shard LRU. Eviction never truncates a result: callers
 * retain the complete current window and can reload a missing shard later. */
export class ReviewShardCache<T> {
  private identity = "";
  private items = new Map<string, { value: T; bytes: number; records: number }>();
  private bytes = 0;
  private records = 0;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
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
  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) { this.misses++; return undefined; }
    this.hits++; this.items.delete(key); this.items.set(key, item); return item.value;
  }
  set(key: string, value: T, bytes: number, records: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(records) || records < 0) throw new RangeError("Invalid shard cache weight");
    const old = this.items.get(key);
    if (old) { this.bytes -= old.bytes; this.records -= old.records; this.items.delete(key); }
    if (bytes > this.maxBytes || records > this.maxRecords) return;
    while (this.items.size && (this.bytes + bytes > this.maxBytes || this.records + records > this.maxRecords)) {
      const oldest = this.items.keys().next().value!;
      const removed = this.items.get(oldest)!;
      this.bytes -= removed.bytes; this.records -= removed.records; this.items.delete(oldest); this.evictions++;
    }
    this.items.set(key, { value, bytes, records }); this.bytes += bytes; this.records += records;
  }
  clear() { this.items.clear(); this.bytes = 0; this.records = 0; this.hits = 0; this.misses = 0; this.evictions = 0; }
  stats() { return { shards: this.items.size, bytes: this.bytes, records: this.records, hits: this.hits, misses: this.misses, evictions: this.evictions, maxBytes: this.maxBytes, maxRecords: this.maxRecords }; }
}
