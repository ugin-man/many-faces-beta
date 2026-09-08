export type ManifestCell = { shards?: string[]; shard?: string };
export type CompiledPoseCell = { yaw: number; pitch: number; files: string[] };

export function compilePoseCells(cells: Record<string, ManifestCell>) {
  const compiled: CompiledPoseCell[] = [];
  for (const [key, cell] of Object.entries(cells)) {
    const [yaw, pitch] = key.split(":").map(Number);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
    const files = [...new Set(cell.shards ?? (cell.shard ? [cell.shard] : []))];
    if (files.length) compiled.push({ yaw, pitch, files });
  }
  return compiled;
}

function insertClosest(best: Array<{ distance: number; cell: CompiledPoseCell }>, value: { distance: number; cell: CompiledPoseCell }, limit: number) {
  let index = best.length;
  while (index > 0 && best[index - 1].distance > value.distance) index -= 1;
  if (index >= limit) return;
  best.splice(index, 0, value);
  if (best.length > limit) best.pop();
}

export function nearestPoseFiles(cells: readonly CompiledPoseCell[], yaw: number, pitch: number, maxCells = 9, maxFiles = 18) {
  const best: Array<{ distance: number; cell: CompiledPoseCell }> = [];
  for (const cell of cells) {
    const distance = (cell.yaw - yaw) ** 2 + (cell.pitch - pitch) ** 2 * 0.82;
    insertClosest(best, { distance, cell }, maxCells);
  }
  return [...new Set(best.flatMap(({ cell }) => cell.files))].slice(0, maxFiles);
}

export class PoseNeighborhood {
  private readonly cells: readonly CompiledPoseCell[];
  private readonly step: number;
  private anchor = "";
  private files: string[] = [];
  constructor(cells: readonly CompiledPoseCell[], step = 3) {
    this.cells = cells;
    this.step = Number.isFinite(step) ? Math.max(1, step) : 3;
  }
  update(yaw: number, pitch: number) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { changed: false, files: this.files };
    // Quantization stabilizes access; it is an approximation, not a proof that
    // the exact nearest continuous-pose neighborhood never changes in a cell.
    const quantizedYaw = Math.round(yaw / this.step) * this.step;
    const quantizedPitch = Math.round(pitch / this.step) * this.step;
    const nextAnchor = `${quantizedYaw}:${quantizedPitch}`;
    if (nextAnchor === this.anchor) return { changed: false, files: this.files };
    this.anchor = nextAnchor;
    const next = nearestPoseFiles(this.cells, quantizedYaw, quantizedPitch);
    const changed = next.length !== this.files.length || next.some((file, index) => file !== this.files[index]);
    this.files = next;
    return { changed, files: this.files };
  }
}

export class ParsedShardCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly maxEntries: number;
  private readonly policy: "lru" | "frequency";
  private readonly history = new Map<string, number>();
  private observations = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private admissionDrops = 0;
  constructor(maxEntries = 48, policy: "lru" | "frequency" = "frequency") {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("Invalid shard cache capacity");
    this.maxEntries = maxEntries;
    this.policy = policy;
  }
  has(name: string) { return this.entries.has(name); }
  peek(name: string) { return this.entries.get(name); }
  get(name: string) {
    this.observe(name);
    const value = this.entries.get(name);
    if (value === undefined) { this.misses += 1; return undefined; }
    this.hits += 1;
    this.entries.delete(name);
    this.entries.set(name, value);
    return value;
  }
  set(name: string, value: T, protectedNames: ReadonlySet<string> = new Set()) {
    if (this.policy === "frequency" && !this.history.has(name)) this.observe(name);
    this.entries.delete(name);
    this.entries.set(name, value);
    while (this.entries.size > this.maxEntries) {
      // Protection is a preference, never permission to exceed the hard cap.
      const keys = [...this.entries.keys()];
      let victim = keys.find((key) => !protectedNames.has(key)) ?? keys[0];
      if (this.policy === "frequency" && !protectedNames.has(victim)) {
        // Repeatedly useful pose shards outlive one-pass transition shards.
        // Equal frequencies retain LRU order; protected current demand wins.
        for (const key of keys) {
          if (!protectedNames.has(key) && (this.history.get(key) ?? 0) < (this.history.get(victim) ?? 0)) victim = key;
        }
      }
      this.entries.delete(victim);
      this.evictions += 1;
      if (victim === name) this.admissionDrops += 1;
    }
  }
  private observe(name: string) {
    if (this.policy !== "frequency") return;
    this.observations += 1;
    // Decay demand, not wall-clock time: old popular poses cannot lock out a
    // new session phase. History holds counts only, never extra shard payloads.
    if (this.observations % (this.maxEntries * 8) === 0) {
      for (const [key, count] of this.history) {
        if (count <= 1) this.history.delete(key);
        else this.history.set(key, count >> 1);
      }
    }
    const count = Math.min(15, (this.history.get(name) ?? 0) + 1);
    this.history.delete(name);
    this.history.set(name, count);
    while (this.history.size > Math.max(256, this.maxEntries * 16)) this.history.delete(this.history.keys().next().value!);
  }
  stats() {
    return { shardCacheHits: this.hits, shardCacheMisses: this.misses, shardEvictions: this.evictions, shardAdmissionDrops: this.admissionDrops, shardHistoryEntries: this.history.size };
  }
  touch(name: string) { void this.get(name); }
  keysNewestFirst() { return [...this.entries.keys()].reverse(); }
  get size() { return this.entries.size; }
}
