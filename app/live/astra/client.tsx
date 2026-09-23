"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ResponsiveSwitchController, type ResponsiveSwitchDecision } from "../../live-responsive-runtime";
import { LatestFrameGate, qualityBoundedReadyChoice, type FrameResult } from "./runtime";
import { assertCameraEnvironment, cameraEnvironment, createInputFrame, inputError, MediaInputError, openCameraStream, startVideoFramePump, waitForPlayableVideo, type CameraEnvironment } from "../media-input";
import { DecodedImageCache } from "./image-cache";
import styles from "./client.module.css";

type Phase = "idle" | "starting" | "running" | "error";
type Snapshot = {
  phase: Phase; message: string; delegate: string; source: string;
  frames: number; faceFrames: number; outputChanges: number;
  detectionFps: number; outputFps: number; latencyP95Ms: number;
  inferenceMs: number; searchMs: number; candidates: number; shards: number;
  readyImages: number; pendingImages: number; imageBytes: number; imageFailures: number;
  inFlight: number; maxInFlight: number; busyDrops: number; staleResults: number;
  catalogTotal: number; firstOutputMs: number | null; face: boolean;
  currentName: string; currentSource: string; catalogError: string | null;
  stage: string; errorCode: string | null; frameClock: string;
  videoWidth: number; videoHeight: number; videoReadyState: number; videoPaused: boolean;
  trackState: string; trackMuted: boolean; environment: CameraEnvironment | null;
  mirrorPresentation: boolean; build: string;
};
const initialSnapshot = (): Snapshot => ({
  phase: "idle", message: "カメラ、または動画を選んで開始", delegate: "—", source: "—",
  frames: 0, faceFrames: 0, outputChanges: 0, detectionFps: 0, outputFps: 0,
  latencyP95Ms: 0, inferenceMs: 0, searchMs: 0, candidates: 0, shards: 0,
  readyImages: 0, pendingImages: 0, imageBytes: 0, imageFailures: 0,
  inFlight: 0, maxInFlight: 0, busyDrops: 0, staleResults: 0, catalogTotal: 0,
  firstOutputMs: null, face: false, currentName: "—", currentSource: "—", catalogError: null,
  stage: "idle", errorCode: null, frameClock: "—", videoWidth: 0, videoHeight: 0,
  videoReadyState: 0, videoPaused: true, trackState: "none", trackMuted: false,
  environment: null, mirrorPresentation: false, build: "input-recovery-v1",
});

declare global { interface Window { __MANY_FACES_REALTIME__?: Snapshot; } }

