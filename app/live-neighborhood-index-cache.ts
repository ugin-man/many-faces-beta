export type LiveNeighborhoodIndexSnapshot<Candidate, Index> = {
  candidates: Candidate[];
  index: Index | null;
};

export type LiveNeighborhoodIndexCacheOptions = {
  maxEntries?: number;
};

/**
 * Tiny LRU for pose-neighborhood search indexes.
 *
 * Turning the head back across a recently visited 3-degree boundary should not
 * rebuild the same 2,000-candidate hash index on the main thread. The cache is
 * deliberately small because decoded geometry is already retained by the
 * shard cache; four recent neighborhoods cover the common left/center/right
 * movement path without allowing unbounded index memory.
 */
export class LiveNeighborhoodIndexCache<Candidate, Index> {
  private readonly maxEntries: number;
  private readonly entries = new Map<
    string,
    LiveNeighborhoodIndexSnapshot<Candidate, Index>
  >();

  constructor(options: LiveNeighborhoodIndexCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(8, Math.round(options.maxEntries ?? 4)));
  }

  get(key: string) {
    const snapshot = this.entries.get(key);
    if (!snapshot) return null;
    this.entries.delete(key);
    this.entries.set(key, snapshot);
    return snapshot;
  }

  set(key: string, snapshot: LiveNeighborhoodIndexSnapshot<Candidate, Index>) {
    this.entries.delete(key);
    this.entries.set(key, snapshot);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  has(key: string) {
    return this.entries.has(key);
  }

  size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

export function liveNeighborhoodKey(files: readonly string[]) {
  return files.join("|");
}
