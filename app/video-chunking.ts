export const ANALYSIS_CHUNK_SECONDS = 5;

export type AnalysisChunk = {
  index: number;
  start: number;
  end: number;
  firstSampleIndex: number;
  lastSampleIndexExclusive: number;
  sampleCount: number;
};

export function buildAnalysisChunks(
  duration: number,
  sampleRate: number,
  chunkSeconds = ANALYSIS_CHUNK_SECONDS,
): AnalysisChunk[] {
  if (
    !Number.isFinite(duration) || duration <= 0 ||
    !Number.isFinite(sampleRate) || sampleRate <= 0 ||
    !Number.isFinite(chunkSeconds) || chunkSeconds <= 0
  ) return [];

  const totalSamples = Math.max(2, Math.floor(duration * sampleRate) + 1);
  const chunkCount = Math.max(1, Math.ceil(duration / chunkSeconds));
  return Array.from({ length: chunkCount }, (_, index) => {
    const start = index * chunkSeconds;
    const end = Math.min(duration, start + chunkSeconds);
    const firstSampleIndex = Math.min(totalSamples, Math.ceil(start * sampleRate));
    const lastSampleIndexExclusive = index + 1 === chunkCount
      ? totalSamples
      : Math.min(totalSamples, Math.ceil(end * sampleRate));
    return {
      index,
      start,
      end,
      firstSampleIndex,
      lastSampleIndexExclusive,
      sampleCount: Math.max(0, lastSampleIndexExclusive - firstSampleIndex),
    };
  });
}
