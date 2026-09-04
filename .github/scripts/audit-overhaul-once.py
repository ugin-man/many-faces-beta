"""One-time, anchor-checked migration. Never called by builds or normal CI."""
from pathlib import Path
import json,re

def replace(s,old,new,count=1):
    if s.count(old)!=count: raise RuntimeError(f'Expected {count} matches, got {s.count(old)}: {old[:100]}')
    return s.replace(old,new)
def span(s,start,end,new):
    if s.count(start)!=1 or s.count(end)!=1: raise RuntimeError(f'Ambiguous span: {start}')
    a=s.index(start);b=s.index(end,a)
    return s[:a]+new+'\n\n'+s[b:]
def edit(path,fn):
    p=Path(path);before=p.read_text();after=fn(before)
    if before==after: raise RuntimeError('No change: '+path)
    p.write_text(after);print('CHANGED',path)

p=Path('tsconfig.json');cfg=json.loads(p.read_text());cfg['compilerOptions'].update(target='ES2022',allowImportingTsExtensions=True);cfg['exclude']=['node_modules','dist','work','.sites-runtime'];p.write_text(json.dumps(cfg,indent=2)+'\n')
edit('app/catalog-builder.ts',lambda s:replace(s,'function encodeShape(values: number[])','function encodeShape(values: number[] | Float32Array)'))
edit('app/face-actions.ts',lambda s:replace(s,'const value = scores instanceof Map ? scores.get(key) : scores[key];','const value = typeof (scores as ReadonlyMap<string, number>).get === "function"\n    ? (scores as ReadonlyMap<string, number>).get(key)\n    : (scores as Record<string, number | undefined>)[key];'))
edit('app/offline-video-lab.tsx',lambda s:s.replace('PROJECTION_RANK_MODES.map((mode) => [mode, []])','PROJECTION_RANK_MODES.map((mode) => [mode, [] as RankedCandidate[][]])'))
edit('app/page.tsx',lambda s:s.replace('payload.items.length','(payload.items ?? []).length'))