export default function AstraRealtimeClient() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [kind, setKind] = useState<"camera" | "video" | null>(null);
  const [mirror, setMirror] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [directUrl, setDirectUrl] = useState("");
  const [embedded, setEmbedded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputAbortRef = useRef<AbortController | null>(null);
  const stopPumpRef = useRef<(() => void) | null>(null);
  const urlRef = useRef<string | null>(null);
  const sessionRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const kindRef = useRef<"camera" | "video" | null>(null);
  const dataRef = useRef(initialSnapshot());
  const gateRef = useRef(new LatestFrameGate());
  const cacheRef = useRef<DecodedImageCache | null>(null);
  const controllerRef = useRef(new ResponsiveSwitchController());
  const decisionRef = useRef<ResponsiveSwitchDecision | null>(null);
  const resultRef = useRef<FrameResult | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejectStartRef = useRef<((error: Error) => void) | null>(null);
  const presentRef = useRef<() => void>(() => undefined);
  const startedAtRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const lastMediaTimeRef = useRef(-Infinity);
  const frameTimesRef = useRef<number[]>([]);
  const outputTimesRef = useRef<number[]>([]);
  const latencyRef = useRef<number[]>([]);

  const publish = useCallback(() => {
    const now = performance.now();
    for (const times of [frameTimesRef.current, outputTimesRef.current]) while (times.length && times[0] < now - 1000) times.shift();
    const latency = [...latencyRef.current].sort((a, b) => a - b);
    const cache = cacheRef.current?.stats();
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (video && phaseRef.current !== "idle" && phaseRef.current !== "error") {
      Object.assign(dataRef.current, { videoWidth: video.videoWidth, videoHeight: video.videoHeight, videoReadyState: video.readyState, videoPaused: video.paused, trackState: track?.readyState ?? "none", trackMuted: track?.muted ?? false });
    }
    const next: Snapshot = {
      ...dataRef.current, phase: phaseRef.current,
      detectionFps: phaseRef.current === "running" ? frameTimesRef.current.length : 0,
      outputFps: phaseRef.current === "running" ? outputTimesRef.current.length : 0,
      latencyP95Ms: latency.length ? Math.round(latency[Math.ceil(latency.length * 0.95) - 1]) : 0,
      inFlight: gateRef.current.inFlight,
      busyDrops: gateRef.current.busyDrops + dataRef.current.busyDrops,
      staleResults: gateRef.current.staleResults + dataRef.current.staleResults,
      ...(cache ?? { readyImages: 0, pendingImages: 0, imageBytes: 0 }),
    };
    window.__MANY_FACES_REALTIME__ = next;
    setSnapshot(next);
  }, []);

  const dispose = useCallback(() => {
    sessionRef.current += 1;
    stopPumpRef.current?.(); stopPumpRef.current = null;
    inputAbortRef.current?.abort(); inputAbortRef.current = null;
    if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
    startupTimerRef.current = null;
    rejectStartRef.current?.(new DOMException("Cancelled", "AbortError"));
    rejectStartRef.current = null;
    workerRef.current?.terminate(); workerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) { track.onended = null; track.stop(); }
    streamRef.current = null;
    const video = videoRef.current;
    if (video) { video.onerror = null; video.pause(); video.srcObject = null; video.removeAttribute("src"); video.load(); }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    cacheRef.current?.clear(); cacheRef.current = null;
    resultRef.current = null; currentIdRef.current = null;
    dataRef.current.busyDrops += gateRef.current.busyDrops;
    dataRef.current.staleResults += gateRef.current.staleResults;
    gateRef.current = new LatestFrameGate();
    phaseRef.current = "idle";
  }, []);

  const stop = useCallback((message = "停止しました。もう一度開始できます。", failed = false, code: string | null = null) => {
    // Save the input stage before releasing resources: the diagnostic must say
    // where startup stopped, not merely show an empty video after teardown.
    publish();
    dispose();
    phaseRef.current = failed ? "error" : "idle";
    dataRef.current.message = message;
    dataRef.current.errorCode = code;
    if (!failed) dataRef.current.stage = "idle";
    publish();
  }, [dispose, publish]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput")); }
    catch { /* Device listing is optional; native capture can still be used. */ }
  }, []);

  const present = useCallback(() => {
    const result = resultRef.current, cache = cacheRef.current, canvas = canvasRef.current;
    if (phaseRef.current !== "running" || !result?.face || !cache || !canvas) return;
    const now = performance.now();
    if (now - result.capturedAt > 500) return;
    const candidate = qualityBoundedReadyChoice(result.ranked, value => cache.has(value), currentIdRef.current, !currentIdRef.current || Boolean(decisionRef.current?.shouldSwitch));
    if (!candidate || candidate.id === currentIdRef.current) return;
    const bitmap = cache.get(candidate.id), context = canvas.getContext("2d", { alpha: false });
    if (!bitmap || !context) return;
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    context.fillStyle = "#10141d"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, (canvas.width - bitmap.width * scale) / 2, (canvas.height - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
    currentIdRef.current = candidate.id;
    controllerRef.current.commitSwitch(now);
    if (decisionRef.current) decisionRef.current.shouldSwitch = false;
    const data = dataRef.current;
    data.outputChanges += 1; data.currentName = candidate.name;
    data.currentSource = candidate.sourceName || candidate.creator || "Seed catalog";
    if (data.firstOutputMs === null) data.firstOutputMs = Math.round(now - startedAtRef.current);
    outputTimesRef.current.push(now); latencyRef.current.push(now - result.capturedAt);
    if (latencyRef.current.length > 256) latencyRef.current.shift();
  }, []);

  useEffect(() => { presentRef.current = present; }, [present]);
  useEffect(() => () => dispose(), [dispose]);
  useEffect(() => {
    const environment = cameraEnvironment();
    setEmbedded(environment.embedded); setDirectUrl(window.location.href);
    dataRef.current.environment = environment;
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && ["running", "starting"].includes(phaseRef.current)) stop("画面を離れたためカメラを停止しました。戻ったら再開してください。");
    };
    const pagehide = () => stop("ページを離れたため停止しました。");
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pagehide);
    const timer = setInterval(() => {
      if (phaseRef.current === "running") {
        const now = performance.now(), video = videoRef.current;
        if (gateRef.current.stalled(now)) { stop("顔解析の応答が8秒間ありません。安全のため停止しました。", true, "INFERENCE_STALLED"); return; }
        if (video && (kindRef.current === "camera" || !video.paused) && now - lastFrameAtRef.current > 8000) { stop("入力映像が8秒間更新されていません。カメラの選択、接続、使用中のアプリを確認して再開してください。", true, "VIDEO_FRAMES_STALLED"); return; }
        if (dataRef.current.faceFrames > 20 && dataRef.current.outputChanges === 0 && now - startedAtRef.current > 30000) { stop("顔は検出できましたが、候補画像を表示できませんでした。通信状態を確認してください。", true, "OUTPUT_UNAVAILABLE"); return; }
      }
      publish();
    }, 250);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide); };
  }, [publish, stop]);

  const start = useCallback(async (sourceKind: "camera" | "video", file?: File) => {
    dispose();
    const session = sessionRef.current;
    const isCurrent = () => session === sessionRef.current;
    const video = videoRef.current;
    if (!video) return;
    const cancellation = new AbortController(); inputAbortRef.current = cancellation;
    kindRef.current = sourceKind; setKind(sourceKind);
    const mirrored = sourceKind === "camera"; setMirror(mirrored);
    phaseRef.current = "starting";
    dataRef.current = { ...initialSnapshot(), environment: cameraEnvironment(), mirrorPresentation: mirrored, source: sourceKind, stage: "preflight", message: "入力を確認中…" };
    frameTimesRef.current = []; outputTimesRef.current = []; latencyRef.current = [];
    lastMediaTimeRef.current = -Infinity; decisionRef.current = null; controllerRef.current.reset();
    const canvas = canvasRef.current;
    if (canvas) canvas.width = 512;
    publish();
    try {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw new MediaInputError("BROWSER_UNSUPPORTED", "このブラウザは別スレッドの顔解析に対応していません。新しいブラウザで試してください。");
      if (sourceKind === "camera") {
        assertCameraEnvironment(dataRef.current.environment!);
        dataRef.current.stage = "camera-permission"; dataRef.current.message = "カメラの許可を待っています…"; publish();
        const stream = await openCameraStream(constraints => navigator.mediaDevices.getUserMedia(constraints), { signal: cancellation.signal, deviceId: deviceId || undefined });
        if (!isCurrent()) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        for (const track of stream.getVideoTracks()) track.onended = () => { if (isCurrent()) stop("カメラとの接続が切れました。接続を確認して再開してください。", true, "CAMERA_ENDED"); };
        video.srcObject = stream;
        void refreshDevices();
      } else {
        if (!file || file.size === 0) throw new MediaInputError("VIDEO_EMPTY", "動画ファイルを選んでください。");
        urlRef.current = URL.createObjectURL(file); video.src = urlRef.current;
      }
      video.loop = sourceKind === "video"; video.muted = true; video.playsInline = true;
      video.onerror = () => { if (isCurrent()) stop(`入力映像を再生できませんでした（media code ${video.error?.code ?? 0}）。`, true, "VIDEO_DECODE_ERROR"); };
      dataRef.current.stage = "video-start"; dataRef.current.message = "入力映像が届くのを待っています…"; publish();
      await waitForPlayableVideo(video, cancellation.signal);
      if (!isCurrent()) return;
      dataRef.current.stage = "model-start"; dataRef.current.message = "映像を受信しました。顔解析エンジンを準備中…"; publish();
      const worker = new Worker(new URL("./processor.worker.ts", import.meta.url));
      workerRef.current = worker;
      cacheRef.current = new DecodedImageCache(() => { if (isCurrent()) presentRef.current(); });
      await new Promise<void>((resolve, reject) => {
        rejectStartRef.current = reject;
        startupTimerRef.current = setTimeout(() => reject(new MediaInputError("MODEL_START_TIMEOUT", "解析エンジンの準備が30秒以内に完了しませんでした。再度開始してください。")), 30000);
        worker.onmessage = (event: MessageEvent<FrameResult | { type: "ready"; delegate: string; catalogTotal: number } | { type: "error"; message: string }>) => {
          if (!isCurrent()) return;
          const message = event.data;
          if (message.type === "ready") {
            if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
            startupTimerRef.current = null; rejectStartRef.current = null;
            dataRef.current.delegate = message.delegate; dataRef.current.catalogTotal = message.catalogTotal; resolve();
          } else if (message.type === "error") {
            reject(new Error(message.message)); stop(`顔解析を停止しました: ${message.message}`, true, "MODEL_ERROR");
          } else {
            const now = performance.now();
            if (!gateRef.current.complete(message.id, now)) return;
            dataRef.current.frames += 1; dataRef.current.face = message.face;
            if (message.face) dataRef.current.faceFrames += 1;
            frameTimesRef.current.push(now);
            Object.assign(dataRef.current, { inferenceMs: Math.round(message.inferenceMs), searchMs: Math.round(message.searchMs), candidates: message.candidates, shards: message.shards, catalogError: message.catalogError });
            resultRef.current = message;
            if (message.face) { decisionRef.current = controllerRef.current.observe(now, message.feature, 20); cacheRef.current?.prime(message.ranked); presentRef.current(); }
          }
        };
        worker.onerror = event => {
          if (!isCurrent()) return;
          reject(new Error(event.message || "Worker failed")); stop(`解析スレッドでエラーが起きました: ${event.message || "読み込み失敗"}`, true, "WORKER_ERROR");
        };
        // Analysis always sees original pixels. Mirror presentation applies to
        // BOTH panes and never changes the matching coordinate system.
        worker.postMessage({ type: "init", origin: window.location.origin, mirror: false });
      });
      if (!isCurrent()) return;
      phaseRef.current = "running"; dataRef.current.stage = "running";
      startedAtRef.current = performance.now(); lastFrameAtRef.current = startedAtRef.current;
      dataRef.current.message = "動きに合わせて検索中。入力と結果は同じ向きで表示します。";
      captureCanvasRef.current ??= document.createElement("canvas");
      stopPumpRef.current = startVideoFramePump(video, (now, mediaTime, mode) => {
        if (!isCurrent() || phaseRef.current !== "running") return;
        if (mediaTime !== lastMediaTimeRef.current) { lastFrameAtRef.current = now; lastMediaTimeRef.current = mediaTime; }
        dataRef.current.frameClock = mode;
        const id = gateRef.current.reserve(now, mediaTime, 20);
        if (id === null) return;
        dataRef.current.maxInFlight = Math.max(dataRef.current.maxInFlight, gateRef.current.inFlight);
        try {
          void createInputFrame(video, captureCanvasRef.current!).then(bitmap => {
            if (!isCurrent() || workerRef.current !== worker) { bitmap.close(); return; }
            try { worker.postMessage({ type: "frame", id, capturedAt: now, bitmap, currentId: currentIdRef.current }, [bitmap]); }
            catch (error) { bitmap.close(); throw error; }
          }).catch(error => { if (isCurrent()) { const detail = inputError(error); stop(detail.message, true, detail.code); } });
        } catch (error) { if (isCurrent()) { const detail = inputError(error); stop(detail.message, true, detail.code); } }
      });
      publish();
    } catch (error) { if (isCurrent()) { const detail = inputError(error); stop(detail.message, true, detail.code); } }
  }, [deviceId, dispose, publish, refreshDevices, stop]);

  const busy = snapshot.phase === "starting" || snapshot.phase === "running";
  const downloadDiagnostics = () => {
    const blob = new Blob([JSON.stringify(window.__MANY_FACES_REALTIME__, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "many-faces-realtime-diagnostics.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const presentationClass = mirror ? styles.mirror : "";

  return <main className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>ASTRA / REALTIME · INPUT RECOVERY V1</span><h1>Many Faces</h1><p>カメラの動きに、その場で追従。</p></div><Link href="/live" className={styles.back}>固定動画版へ</Link></header>
    <section className={styles.toolbar} aria-label="入力の操作">
      <button className={styles.primary} onClick={() => void start("camera")} disabled={busy} data-testid="camera-start">カメラを開始</button>
      <label className={`${styles.file} ${busy ? styles.disabled : ""}`}>動画で試す<input type="file" accept="video/*" disabled={busy} data-testid="video-input" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void start("video", file); }} /></label>
      <button onClick={() => stop()} disabled={!busy} data-testid="stop">停止</button>
      <span className={styles.badge} data-phase={snapshot.phase} data-testid="phase">{snapshot.phase === "running" ? "LIVE" : snapshot.phase === "starting" ? "準備中" : snapshot.phase === "error" ? "停止・エラー" : "待機中"}</span>
    </section>
    <div className={styles.hint} style={{display:"flex", flexWrap:"wrap", gap:16, alignItems:"center"}}>
      <label>使用するカメラ <select aria-label="使用するカメラ" value={deviceId} disabled={busy} onChange={event => setDeviceId(event.target.value)}><option value="">自動選択</option>{devices.map((device,index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `カメラ ${index + 1}`}</option>)}</select></label>
      <label><input type="checkbox" checked={mirror} data-testid="mirror-toggle" onChange={event => { setMirror(event.target.checked); dataRef.current.mirrorPresentation = event.target.checked; publish(); }} />入力・結果を両方とも鏡表示</label>
      {embedded && directUrl && <a href={directUrl} target="_blank" rel="noopener noreferrer" data-testid="open-direct">サイトを別タブで開く</a>}
    </div>
    <p className={styles.status} role={snapshot.phase === "error" ? "alert" : "status"}>{snapshot.message}{snapshot.errorCode && <small> [{snapshot.errorCode}]</small>}</p>
    <section className={styles.stages}>
      <div className={styles.panel}><div className={styles.panelTitle}><span>入力</span><small>{kind === "camera" ? "カメラ" : kind === "video" ? "動画 / 連続再生" : "CAMERA OR VIDEO"} · {mirror ? "鏡表示" : "元の向き"}</small></div><div className={styles.stage}><video ref={videoRef} autoPlay muted playsInline controls={kind === "video"} className={presentationClass} data-testid="input-video" />{!busy && <span className={styles.empty}>カメラ・動画を選択</span>}</div></div>
      <div className={styles.panel}><div className={styles.panelTitle}><span>Many Faces</span><small>入力と同じ表示方向</small></div><div className={styles.stage}><canvas ref={canvasRef} width={512} height={512} className={presentationClass} data-testid="output-canvas" />{snapshot.outputChanges === 0 && <span className={styles.empty}>{snapshot.phase === "starting" ? "解析エンジンを準備中" : snapshot.phase === "running" ? (snapshot.face ? "候補画像を準備中" : "顔を探しています") : "ここに結果が表示されます"}</span>}{snapshot.phase === "running" && snapshot.frames > 0 && !snapshot.face && snapshot.outputChanges > 0 && <span className={styles.notice}>顔を見失いました</span>}</div><div className={styles.attribution}>{snapshot.currentName} <span>{snapshot.currentSource}</span></div></div>
    </section>
    <section className={styles.metrics} aria-label="実測値"><div><small>解析</small><strong>{snapshot.detectionFps}<em>fps</em></strong></div><div><small>実際の顔の切替</small><strong>{snapshot.outputFps}<em>回/秒</em></strong></div><div><small>取得から描画まで・95%</small><strong>{snapshot.latencyP95Ms}<em>ms</em></strong></div><div><small>読み込み済みの候補</small><strong>{snapshot.candidates.toLocaleString()}<em>顔</em></strong></div></section>
    <p className={styles.hint}>止まっている間は同じ顔を保ちます。遅いフレームは捨て、新しい動きから処理します。入力映像は端末内で解析し、サーバーには送りません。</p>
    <details className={styles.diagnostics}><summary>動作の詳細・診断</summary><p>段階 {snapshot.stage} · 映像 {snapshot.videoWidth}×{snapshot.videoHeight} · readyState {snapshot.videoReadyState} · {snapshot.frameClock}</p><p>カメラ {snapshot.trackState} · 入力ミュート {String(snapshot.trackMuted)} · 再生停止 {String(snapshot.videoPaused)} · エラー {snapshot.errorCode ?? "なし"}</p><p>顔検出 {snapshot.faceFrames} / {snapshot.frames} フレーム · 出力切替 {snapshot.outputChanges} 回 · {snapshot.delegate} / Web Worker</p><p>カタログ {snapshot.catalogTotal.toLocaleString()} 顔 · {snapshot.shards} shards · 画像 {snapshot.readyImages} 枚 / {(snapshot.imageBytes / 1048576).toFixed(1)} MB · 読み込み待ち {snapshot.pendingImages}</p><p>解析中の最大フレーム数 {snapshot.maxInFlight} · 混雑で省略 {snapshot.busyDrops} · 遅延で破棄 {snapshot.staleResults} · 画像失敗 {snapshot.imageFailures}</p><p>推論 {snapshot.inferenceMs} ms · 検索 {snapshot.searchMs} ms · 最初の表示 {snapshot.firstOutputMs === null ? "未表示" : `${snapshot.firstOutputMs} ms`}</p>{snapshot.catalogError && <p role="alert">カタログ通信: {snapshot.catalogError}</p>}<button onClick={downloadDiagnostics}>診断データを保存</button></details>
    <footer className={styles.footer}>実機カメラの相性と顔の一致品質は引き続き確認が必要です。静止中の「0回/秒」は正常です。診断データには映像や55次元の顔特徴量を含めません。</footer>
  </main>;
}
