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

function insertClosest(
  best: Array<{ distance: number; cell: CompiledPoseCell }>,
  value: { distance: number; cell: CompiledPoseCell },
  limit: number,
) {
  let index = best.length;
  while (index > 0 && best[index - 1].distance > value.distance) index -= 1;
  if (index >= limit) return;
  best.splice(index, 0, value);
  if (best.length > limit) best.pop();
}

export function nearestPoseFiles(
  cells: readonly CompiledPoseCell[],
  yaw: number,
  pitch: number,
  maxCells = 9,
  maxFiles = 18,
) {
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
    this.step = Math.max(1, step);
  }

  update(yaw: number, pitch: number) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return { changed: false, files: this.files };
    }
    // Catalog cells live on a 3-degree grid. Sub-cell landmark jitter cannot
    // change which discrete neighborhood we need, so do not churn network and
    // index state until the face actually crosses a cell boundary.
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

  constructor(maxEntries = 48) {
    this.maxEntries = maxEntries;
  }

  has(name: string) { return this.entries.has(name); }
  get(name: string) {
    const value = this.entries.get(name);
    if (value === undefined) return undefined;
    this.entries.delete(name);
    this.entries.set(name, value);
    return value;
  }
  set(name: string, value: T, protectedNames: ReadonlySet<string> = new Set()) {
    this.entries.delete(name);
    this.entries.set(name, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      if (protectedNames.has(oldest)) {
        const protectedValue = this.entries.get(oldest)!;
        this.entries.delete(oldest);
        this.entries.set(oldest, protectedValue);
        if ([...this.entries.keys()].every((key) => protectedNames.has(key))) break;
        continue;
      }
      this.entries.delete(oldest);
    }
  }
  touch(name: string) { void this.get(name); }
  keysNewestFirst() { return [...this.entries.keys()].reverse(); }
  get size() { return this.entries.size; }
}
