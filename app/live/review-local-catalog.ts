export type ReviewCatalogManifest = {
  poseStep?: number;
  bounds?: {
    yawMin?: number;
    yawMax?: number;
    pitchMin?: number;
    pitchMax?: number;
  };
  cells: Record<
    string,
    {
      count?: number;
      shards?: string[];
      shard?: string;
    }
  >;
};

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function cleanZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function cellKey(yaw: number, pitch: number) {
  return `${cleanZero(yaw)}:${cleanZero(pitch)}`;
}

export function poseWindowCellKeys(
  manifest: ReviewCatalogManifest,
  feature: ArrayLike<number>,
  yawLimit = 12,
  pitchLimit = 15,
) {
  const step = Math.max(1, finite(manifest.poseStep, 3));
  const bounds = manifest.bounds ?? {};
  const yawMin = finite(bounds.yawMin, -45);
  const yawMax = finite(bounds.yawMax, 45);
  const pitchMin = finite(bounds.pitchMin, -36);
  const pitchMax = finite(bounds.pitchMax, 36);
  const yaw = clamp(
    Math.round(finite(feature[0]) * 90 / step) * step,
    yawMin,
    yawMax,
  );
  const pitch = clamp(
    Math.round(finite(feature[1]) * 90 / step) * step,
    pitchMin,
    pitchMax,
  );
  const yawRadius = Math.ceil(Math.max(0, yawLimit) / step);
  const pitchRadius = Math.ceil(Math.max(0, pitchLimit) / step);
  const cells: Array<{ key: string; distance: number }> = [];

  for (let yawOffset = -yawRadius; yawOffset <= yawRadius; yawOffset += 1) {
    for (
      let pitchOffset = -pitchRadius;
      pitchOffset <= pitchRadius;
      pitchOffset += 1
    ) {
      const cellYaw = yaw + yawOffset * step;
      const cellPitch = pitch + pitchOffset * step;
      if (
        cellYaw < yawMin ||
        cellYaw > yawMax ||
        cellPitch < pitchMin ||
        cellPitch > pitchMax
      ) {
        continue;
      }
      const key = cellKey(cellYaw, cellPitch);
      if (!manifest.cells[key]) continue;
      cells.push({
        key,
        distance: yawOffset * yawOffset + pitchOffset * pitchOffset,
      });
    }
  }

  return cells
    .sort((left, right) =>
      left.distance - right.distance || left.key.localeCompare(right.key)
    )
    .map(({ key }) => key);
}

export function shardFilesForCells(
  manifest: ReviewCatalogManifest,
  cellKeys: readonly string[],
) {
  const files = new Set<string>();
  for (const key of cellKeys) {
    const cell = manifest.cells[key];
    if (!cell) continue;
    if (cell.shards?.length) {
      cell.shards.forEach((file) => files.add(file));
    } else if (cell.shard) {
      files.add(cell.shard);
    }
  }
  return [...files];
}

export function shouldExpandPoseWindow(
  candidateCount: number,
  minimumCandidates = 384,
) {
  return Math.max(0, Math.floor(candidateCount)) < Math.max(1, minimumCandidates);
}
