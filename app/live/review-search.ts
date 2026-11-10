import type { SequenceFrame } from "../offline-matching";
import type { LiveCandidate } from "../live-matching";
import type { ProjectionChoice } from "../projection-matching";
import { runtimeIdentity } from "../runtime-identity";
import { ReviewSearchController } from "./review-search-controller";
import type { ReviewStrictRanker } from "./review-strict-ranker";
export type SearchProgress = {
  type: "progress"; jobId: number; sequence: number; phase: "searching" | "optimizing";
  label: string; bytes: number; files: number; decoded: number;
  completed: number; total: number; peakCandidates: number;
};
export type ReviewSearchMetrics = {
  implementation: string;
  catalogPreparationMs: number;
  candidateLoadMs: number;
  candidateRankMs: number;
  candidateDecodeMs: number;
  yields: number;
  waitMs: number;
  compactCatalog: boolean;
  compactFiles: number;
  legacyFiles: number;
  compactFallbacks: number;
  cachedFiles: number;
  cachedRecords: number;
  cache: Record<string, number>;
  windowStats: Record<string, number>;
  rankStats: ReturnType<ReviewStrictRanker["stats"]>;
  wink: { requestedFrames: number; supportedFrames: number; fallbackFrames: number; indexedOriginals: number; addedPhotos: number; indexBytes: number; indexError: string | null };
  qualityExcluded: number;
};
export type SearchResult = {
  type: "result"; jobId: number; choices: ProjectionChoice<LiveCandidate>[];
  candidateSearchMs: number; pathOptimizationMs: number; build: string;
  performanceMetrics: ReviewSearchMetrics;
};
let controller: ReviewSearchController | null = null;
export function disposeReviewSearch() { controller?.dispose(); controller = null; }
export function searchReviewFrames(frames: SequenceFrame[], signal: AbortSignal, onProgress: (event: SearchProgress) => void): Promise<SearchResult> {
  controller ??= new ReviewSearchController(
    () => new Worker(new URL("./review-search.worker.ts", import.meta.url), { type: "module" }), runtimeIdentity.build,
  );
  return controller.run<SearchResult, SearchProgress>(frames, location.origin, signal, onProgress);
}
