/// <reference lib="webworker" />
import type { SequenceFrame } from "../offline-matching";
import { liveCandidateFromEntry, type LiveCandidate, type LiveCatalogEntry } from "../live-matching";
import { optimizeDistinctProjectionSequence, type ProjectionError } from "../projection-matching";
import { ReviewStrictRanker } from "./review-strict-ranker";
import { poseWindowCellKeys, shardFilesForCells, shouldExpandPoseWindow, type ReviewCatalogManifest } from "./review-local-catalog";
import { readAssetJson } from "./asset-reader";
import { runtimeIdentity } from "../runtime-identity";
import { createReviewYield, ReviewWindowCache } from "./review-work-cache";
import { winkEvidence } from "./wink-evidence";
import { parseWinkSupport, rankWinkSupport, type WinkSupportCandidate } from "./wink-support";
import type { SearchProgress } from "./review-search";
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<{ frames: SequenceFrame[]; origin: string; build: string }>) => {
  scope.onmessage = null;
  void run(event.data).catch(error => scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }));
};
async function run({ frames, origin, build }: { frames: SequenceFrame[]; origin: string; build: string }) {
  if (build !== runtimeIdentity.build) throw new Error("BUILD_MISMATCH: 検証画面と照合処理の版が異なります。");
  const cooperative = createReviewYield();
  const windows = new ReviewWindowCache<LiveCandidate>();
  const ranker = new ReviewStrictRanker();
  const cache = new Map<string, Promise<LiveCandidate[]>>();
  const measurements = { candidateLoadMs: 0, candidateRankMs: 0, candidateDecodeMs: 0 };
  const winkMetrics = { requestedFrames: 0, supportedFrames: 0, fallbackFrames: 0, indexedOriginals: 0, addedPhotos: 0, indexBytes: 0, indexError: null as string | null };
  let support: WinkSupportCandidate[] = [];
  try {
    const progress: SearchProgress = { type: "progress", sequence: 0, phase: "searching", label: "カタログを確認中", bytes: 0, files: 0, decoded: 0, completed: 0, total: frames.length, peakCandidates: 0 };
    let lastReport = -Infinity;
    const report = (label: string, force = false) => {
      progress.sequence++; progress.label = label;
      if (force || performance.now() - lastReport > 100) { scope.postMessage({ ...progress }); lastReport = performance.now(); }
    };
    const bytes = (_received: number, delta: number) => { progress.bytes += delta; report("照合データを受信中"); };
    report("カタログを確認中", true);
    const manifest = await readAssetJson<ReviewCatalogManifest & { catalogId?: string; totalFaces?: number; searchableFaces?: number }>(new URL("/api/catalog/manifest?source=seed", origin).href, { onBytes: bytes });
    if (!manifest.cells || Number(manifest.searchableFaces ?? manifest.totalFaces) !== 70000) throw new Error("CATALOG_INVALID: 7万枚のカタログを確認できません。Siteの配信データを確認してください。");
    winkMetrics.requestedFrames = frames.filter(frame => winkEvidence(frame.feature, frame.geometry.projection)).length;
    if (winkMetrics.requestedFrames) {
      const loadStarted = performance.now();
      try {
        const payload = await readAssetJson<unknown>(new URL("/wink-support/v1/catalog.json", origin).href, {
          idleMs: 5000, maxMs: 10000, maxBytes: 4 * 1024 * 1024,
          onBytes: (received, delta) => { winkMetrics.indexBytes = received; bytes(received, delta); },
        });
        support = parseWinkSupport(payload, origin);
        winkMetrics.indexedOriginals = support.filter(candidate => candidate.supportKind === "core-refresh").length;
        winkMetrics.addedPhotos = support.filter(candidate => candidate.supportKind === "addition").length;
      } catch (error) {
        // A missing optional overlay must not break the functioning original
        // catalog. Record the failure instead of inventing successful support.
        winkMetrics.indexError = error instanceof Error ? error.message : String(error);
        console.warn("Wink index unavailable; retaining the original video matcher.", winkMetrics.indexError);
      }
      measurements.candidateLoadMs += performance.now() - loadStarted;
    }
    const loadShard = (file: string): Promise<LiveCandidate[]> => {
      const cached = cache.get(file); if (cached) return cached;
      const pending = (async () => {
        const url = new URL(`/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(manifest.catalogId ?? "current")}`, origin);
        const payload = await readAssetJson<{ items: LiveCatalogEntry[] }>(url.href, { onBytes: bytes });
        if (!Array.isArray(payload.items)) throw new Error(`CATALOG_SHARD_INVALID: ${file}`);
        const candidates: LiveCandidate[] = [];
        for (let offset = 0; offset < payload.items.length; offset += 32) {
          const started = performance.now();
          for (const entry of payload.items.slice(offset, offset + 32)) {
            const candidate = liveCandidateFromEntry(entry, file);
            if (candidate) {
              const image = new URL(candidate.url, origin); image.searchParams.set("source", "seed"); image.searchParams.set("catalog", manifest.catalogId ?? "current"); candidate.url = image.href;
              candidates.push(candidate);
            }
          }
          measurements.candidateDecodeMs += performance.now() - started;
          progress.decoded += Math.min(32, payload.items.length - offset); report("照合データを展開中");
          const pause = cooperative.checkpoint(); if (pause) await pause;
        }
        progress.files++; report("照合データを準備中", true);
        return candidates;
      })();
      cache.set(file, pending); return pending;
    };
    const loadCells = async (keys: string[]): Promise<LiveCandidate[]> => {
      const files = shardFilesForCells(manifest, keys);
      const known = windows.get(files); if (known) return known as LiveCandidate[];
      const candidates: LiveCandidate[] = [];
      for (let offset = 0; offset < files.length; offset += 4) {
        const batch = await Promise.all(files.slice(offset, offset + 4).map(loadShard));
        for (const items of batch) candidates.push(...items);
        const pause = cooperative.checkpoint(); if (pause) await pause;
      }
      const unique = [...new Map(candidates.map(item => [item.id, item])).values()];
      windows.set(files, unique); return unique;
    };
    const searchStarted = performance.now();
    const beams: { candidate: LiveCandidate; error: ProjectionError }[][] = [];
    for (const frame of frames) {
      let started = performance.now();
      let ranked: { candidate: LiveCandidate; error: ProjectionError }[] | null = rankWinkSupport(frame, support, ranker);
      measurements.candidateRankMs += performance.now() - started;
      if (ranked) {
        winkMetrics.supportedFrames++;
        progress.peakCandidates = Math.max(progress.peakCandidates, ranked.length);
      } else {
        if (winkEvidence(frame.feature, frame.geometry.projection)) winkMetrics.fallbackFrames++;
        started = performance.now();
        let candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 12, 15));
        if (shouldExpandPoseWindow(candidates.length, 384)) candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 18, 21));
        measurements.candidateLoadMs += performance.now() - started;
        progress.peakCandidates = Math.max(progress.peakCandidates, candidates.length);
        started = performance.now();
        ranked = ranker.rank(frame, candidates, 64, Math.min(1024, candidates.length));
        measurements.candidateRankMs += performance.now() - started;
      }
      if (!ranked.length) throw new Error("CATALOG_NO_MATCH: 比較できる候補がありません。");
      beams.push(ranked); progress.completed++; report("顔を照合中", true);
      await cooperative.checkpoint(true);
    }
    const candidateSearchMs = performance.now() - searchStarted;
    const windowStats = windows.stats(), rankStats = ranker.stats();
    cache.clear(); windows.clear(); ranker.clear(); support = [];
    progress.phase = "optimizing"; report("再生する顔を選択中", true);
    await cooperative.checkpoint(true);
    const pathStarted = performance.now();
    const choices = optimizeDistinctProjectionSequence(frames, beams, {
      allowRepeats: true, cooldown: 12, beamWidth: 24, qualityThreshold: 0.055,
      residualCoherence: 0.46, expressionMotionWeight: 6.2,
      motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
    });
    if (choices.length !== frames.length) throw new Error("SEARCH_INCOMPLETE: 解析したフレーム数と結果が一致しません。");
    scope.postMessage({ type: "result", choices, candidateSearchMs, pathOptimizationMs: performance.now() - pathStarted, build: runtimeIdentity.build,
      performanceMetrics: { implementation: "video-wink-support-v1", ...measurements, ...cooperative.stats, windowStats, rankStats, wink: winkMetrics } });
  } finally { cache.clear(); windows.clear(); ranker.clear(); support = []; cooperative.close(); }
}