# Default-deny writes; stop treating plain client-supplied identity headers as proof.
def worker(s):
    s='import { BodyLimitError, readBoundedBody, withDeadline } from "../app/runtime-io";\n'+s
    s=span(s,'function canUploadCatalog(', 'interface ExecutionContext', '''function canUploadCatalog(request: Request, env?: Env) {
  if (!env?.BUCKET || !env.CATALOG_UPLOAD_KEY?.trim()) return false;
  const supplied = request.headers.get("x-catalog-upload-key");
  return Boolean(supplied && supplied === env.CATALOG_UPLOAD_KEY);
}''')
    s=replace(s,'let catalogPreferenceCache: CatalogPreferenceCache | null = null;','const catalogPreferenceCaches = new WeakMap<Env, CatalogPreferenceCache>();')
    s=replace(s,'  const now = Date.now();\n  if (catalogPreferenceCache', '  const now = Date.now();\n  const catalogPreferenceCache = catalogPreferenceCaches.get(env);\n  if (catalogPreferenceCache')
    s=replace(s,'  catalogPreferenceCache = {\n    expiresAt: now + CATALOG_PREFERENCE_CACHE_MS,\n    remoteManifest: selected,\n  };','  catalogPreferenceCaches.set(env, {\n    expiresAt: now + CATALOG_PREFERENCE_CACHE_MS,\n    remoteManifest: selected,\n  });')
    s=replace(s,'      catalogPreferenceCache = null;','      if (env) catalogPreferenceCaches.delete(env);')
    old='''  const remote = await preferredRemoteManifest(request, env);
  if (!remote) {
    const seed = await seedCatalogRead(request, env as Env, path, immutable);
    if (seed.ok || !env?.BUCKET) return seed;
    const stagedObject = await env.BUCKET.get(`${CATALOG_PREFIX}${path}`);
    return stagedObject
      ? remoteCatalogResponse(stagedObject, path, immutable)
      : seed;
  }
  const object = await env?.BUCKET?.get(`${CATALOG_PREFIX}${path}`);
  if (!object) return seedCatalogRead(request, env as Env, path, immutable);
  return remoteCatalogResponse(object, path, immutable);'''
    s=replace(s,old,'''  const remote = await preferredRemoteManifest(request, env);
  // A missing object is an error, not permission to mix another generation.
  return remote
    ? remoteCatalogRead(env, path, immutable)
    : seedCatalogRead(request, env as Env, path, immutable);''')
    s=replace(s,'        !Number.isSafeInteger(length) ||','        !Number.isSafeInteger(length) ||\n        !Number.isSafeInteger(offset + length) ||\n        !url.searchParams.has("offset") ||')
    s=span(s,'      if (source !== "remote") {','      return new Response(remoteObject.body, {', '''      const useRemote = source === "remote" || (source === "auto" && Boolean(await preferredRemoteManifest(request, env)));
      if (!useRemote) return seedCatalogPackRange(request, env as Env, pack, offset, length);
      const remoteObject = await remotePackRange(env, pack, offset, length);
      if (!remoteObject) return catalogJson({ error: "Image pack not found" }, 404);
      const bytes = await withDeadline((signal) => readBoundedBody(new Response(remoteObject.body).body, length, signal));
      if (bytes.byteLength !== length) return catalogJson({ error: "Invalid image range" }, 416);''')
    s=replace(s,'return new Response(remoteObject.body, {','return new Response(bytes, {')
    s=replace(s,'    body = response.body as ReadableStream;', '''    const bytes = await withDeadline((signal) => readBoundedBody(response.body, length, signal));
    if (bytes.byteLength !== length) return catalogJson({ error: "Invalid image range" }, 416);
    body = bytes;''')
    s=replace(s,'new Uint8Array(await response.arrayBuffer())','new Uint8Array(await withDeadline((signal) => readBoundedBody(response.body, MAX_CATALOG_OBJECT_BYTES, signal)))')
    s=replace(s,'      const body = await request.arrayBuffer();','      const body = await withDeadline((signal) => readBoundedBody(request.body, MAX_CATALOG_OBJECT_BYTES, signal), request.signal, 20_000);')
    s=replace(s,'    console.error("Catalog request failed.", error);','    if (error instanceof BodyLimitError) return catalogJson({ error: "Object is too large" }, 413);\n    if (error instanceof DOMException && error.name === "TimeoutError") return catalogJson({ error: "Request timed out" }, 408);\n    console.error("Catalog request failed.", error);')
    s=s.replace('private, max-age=31536000, immutable','private, no-cache').replace('public, max-age=31536000, immutable','public, no-cache')
    s=replace(s,'      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];','      const images = env.IMAGES;\n      if (!images) return new Response("Image transformation is unavailable", { status: 503 });\n      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];')
    s=replace(s,'env.IMAGES.input(body)','images.input(body)')
    return s
edit('worker/index.ts',worker)

