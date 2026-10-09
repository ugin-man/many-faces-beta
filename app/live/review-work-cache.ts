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
