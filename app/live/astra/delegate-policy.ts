export function medianDuration(values: readonly number[]) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).slice().sort((a, b) => a - b);
  if (!sorted.length) return Infinity;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// A successful WebGL context does not imply hardware acceleration. Probe only
// sustained slow inference, not an isolated first-frame compilation spike.
export function shouldProbeCpu(delegate: string, samples: readonly number[], alreadyProbed: boolean) {
  return delegate === "GPU" && !alreadyProbed && samples.length >= 4 && medianDuration(samples.slice(-4)) > 75;
}

export function preferCpu(gpuMedianMs: number, cpuSamples: readonly number[], gpuFoundFace: boolean, cpuFoundFace: boolean) {
  if (gpuFoundFace && !cpuFoundFace) return false;
  const cpuMedianMs = medianDuration(cpuSamples);
  return Number.isFinite(gpuMedianMs) && Number.isFinite(cpuMedianMs) && cpuMedianMs < gpuMedianMs * 0.8;
}
