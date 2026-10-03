/// <reference lib="webworker" />
import type { SequenceFrame } from "../offline-matching";
import { liveCandidateFromEntry, type LiveCandidate, type LiveCatalogEntry } from "../live-matching";
import { optimizeDistinctProjectionSequence, rankProjectionCandidateModesTwoStage, type ProjectionError } from "../projection-matching";
import { poseWindowCellKeys, shardFilesForCells, shouldExpandPoseWindow, type ReviewCatalogManifest } from "./review-local-catalog";
import { readAssetJson } from "./asset-reader";
import { runtimeIdentity } from "../runtime-identity";
import type { SearchProgress } from "./review-search";
const scope = self as unknown as DedicatedWorkerGlobalScope;
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

scope.onmessage = (event: MessageEvent<{ frames: SequenceFrame[]; origin: string; build: string }>) => {
  scope.onmessage = null; // Exactly one cancellable operation per worker.
  void run(event.data).catch(error => scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }));
};
async function run({ frames, origin, build }: { frames: SequenceFrame[]; origin: string; build: string }) {
  if (build !== runtimeIdentity.build) throw new Error("BUILD_MISMATCH: 検証画面と照合処理の版が異なります。");
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
  const cache = new Map<string, Promise<LiveCandidate[]>>();
  const loadShard = (file: string): Promise<LiveCandidate[]> => {
    const cached = cache.get(file); if (cached) return cached;
    const pending = (async () => {
      const url = new URL(`/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(manifest.catalogId ?? "current")}`, origin);
      const payload = await readAssetJson<{ items: LiveCatalogEntry[] }>(url.href, { onBytes: bytes });
      if (!Array.isArray(payload.items)) throw new Error(`CATALOG_SHARD_INVALID: ${file}`);
      const candidates: LiveCandidate[] = [];
      for (let offset = 0; offset < payload.items.length; offset += 32) {
        for (const entry of payload.items.slice(offset, offset + 32)) {
          const candidate = liveCandidateFromEntry(entry, file);
          if (candidate) {
            const image = new URL(candidate.url, origin); image.searchParams.set("source", "seed"); image.searchParams.set("catalog", manifest.catalogId ?? "current"); candidate.url = image.href;
            candidates.push(candidate);
          }
        }
        progress.decoded += Math.min(32, payload.items.length - offset); report("照合データを展開中"); await yieldTask();
      }
      progress.files++; report("照合データを準備中", true);
      return candidates;
    })();
    cache.set(file, pending); return pending;
  };
  const loadCells = async (keys: string[]) => {
    const files = shardFilesForCells(manifest, keys), candidates: LiveCandidate[] = [];
    for (let offset = 0; offset < files.length; offset += 4) {
      const batch = await Promise.all(files.slice(offset, offset + 4).map(loadShard));
      for (const items of batch) candidates.push(...items);
      await yieldTask();
    }
    return [...new Map(candidates.map(item => [item.id, item])).values()];
  };
  const searchStarted = performance.now();
  const beams: { candidate: LiveCandidate; error: ProjectionError }[][] = [];
  for (const frame of frames) {
    let candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 12, 15));
    if (shouldExpandPoseWindow(candidates.length, 384)) candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 18, 21));
    progress.peakCandidates = Math.max(progress.peakCandidates, candidates.length);
    const ranked = rankProjectionCandidateModesTwoStage(frame, candidates, 64, Math.min(1024, candidates.length)).strict;
    if (!ranked.length) throw new Error("CATALOG_NO_MATCH: 比較できる候補がありません。");
    beams.push(ranked); progress.completed++; report("顔を照合中", true); await yieldTask();
  }
  const candidateSearchMs = performance.now() - searchStarted;
  cache.clear(); progress.phase = "optimizing"; report("再生する顔を選択中", true); await yieldTask();
  const pathStarted = performance.now();
  const choices = optimizeDistinctProjectionSequence(frames, beams, {
    allowRepeats: true, cooldown: 12, beamWidth: 24, qualityThreshold: 0.055,
    residualCoherence: 0.46, expressionMotionWeight: 6.2,
    motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
  });
  if (choices.length !== frames.length) throw new Error("SEARCH_INCOMPLETE: 解析したフレーム数と結果が一致しません。");
  scope.postMessage({ type: "result", choices, candidateSearchMs, pathOptimizationMs: performance.now() - pathStarted, build: runtimeIdentity.build });
}