# Keep geometry/ranking parameters unchanged. Repair ownership and I/O boundaries.
def review(s):
    s=replace(s,'import styles from "./review-client-lite.module.css";', '''import styles from "./review-client-lite.module.css";
import { fetchJson, throwIfAborted, withDeadline } from "../runtime-io";
import { seekDecodedVideoFrame } from "./video-frame";
import { captureCameraClip } from "./camera-capture";''')
    s=span(s,'type VideoFrameCallbackMetadata = {','function clamp(', '')
    s=span(s,'function chooseRecorderMimeType()','function nextTask()', '''function waitForVideoMetadata(video: HTMLVideoElement, signal?: AbortSignal) {
  return withDeadline((deadline) => new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("error", failed);
      deadline.removeEventListener("abort", cancelled);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("動画を開けませんでした")); };
    const cancelled = () => { cleanup(); reject(deadline.reason); };
    if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
    video.addEventListener("loadeddata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    deadline.addEventListener("abort", cancelled, { once: true });
  }), signal, 15_000);
}''')
    s=span(s,'async function fetchWithTimeout(', 'function drawContained(', '''function loadCandidateImage(candidate: Candidate, signal?: AbortSignal) {
  return withDeadline((deadline) => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    const cleanup = () => { image.onload = null; image.onerror = null; deadline.removeEventListener("abort", cancelled); };
    const cancelled = () => { cleanup(); image.removeAttribute("src"); reject(deadline.reason); };
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error(`IMAGE ${candidate.id}`)); };
    deadline.addEventListener("abort", cancelled, { once: true });
    image.src = candidate.url;
  }), signal, 20_000);
}''')
    s=replace(s,'  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));', '''  return new Promise<void>((resolve) => {
    let raf = 0;
    const done = () => { clearTimeout(timer); cancelAnimationFrame(raf); resolve(); };
    const timer = window.setTimeout(done, 50);
    raf = requestAnimationFrame(done);
  });''')
    s=replace(s,'  const processingTokenRef = useRef(0);','  const processingTokenRef = useRef(0);\n  const operationRef = useRef<AbortController | null>(null);\n  const inputLockRef = useRef(false);')
    s=replace(s,'  const recorderRef = useRef<MediaRecorder | null>(null);\n  const chunksRef = useRef<Blob[]>([]);\n','')
    s=replace(s,'  const streamRef = useRef<MediaStream | null>(null);\n','')
    s=replace(s,'      processingTokenRef.current += 1;','      processingTokenRef.current += 1;\n      operationRef.current?.abort(new DOMException("Progress stalled", "TimeoutError"));')
    s=span(s,'  const cleanupRecording = useCallback(', '  const clearReview = useCallback(', '''  const cleanupRecording = useCallback(() => {
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
  }, []);''')
    s=replace(s,'  const clearReview = useCallback(() => {\n    stopPlayback();','  const clearReview = useCallback(() => {\n    operationRef.current?.abort(new DOMException("Cancelled", "AbortError"));\n    operationRef.current = null;\n    inputLockRef.current = false;\n    stopPlayback();')
    s=replace(s,'''        const response = await fetchWithTimeout(
          "/api/catalog/manifest?source=seed",
          { cache: "no-store" },
          15_000,
        );
        if (!response.ok) throw new Error(`CATALOG ${response.status}`);
        const manifest = await response.json() as CatalogManifest;''','''        const manifest = await fetchJson<CatalogManifest>(
          "/api/catalog/manifest?source=seed", { cache: "no-store" }, 15_000,
        );
        if (manifest.schemaVersion !== 3 || !manifest.cells || !(manifest.totalFaces > 0) || !Number.isFinite(manifest.poseStep) || manifest.poseStep <= 0) throw new Error("対応していないカタログです");''')
    s=replace(s,'        const response = await fetchWithTimeout(', '        const response = await fetchWithTimeout(',0) if False else s
    s=replace(s,'''      const response = await fetchWithTimeout(
        `/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`,
        { cache: "force-cache" },
        20_000,
      );
      if (!response.ok) throw new Error(`SHARD ${response.status}`);
      const payload = await response.json() as { items?: CatalogEntry[] };''','''      if (processingTokenRef.current !== token) throw new DOMException("Cancelled", "AbortError");
      const payload = await fetchJson<{ items?: CatalogEntry[] }>(
        `/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`,
        { signal: operationRef.current?.signal }, 20_000,
      );
      if (!Array.isArray(payload.items)) throw new Error("不正なカタログ断片です");''')
    s=replace(s,'        const candidate = candidateFromEntry(items[index]);','        if (processingTokenRef.current !== token) throw new DOMException("Cancelled", "AbortError");\n        const candidate = candidateFromEntry(items[index]);')
    s=replace(s,'      payloads.forEach((items) => candidates.push(...items));','      if (processingTokenRef.current !== token) throw new DOMException("Cancelled", "AbortError");\n      payloads.forEach((items) => candidates.push(...items));')
    s=replace(s,'    entry.feature.length < 22 ||','    entry.feature.length < 22 ||\n    !entry.feature.every((value) => typeof value === "number" && Number.isFinite(value)) ||')
    s=replace(s,'    entry.layout.length !== 4 ||','    entry.layout.length !== 4 ||\n    !entry.layout.every(Number.isFinite) ||')
    s=replace(s,'      drawReviewAt(video.currentTime);\n      setPlaybackTime(video.currentTime);','''      if (video.currentTime >= clipDuration) {
        video.pause();
        video.currentTime = clipDuration;
        drawReviewAt(clipDuration);
        setPlaybackTime(clipDuration);
        setPlaying(false);
        playbackRafRef.current = null;
        return;
      }
      drawReviewAt(video.currentTime);
      setPlaybackTime(video.currentTime);''')
    s=replace(s,'  }, [drawReviewAt]);','  }, [clipDuration, drawReviewAt]);')
    s=replace(s,'    inputName: string,\n  ) => {','    inputName: string,\n    controller: AbortController,\n  ) => {\n    const signal = controller.signal;')
    s=replace(s,'    processingTokenRef.current = token;\n    const started', '''    processingTokenRef.current = token;
    const assertActive = () => {
      throwIfAborted(signal);
      if (processingTokenRef.current !== token) throw new DOMException("Cancelled", "AbortError");
    };
    setReplayFps(analysisFps);
    replayFpsRef.current = analysisFps;
    const started''')
    s=replace(s,'      await waitUntilPrepared(token);','      await waitUntilPrepared(token);\n      assertActive();')
    s=replace(s,'      await waitForVideoMetadata(video);','      await waitForVideoMetadata(video, signal);\n      assertActive();',3) if False else s
    # Only the processing section is changed here; input/camera callbacks are replaced below.
    a=s.index('  const processRecording =');b=s.index('  const verifyVideoFile =',a);part=s[a:b]
    part=replace(part,'await waitForVideoMetadata(video);','await waitForVideoMetadata(video, signal);\n      assertActive();')
    part=replace(part,'        await seekVideo(video, time);\n        await waitForDecodedVideoFrame(video, time);','        await seekDecodedVideoFrame(video, time, signal);\n        assertActive();')
    part=replace(part,'        const candidates = await loadFrameCandidates(frames[index], token);','        const candidates = await loadFrameCandidates(frames[index], token);\n        assertActive();')
    part=replace(part,'      const choices = optimizeDistinctProjectionSequence(', '      assertActive();\n      const choices = optimizeDistinctProjectionSequence(')
    part=replace(part,'await loadCandidateImage(candidate);','await loadCandidateImage(candidate, signal);')
    part=replace(part,'      phaseTimings.imagePreload = performance.now() - phaseStarted;','      assertActive();\n      phaseTimings.imagePreload = performance.now() - phaseStarted;')
    part=replace(part,'      drawReviewAt(0);','      assertActive();\n      drawReviewAt(0);')
    part=replace(part,'      const canvas = outputCanvasRef.current;','      assertActive();\n      const canvas = outputCanvasRef.current;')
    part=replace(part,'      if (caught instanceof DOMException && caught.name === "AbortError") return;','      if (signal.aborted || processingTokenRef.current !== token) return;')
    part=replace(part,'        passed: gate.passed,','        qualityAcceptedFrames: choices.filter((choice) => choice.accepted).length,\n        passed: gate.passed,')
    s=s[:a]+part+s[b:]
    s=replace(s,'  passed: boolean;\n  reasons: string[];','  qualityAcceptedFrames: number;\n  passed: boolean;\n  reasons: string[];')
    s=span(s,'  const verifyVideoFile =', '  const togglePlayback =', '''  const verifyVideoFile = useCallback(async (file: File | null) => {
    if (!file || inputLockRef.current) return;
    clearReview();
    cleanupRecording();
    const controller = new AbortController();
    operationRef.current = controller;
    inputLockRef.current = true;
    const signal = controller.signal;
    setError(null);
    setSourceName(file.name);
    setPhase("waiting");
    try {
      if (!file.size || file.size > 256 * 1024 * 1024) throw new Error("動画は256MB以下の空でないファイルを選んでください");
      const url = URL.createObjectURL(file);
      recordingUrlRef.current = url;
      const video = playbackVideoRef.current;
      if (!video) throw new Error("検証用動画を準備できませんでした");
      video.src = url;
      video.load();
      await waitForVideoMetadata(video, signal);
      throwIfAborted(signal);
      if (video.videoWidth * video.videoHeight > 33_177_600) throw new Error("動画の解像度が大きすぎます。8K以下にしてください");
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(CAPTURE_SECONDS, video.duration) : CAPTURE_SECONDS;
      setClipDuration(duration);
      await processRecording(url, duration, file.name, controller);
    } catch (caught) {
      if (signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "動画を開けませんでした");
      setPhase("error");
      setProgress(null);
    } finally {
      if (operationRef.current === controller) inputLockRef.current = false;
    }
  }, [cleanupRecording, clearReview, processRecording]);

  const recordFiveSeconds = useCallback(async () => {
    if (inputLockRef.current) return;
    clearReview();
    const controller = new AbortController();
    operationRef.current = controller;
    inputLockRef.current = true;
    setError(null);
    setPhase("recording");
    setSourceName("カメラ録画");
    setRecordingRemaining(CAPTURE_SECONDS);
    try {
      const preview = previewVideoRef.current;
      if (!preview) throw new Error("カメラ表示を準備できませんでした");
      const blob = await captureCameraClip(preview, controller.signal, (remaining) => {
        if (controller.signal.aborted) return;
        setRecordingRemaining(remaining);
        setProgress({ done: Math.round((CAPTURE_SECONDS - remaining) * 10), total: CAPTURE_SECONDS * 10, label: "カメラ録画中" });
      });
      throwIfAborted(controller.signal);
      inputLockRef.current = false;
      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      await verifyVideoFile(new File([blob], `camera-five-seconds.${extension}`, { type: blob.type }));
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "カメラ録画に失敗しました");
      setPhase("error");
      setProgress(null);
    } finally {
      if (operationRef.current === controller) inputLockRef.current = false;
    }
  }, [clearReview, verifyVideoFile]);''')
    s=replace(s,'      if (video.ended) video.currentTime = 0;','      if (video.ended || video.currentTime >= clipDuration) video.currentTime = 0;')
    s=replace(s,'      await video.play();\n      setPlaying(true);','      try { await video.play(); } catch { setError("再生を開始できませんでした"); return; }\n      setPlaying(true);')
    s=replace(s,'  }, [drawReviewAt, phase, startPlaybackLoop, stopPlayback]);','  }, [clipDuration, drawReviewAt, phase, startPlaybackLoop, stopPlayback]);')
    s=replace(s,'    setFaceFrames(0);\n    setLoadedShards(0);','    setFaceFrames(0);\n    setLoadedShards(0);',2) if False else s
    s=replace(s,'    setSourceName("");\n    setReport(null);','    setSourceName("");\n    setPlannedFrames(0);\n    setReport(null);')
    s=s.replace('カメラの前に、同じ動画で壊れ方を潰す。','顔の動きを、たくさんの顔で。').replace('固定動画なら、毎回同じ入力でFace Mesh、角度shard、3D照合、strict経路、画像表示まで確認できます。カメラは比較用の実験扱いです。','動画の最初の5秒を解析して、顔の向きと表情が近い写真につなぎます。入力動画は端末内で処理し、アップロードしません。カメラ録画は実験機能です。').replace('1 撮影','1 入力').replace('2 処理','2 解析').replace('3 確認','3 再生')
    s=replace(s,'                void verifyVideoFile(event.target.files?.[0] ?? null);','                const file = event.target.files?.[0] ?? null;\n                event.target.value = "";\n                void verifyVideoFile(file);')
    s=replace(s,'<button type="button" onClick={reset} disabled={phase === "recording"}>','<button type="button" onClick={reset}>')
    s=replace(s,'            className={styles.scrubber}\n            type="range"','            className={styles.scrubber}\n            aria-label="再生位置"\n            type="range"')
    s=replace(s,'"自動検証 PASS"','"処理・表示の検証 PASS"')
    s=replace(s,'            {!report.passed && report.reasons.map','            <small>一致度の基準内: {report.qualityAcceptedFrames}/{report.sequenceFrames}フレーム。処理の成功と見た目の一致は別の評価です。</small>\n            {!report.passed && report.reasons.map')
    s=replace(s,'<p className={styles.error}>{error}</p>','<p role="alert" className={styles.error}>{error}</p>')
    return s
edit('app/live/review-client-lite.tsx',review)

# Update tests whose old expectation explicitly permitted anonymous uploads.
def worker_tests(s):
    s=replace(s,'    BUCKET: bucket,\n    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },','    BUCKET: bucket,\n    CATALOG_UPLOAD_KEY: "test-secret",\n    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },')
    s=replace(s,'      body: new TextEncoder().encode("abcdef"),','      headers: { "x-catalog-upload-key": "test-secret" },\n      body: new TextEncoder().encode("abcdef"),')
    s=replace(s,'/api/catalog/image?pack=faces_00000.bin&offset=2&length=3','/api/catalog/image?source=remote&pack=faces_00000.bin&offset=2&length=3')
    s=s.replace('public, max-age=31536000, immutable','public, no-cache')
    return s
edit('tests/catalog-worker.test.mjs',worker_tests)
print('ONE_TIME_MIGRATION_APPLIED')
