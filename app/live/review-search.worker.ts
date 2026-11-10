/// <reference lib="webworker" />
import type { SequenceFrame } from "../offline-matching";
import type { LiveCandidate, LiveCatalogEntry } from "../live-matching";
import { optimizeDistinctProjectionSequenceAsync, type ProjectionError } from "../projection-matching";
import { ReviewStrictRanker } from "./review-strict-ranker";
import { poseWindowCellKeys, shardFilesForCells, shouldExpandPoseWindow, type ReviewCatalogManifest } from "./review-local-catalog";
import { readAssetBytes, readAssetJson } from "./asset-reader";
import { runtimeIdentity } from "../runtime-identity";
import { createReviewYield, ReviewWindowCache, ReviewShardCache } from "./review-work-cache";
import { isReviewCompactManifest, isReviewCompactShard, reviewCandidateFromEntry, reviewCandidateBytes, type ReviewCompactManifest } from "./review-catalog";
import { winkEvidence } from "./wink-evidence";
import { parseWinkSupport, rankWinkSupport, WINK_SUPPORT_MAX_BYTES, type WinkSupportCandidate } from "./wink-support";
import type { SearchProgress } from "./review-search";
import { parseCatalogQualityOverlay, qualityAllows, shouldReadLegacyQualityOverlay } from "./catalog-quality";
const scope = self as unknown as DedicatedWorkerGlobalScope;
type SearchRequest = { type?: "search"; jobId?: number; frames: SequenceFrame[]; origin: string; build: string };
type Job = { id: number; controller: AbortController; cancelled: boolean; done: Promise<void> };
let active: Job | null = null;
// Immutable decoded catalog only. Input-video analysis/results are never cached.
const decoded = new ReviewShardCache<LiveCandidate[]>();
scope.onmessage = (event: MessageEvent<SearchRequest | { type: "cancel"; jobId: number }>) => {
  const data = event.data;
  if (data.type === "cancel") {
    if (active?.id === data.jobId) { active.cancelled = true; active.controller.abort(new DOMException("Cancelled", "AbortError")); }
    return;
  }
  const previous = active;
  if (previous) { previous.cancelled = true; previous.controller.abort(new DOMException("Superseded", "AbortError")); }
  const job: Job = { id: data.jobId ?? 0, controller: new AbortController(), cancelled: false, done: Promise.resolve() };
  active = job;
  job.done = (async () => {
    await previous?.done;
    try {
      if (job.controller.signal.aborted) return;
      await run(data, job);
    } catch (error) {
      if (!job.cancelled && active === job)
        scope.postMessage({ type: "error", jobId: job.id, message: error instanceof Error ? error.message : String(error) });
    } finally { if (active === job) active = null; }
  })();
};
async function run({ frames, origin, build }: SearchRequest, job: Job) {
  if (build !== runtimeIdentity.build) throw new Error("BUILD_MISMATCH: 検証画面と照合処理の版が異なります。");
  const signal = job.controller.signal;
  const check = () => { if (signal.aborted) throw signal.reason; };
  const cooperative = createReviewYield();
  const windows = new ReviewWindowCache<LiveCandidate>(2, 40000);
  const ranker = new ReviewStrictRanker();
  const pending = new Map<string, Promise<LiveCandidate[]>>();
  const measurements = { candidateLoadMs: 0, candidateRankMs: 0, candidateDecodeMs: 0, compactFiles: 0, legacyFiles: 0, compactFallbacks: 0, cachedFiles: 0, cachedRecords: 0 };
  const winkMetrics = { requestedFrames: 0, supportedFrames: 0, fallbackFrames: 0, indexedOriginals: 0, addedPhotos: 0, indexBytes: 0, indexError: null as string | null };
  let support: WinkSupportCandidate[] = [];
  const preparationStarted = performance.now();
  try {
    const progress: SearchProgress = { type: "progress", jobId: job.id, sequence: 0, phase: "searching", label: "カタログを確認中", bytes: 0, files: 0, decoded: 0, completed: 0, total: frames.length, peakCandidates: 0 };
    let lastReport = -Infinity;
    const report = (label: string, force = false) => {
      check(); progress.sequence++; progress.label = label;
      if (force || performance.now() - lastReport > 100) { scope.postMessage({ ...progress }); lastReport = performance.now(); }
    };
    const bytes = (_received: number, delta: number) => { progress.bytes += delta; report("照合データを受信中"); };
    report("カタログを確認中", true);
    const manifestBytes = await readAssetBytes(new URL("/api/catalog/manifest?source=seed", origin).href, { signal, cache: "no-cache", onBytes: bytes });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReviewCatalogManifest & { catalogId?: string; totalFaces?: number; searchableFaces?: number; qualityAdmission?: unknown; winkExpressionReview?: unknown };
    if (!manifest.cells || Number(manifest.searchableFaces ?? manifest.totalFaces) !== 70000) throw new Error("CATALOG_INVALID: 7万枚のカタログを確認できません。Siteの配信データを確認してください。");
    const manifestSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", manifestBytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    check(); decoded.setIdentity(`${origin}|${build}|${manifestSha256}`);
    const cacheBefore = decoded.stats();
    decoded.beginJob();
    let compact: ReviewCompactManifest | null = null;
    try {
      const payload = await readAssetJson<unknown>(new URL(`/api/catalog/review-manifest?source=seed&catalog=${manifestSha256}`, origin).href, { signal, idleMs: 3000, maxMs: 6000, maxBytes: 2 * 1024 * 1024, onBytes: bytes });
      if (isReviewCompactManifest(payload, manifestSha256, manifest.catalogId ?? "")) compact = payload;
    } catch { check(); /* Older deployments fall back to legacy data. */ }
    let qualityExclusions = new Map();
    if (shouldReadLegacyQualityOverlay(manifest.qualityAdmission)) {
      try {
        const qualityPayload = await readAssetJson<unknown>(new URL("/catalog-quality/v1/exclusions.json", origin).href, { signal, cache: "no-cache", idleMs: 3000, maxMs: 6000, maxBytes: 2 * 1024 * 1024 });
        qualityExclusions = parseCatalogQualityOverlay(qualityPayload);
      } catch { check(); }
    }
    winkMetrics.requestedFrames = frames.filter(frame => winkEvidence(frame.feature, frame.geometry.projection)).length;
    if (winkMetrics.requestedFrames) {
      const loadStarted = performance.now();
      try {
        const supportUrl = new URL("/wink-support/v1/catalog.json", origin);
        if (manifest.qualityAdmission !== undefined) supportUrl.searchParams.set("catalog", manifestSha256);
        const payload = await readAssetJson<unknown>(supportUrl.href, {
          signal, idleMs: 5000, maxMs: 10000, maxBytes: WINK_SUPPORT_MAX_BYTES,
          onBytes: (received, delta) => { winkMetrics.indexBytes = received; bytes(received, delta); },
        });
        support = parseWinkSupport(payload, origin, { catalogId: manifest.catalogId, manifestSha256: manifest.qualityAdmission === undefined ? undefined : manifestSha256, qualityAdmission: manifest.qualityAdmission, winkExpressionReview: manifest.winkExpressionReview }).filter(candidate => qualityAllows(candidate.id, qualityExclusions));
        winkMetrics.indexedOriginals = support.filter(candidate => candidate.supportKind === "core-refresh").length;
        winkMetrics.addedPhotos = support.filter(candidate => candidate.supportKind === "addition").length;
      } catch (error) {
        check(); winkMetrics.indexError = error instanceof Error ? error.message : String(error);
        console.warn("Wink index unavailable; retaining the original video matcher.", winkMetrics.indexError);
      }
      measurements.candidateLoadMs += performance.now() - loadStarted;
    }
    const catalogPreparationMs = performance.now() - preparationStarted;
    const loadShard = async (file: string): Promise<LiveCandidate[]> => {
      const resident = decoded.get(file);
      if (resident) {
        measurements.cachedFiles++; measurements.cachedRecords += resident.length;
        return resident.filter(candidate => qualityAllows(candidate.id, qualityExclusions));
      }
      const inflight = pending.get(file); if (inflight) return inflight;
      const loading = (async () => {
        const decodeEntries = async (entries: LiveCatalogEntry[], isCompact: boolean) => {
          const candidates: LiveCandidate[] = [];
          for (let offset = 0; offset < entries.length; offset += 32) {
            check(); const started = performance.now();
            let processed = 0;
            try {
              for (const entry of entries.slice(offset, offset + 32)) {
                processed++;
                const candidate = reviewCandidateFromEntry(entry, file, isCompact);
                // Every compact row passed the original admission rule at build
                // time. A malformed row invalidates the entire compact shard;
                // skipping it would silently change the searchable candidates.
                if (!candidate && isCompact) throw new Error("REVIEW_CATALOG_RECORD_INVALID");
                if (candidate) {
                  const image = new URL(candidate.url, origin); image.searchParams.set("source", "seed"); image.searchParams.set("catalog", manifest.catalogId ?? "current"); candidate.url = image.href;
                  candidates.push(candidate);
                }
              }
            } finally {
              measurements.candidateDecodeMs += performance.now() - started;
              progress.decoded += processed;
            }
            report("照合データを展開中");
            const pause = cooperative.checkpoint(); if (pause) await pause;
          }
          return candidates;
        };
        let candidates: LiveCandidate[] | null = null;
        if (compact?.shards[file]) {
          try {
            const url = new URL(`/api/catalog/review-shard?source=seed&file=${encodeURIComponent(file)}&catalog=${manifestSha256}`, origin);
            const payload = await readAssetJson<unknown>(url.href, { signal, onBytes: bytes });
            if (!isReviewCompactShard(payload, compact, file)) throw new Error("REVIEW_CATALOG_MISMATCH");
            candidates = await decodeEntries(payload.items, true); measurements.compactFiles++;
          } catch { check(); measurements.compactFallbacks++; }
        }
        if (!candidates) {
          const url = new URL(`/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(manifest.catalogId ?? "current")}`, origin);
          const payload = await readAssetJson<{ items: LiveCatalogEntry[] }>(url.href, { signal, onBytes: bytes });
          if (!Array.isArray(payload.items)) throw new Error(`CATALOG_SHARD_INVALID: ${file}`);
          candidates = await decodeEntries(payload.items, false); measurements.legacyFiles++;
        }
        check(); const evictions = decoded.evictions;
        decoded.set(file, candidates, reviewCandidateBytes(candidates), candidates.length);
        if (decoded.evictions !== evictions) windows.clear();
        progress.files++; report("照合データを準備中", true);
        return candidates.filter(candidate => qualityAllows(candidate.id, qualityExclusions));
      })();
      pending.set(file, loading);
      try { return await loading; } finally { pending.delete(file); }
    };
    const loadCells = async (keys: string[]): Promise<LiveCandidate[]> => {
      const files = shardFilesForCells(manifest, keys);
      const known = windows.get(files); if (known) return known as LiveCandidate[];
      const candidates: LiveCandidate[] = [];
      for (let offset = 0; offset < files.length; offset += 4) {
        check(); const batch = await Promise.all(files.slice(offset, offset + 4).map(loadShard));
        for (const items of batch) candidates.push(...items);
        const pause = cooperative.checkpoint(); if (pause) await pause;
      }
      const unique = [...new Map(candidates.map(item => [item.id, item])).values()];
      windows.set(files, unique); return unique;
    };
    const searchStarted = performance.now();
    const beams: { candidate: LiveCandidate; error: ProjectionError }[][] = [];
    for (const frame of frames) {
      check(); let started = performance.now();
      let ranked: { candidate: LiveCandidate; error: ProjectionError }[] | null = rankWinkSupport(frame, support, ranker);
      measurements.candidateRankMs += performance.now() - started;
      if (ranked) {
        winkMetrics.supportedFrames++; progress.peakCandidates = Math.max(progress.peakCandidates, ranked.length);
      } else {
        if (winkEvidence(frame.feature, frame.geometry.projection)) winkMetrics.fallbackFrames++;
        started = performance.now();
        let candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 12, 15));
        if (shouldExpandPoseWindow(candidates.length, 384)) candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 18, 21));
        measurements.candidateLoadMs += performance.now() - started;
        progress.peakCandidates = Math.max(progress.peakCandidates, candidates.length);
        started = performance.now(); ranked = ranker.rank(frame, candidates, 64, Math.min(1024, candidates.length));
        measurements.candidateRankMs += performance.now() - started;
      }
      if (!ranked.length) throw new Error("CATALOG_NO_MATCH: 比較できる候補がありません。");
      beams.push(ranked); progress.completed++; report("顔を照合中", true);
      await cooperative.checkpoint(true);
    }
    const candidateSearchMs = performance.now() - searchStarted;
    const windowStats = windows.stats(), rankStats = ranker.stats();
    windows.clear(); ranker.clear(); support = [];
    progress.phase = "optimizing"; progress.completed = 0; report("再生する顔を選択中", true);
    await cooperative.checkpoint(true);
    const pathStarted = performance.now();
    const choices = await optimizeDistinctProjectionSequenceAsync(frames, beams, {
      allowRepeats: true, cooldown: 12, beamWidth: 24, qualityThreshold: 0.055,
      residualCoherence: 0.46, expressionMotionWeight: 6.2,
      motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
    }, {
      signal, checkpoint: () => cooperative.checkpoint(true) ?? undefined,
      onProgress: (completed, total) => { progress.completed = completed; progress.total = total; report("再生する顔を選択中", true); },
    });
    check();
    if (choices.length !== frames.length) throw new Error("SEARCH_INCOMPLETE: 解析したフレーム数と結果が一致しません。");
    decoded.endJob();
    const cache = decoded.stats();
    scope.postMessage({ type: "result", jobId: job.id, choices, candidateSearchMs, pathOptimizationMs: performance.now() - pathStarted, build: runtimeIdentity.build,
      performanceMetrics: { implementation: "video-compact-cache-v3-job-pinned", catalogPreparationMs, ...measurements, ...cooperative.stats, compactCatalog: Boolean(compact),
        cache: { ...cache, hits: cache.hits - cacheBefore.hits, misses: cache.misses - cacheBefore.misses, evictions: cache.evictions - cacheBefore.evictions },
        windowStats, rankStats, wink: winkMetrics, qualityExcluded: qualityExclusions.size } });
  } finally {
    job.controller.abort(); await Promise.allSettled(pending.values()); decoded.endJob();
    pending.clear(); windows.clear(); ranker.clear(); support = []; cooperative.close();
  }
}
