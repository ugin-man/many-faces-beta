"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ResponsiveSwitchController, type ResponsiveSwitchDecision } from "../../live-responsive-runtime";
import { acquireCurrentStream, cameraErrorMessage, LatestFrameGate, qualityBoundedReadyChoice, type FrameResult } from "./runtime";
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
};
const initialSnapshot = (): Snapshot => ({
  phase: "idle", message: "カメラ、または動画を選んで開始", delegate: "—", source: "—",
  frames: 0, faceFrames: 0, outputChanges: 0, detectionFps: 0, outputFps: 0,
  latencyP95Ms: 0, inferenceMs: 0, searchMs: 0, candidates: 0, shards: 0,
  readyImages: 0, pendingImages: 0, imageBytes: 0, imageFailures: 0,
  inFlight: 0, maxInFlight: 0, busyDrops: 0, staleResults: 0, catalogTotal: 0,
  firstOutputMs: null, face: false, currentName: "—", currentSource: "—", catalogError: null,
});

declare global { interface Window { __MANY_FACES_REALTIME__?: Snapshot; } }

export default function AstraRealtimeClient() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [kind, setKind] = useState<"camera" | "video" | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const urlRef = useRef<string | null>(null);
  const sessionRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const dataRef = useRef(initialSnapshot());
  const gateRef = useRef(new LatestFrameGate());
  const cacheRef = useRef<DecodedImageCache | null>(null);
  const controllerRef = useRef(new ResponsiveSwitchController());
  const decisionRef = useRef<ResponsiveSwitchDecision | null>(null);
  const resultRef = useRef<FrameResult | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const scheduledRef = useRef<{ kind: "video" | "raf"; id: number } | null>(null);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejectStartRef = useRef<((error: Error) => void) | null>(null);
  const presentRef = useRef<() => void>(() => undefined);
  const startedAtRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);
  const outputTimesRef = useRef<number[]>([]);
  const latencyRef = useRef<number[]>([]);

  const publish = useCallback(() => {
    const now = performance.now();
    for (const times of [frameTimesRef.current, outputTimesRef.current]) {
      while (times.length && times[0] < now - 1000) times.shift();
    }
    const latency = [...latencyRef.current].sort((a, b) => a - b);
    const cache = cacheRef.current?.stats();
    const next: Snapshot = {
      ...dataRef.current,
      phase: phaseRef.current,
      detectionFps: phaseRef.current === "running" ? frameTimesRef.current.length : 0,
      outputFps: phaseRef.current === "running" ? outputTimesRef.current.length : 0,
      latencyP95Ms: latency.length ? Math.round(latency[Math.ceil(latency.length * 0.95) - 1]) : 0,
      inFlight: gateRef.current.inFlight,
      busyDrops: gateRef.current.busyDrops,
      staleResults: gateRef.current.staleResults,
      ...(cache ?? { readyImages: 0, pendingImages: 0, imageBytes: 0 }),
    };
    window.__MANY_FACES_REALTIME__ = next;
    setSnapshot(next);
  }, []);

  const dispose = useCallback(() => {
    sessionRef.current += 1;
    const video = videoRef.current;
    const scheduled = scheduledRef.current;
    if (scheduled?.kind === "video") video?.cancelVideoFrameCallback?.(scheduled.id);
    else if (scheduled) cancelAnimationFrame(scheduled.id);
    scheduledRef.current = null;
    if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
    startupTimerRef.current = null;
    rejectStartRef.current?.(new DOMException("Cancelled", "AbortError"));
    rejectStartRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) { track.onended = null; track.stop(); }
    streamRef.current = null;
    if (video) {
      video.onerror = null;
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    cacheRef.current?.clear();
    cacheRef.current = null;
    resultRef.current = null;
    currentIdRef.current = null;
    const gate = gateRef.current;
    gateRef.current = new LatestFrameGate();
    dataRef.current.busyDrops = gate.busyDrops;
    dataRef.current.staleResults = gate.staleResults;
    phaseRef.current = "idle";
  }, []);

  const stop = useCallback((message = "停止しました。もう一度開始できます。", failed = false) => {
    dispose();
    phaseRef.current = failed ? "error" : "idle";
    dataRef.current.message = message;
    publish();
  }, [dispose, publish]);

  const present = useCallback(() => {
    const result = resultRef.current;
    const cache = cacheRef.current;
    const canvas = canvasRef.current;
    if (phaseRef.current !== "running" || !result?.face || !cache || !canvas) return;
    const now = performance.now();
    if (now - result.capturedAt > 500) return;
    const candidate = qualityBoundedReadyChoice(result.ranked, (value) => cache.has(value), currentIdRef.current, !currentIdRef.current || Boolean(decisionRef.current?.shouldSwitch));
    if (!candidate || candidate.id === currentIdRef.current) return;
    const bitmap = cache.get(candidate.id);
    const context = canvas.getContext("2d", { alpha: false });
    if (!bitmap || !context) return;
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    context.fillStyle = "#10141d";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, (canvas.width - bitmap.width * scale) / 2, (canvas.height - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
    currentIdRef.current = candidate.id;
    controllerRef.current.commitSwitch(now);
    if (decisionRef.current) decisionRef.current.shouldSwitch = false;
    const data = dataRef.current;
    data.outputChanges += 1;
    data.currentName = candidate.name;
    data.currentSource = candidate.sourceName || candidate.creator || "Seed catalog";
    if (data.firstOutputMs === null) data.firstOutputMs = Math.round(now - startedAtRef.current);
    outputTimesRef.current.push(now);
    latencyRef.current.push(now - result.capturedAt);
    if (latencyRef.current.length > 256) latencyRef.current.shift();
  }, []);

  useEffect(() => { presentRef.current = present; }, [present]);
  useEffect(() => () => dispose(), [dispose]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && ["running", "starting"].includes(phaseRef.current)) stop("画面を離れたためカメラを停止しました。戻ったら再開してください。");
    };
    document.addEventListener("visibilitychange", hidden);
    const pagehide = () => stop("ページを離れたため停止しました。");
    window.addEventListener("pagehide", pagehide);
    const timer = setInterval(() => {
      if (phaseRef.current === "running") {
        const now = performance.now();
        if (gateRef.current.stalled(now)) { stop("顔解析の応答が8秒間ありません。安全のため停止しました。", true); return; }
        const video = videoRef.current;
        if (video && !video.paused && now - lastFrameAtRef.current > 8000) { stop("入力映像が8秒間届いていません。カメラを確認して再開してください。", true); return; }
        if (dataRef.current.faceFrames > 20 && dataRef.current.outputChanges === 0 && now - startedAtRef.current > 30000) { stop("顔は検出できましたが、候補画像を表示できませんでした。通信状態を確認してください。", true); return; }
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
    setKind(sourceKind);
    phaseRef.current = "starting";
    dataRef.current = { ...initialSnapshot(), phase: "starting", source: sourceKind === "camera" ? "camera" : (file?.name ?? "video"), message: "入力と解析エンジンを準備中…" };
    frameTimesRef.current = [];
    outputTimesRef.current = [];
    latencyRef.current = [];
    decisionRef.current = null;
    controllerRef.current.reset();
    const canvas = canvasRef.current;
    if (canvas) canvas.width = 512;
    publish();
    try {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw new Error("このブラウザは別スレッドの顔解析に対応していません。PCの新しいChromeで試してください。");
      if (sourceKind === "camera") {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("カメラにはHTTPS、またはlocalhostで開いた画面が必要です。");
        const stream = await acquireCurrentStream(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: false }), isCurrent);
        if (!isCurrent()) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        for (const track of stream.getVideoTracks()) track.onended = () => { if (isCurrent()) stop("カメラとの接続が切れました。接続を確認して再開してください。", true); };
        video.srcObject = stream;
      } else {
        if (!file || file.size === 0) throw new Error("動画ファイルを選んでください。");
        urlRef.current = URL.createObjectURL(file);
        video.src = urlRef.current;
      }
      video.loop = sourceKind === "video";
      video.muted = true;
      video.playsInline = true;
      video.onerror = () => { if (isCurrent()) stop("入力映像を再生できませんでした。別の動画形式を試してください。", true); };
      await video.play();
      if (!isCurrent()) return;
      const worker = new Worker(new URL("./processor.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      cacheRef.current = new DecodedImageCache(() => { if (isCurrent()) presentRef.current(); });
      await new Promise<void>((resolve, reject) => {
        rejectStartRef.current = reject;
        startupTimerRef.current = setTimeout(() => reject(new Error("解析エンジンの準備が30秒以内に完了しませんでした。再度開始してください。")), 30000);
        worker.onmessage = (event: MessageEvent<FrameResult | { type: "ready"; delegate: string; catalogTotal: number } | { type: "error"; message: string }>) => {
          if (!isCurrent()) return;
          const message = event.data;
          if (message.type === "ready") {
            if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
            startupTimerRef.current = null;
            rejectStartRef.current = null;
            dataRef.current.delegate = message.delegate;
            dataRef.current.catalogTotal = message.catalogTotal;
            resolve();
          } else if (message.type === "error") {
            reject(new Error(message.message));
            stop(`顔解析を停止しました: ${message.message}`, true);
          } else {
            const now = performance.now();
            if (!gateRef.current.complete(message.id, now)) return;
            dataRef.current.frames += 1;
            dataRef.current.face = message.face;
            if (message.face) dataRef.current.faceFrames += 1;
            frameTimesRef.current.push(now);
            Object.assign(dataRef.current, { inferenceMs: Math.round(message.inferenceMs), searchMs: Math.round(message.searchMs), candidates: message.candidates, shards: message.shards, catalogError: message.catalogError });
            resultRef.current = message;
            if (message.face) {
              decisionRef.current = controllerRef.current.observe(now, message.feature, 20);
              cacheRef.current?.prime(message.ranked);
              presentRef.current();
            }
          }
        };
        worker.onerror = (event) => {
          if (!isCurrent()) return;
          reject(new Error(event.message || "Worker failed"));
          stop(`解析スレッドでエラーが起きました: ${event.message || "読み込み失敗"}`, true);
        };
        worker.postMessage({ type: "init", origin: window.location.origin, mirror: sourceKind === "camera" });
      });
      if (!isCurrent()) return;
      phaseRef.current = "running";
      startedAtRef.current = performance.now();
      lastFrameAtRef.current = startedAtRef.current;
      dataRef.current.message = "動きに合わせて検索中。最初は正面を向いてください。";
      const schedule = () => {
        if (!isCurrent() || phaseRef.current !== "running") return;
        if (typeof video.requestVideoFrameCallback === "function") {
          scheduledRef.current = { kind: "video", id: video.requestVideoFrameCallback((now, metadata) => sample(now, metadata.mediaTime)) };
        } else {
          scheduledRef.current = { kind: "raf", id: requestAnimationFrame((now) => sample(now, video.currentTime)) };
        }
      };
      const sample = (now: number, mediaTime: number) => {
        if (!isCurrent() || phaseRef.current !== "running") return;
        schedule();
        if (video.readyState < 2 || video.paused || video.ended) return;
        lastFrameAtRef.current = now;
        const id = gateRef.current.reserve(now, mediaTime, 20);
        if (id === null) return;
        dataRef.current.maxInFlight = Math.max(dataRef.current.maxInFlight, gateRef.current.inFlight);
        void createImageBitmap(video).then((bitmap) => {
          if (!isCurrent() || workerRef.current !== worker) { bitmap.close(); return; }
          worker.postMessage({ type: "frame", id, capturedAt: now, bitmap, currentId: currentIdRef.current }, [bitmap]);
        }).catch((error) => { if (isCurrent()) stop(`映像フレームを読み込めません: ${cameraErrorMessage(error)}`, true); });
      };
      schedule();
      publish();
    } catch (error) {
      if (isCurrent()) stop(cameraErrorMessage(error), true);
    }
  }, [dispose, publish, stop]);

  const busy = snapshot.phase === "starting" || snapshot.phase === "running";
  const downloadDiagnostics = () => {
    const blob = new Blob([JSON.stringify(window.__MANY_FACES_REALTIME__, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "many-faces-realtime-diagnostics.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <main className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>ASTRA / REALTIME PREVIEW</span><h1>Many Faces</h1><p>カメラの動きに、その場で追従。</p></div><Link href="/live" className={styles.back}>固定動画版へ</Link></header>
    <section className={styles.toolbar} aria-label="入力の操作">
      <button className={styles.primary} onClick={() => void start("camera")} disabled={busy} data-testid="camera-start">カメラを開始</button>
      <label className={`${styles.file} ${busy ? styles.disabled : ""}`}>動画で試す<input type="file" accept="video/*" disabled={busy} data-testid="video-input" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void start("video", file); }} /></label>
      <button onClick={() => stop()} disabled={!busy} data-testid="stop">停止</button>
      <span className={styles.badge} data-phase={snapshot.phase} data-testid="phase">{snapshot.phase === "running" ? "LIVE" : snapshot.phase === "starting" ? "準備中" : snapshot.phase === "error" ? "停止・エラー" : "待機中"}</span>
    </section>
    <p className={styles.status} role={snapshot.phase === "error" ? "alert" : "status"}>{snapshot.message}</p>
    <section className={styles.stages}>
      <div className={styles.panel}><div className={styles.panelTitle}><span>入力</span><small>{kind === "camera" ? "カメラ / 左右反転" : kind === "video" ? "動画 / 連続再生" : "CAMERA OR VIDEO"}</small></div><div className={styles.stage}><video ref={videoRef} muted playsInline controls={kind === "video"} className={kind === "camera" ? styles.mirror : ""} data-testid="input-video" />{!busy && <span className={styles.empty}>カメラ・動画を選択</span>}</div></div>
      <div className={styles.panel}><div className={styles.panelTitle}><span>Many Faces</span><small>姿勢・表情が近い写真</small></div><div className={styles.stage}><canvas ref={canvasRef} width={512} height={512} data-testid="output-canvas" />{snapshot.outputChanges === 0 && <span className={styles.empty}>{snapshot.phase === "starting" ? "解析エンジンを準備中" : snapshot.phase === "running" ? (snapshot.face ? "候補画像を準備中" : "顔を探しています") : "ここに結果が表示されます"}</span>}{snapshot.phase === "running" && snapshot.frames > 0 && !snapshot.face && snapshot.outputChanges > 0 && <span className={styles.notice}>顔を見失いました</span>}</div><div className={styles.attribution}>{snapshot.currentName} <span>{snapshot.currentSource}</span></div></div>
    </section>
    <section className={styles.metrics} aria-label="実測値"><div><small>解析</small><strong>{snapshot.detectionFps}<em>fps</em></strong></div><div><small>実際の顔の切替</small><strong>{snapshot.outputFps}<em>回/秒</em></strong></div><div><small>取得から描画まで・95%</small><strong>{snapshot.latencyP95Ms}<em>ms</em></strong></div><div><small>読み込み済みの候補</small><strong>{snapshot.candidates.toLocaleString()}<em>顔</em></strong></div></section>
    <p className={styles.hint}>止まっている間は同じ顔を保ちます。遅いフレームは捨て、新しい動きから処理します。入力映像は端末内で解析し、サーバーには送りません。</p>
    <details className={styles.diagnostics}><summary>動作の詳細</summary><p>顔検出 {snapshot.faceFrames} / {snapshot.frames} フレーム · 出力切替 {snapshot.outputChanges} 回 · {snapshot.delegate} / Web Worker</p><p>カタログ {snapshot.catalogTotal.toLocaleString()} 顔 · {snapshot.shards} shards · 画像 {snapshot.readyImages} 枚 / {(snapshot.imageBytes / 1048576).toFixed(1)} MB · 読み込み待ち {snapshot.pendingImages}</p><p>解析中の最大フレーム数 {snapshot.maxInFlight} · 混雑で省略 {snapshot.busyDrops} · 遅延で破棄 {snapshot.staleResults} · 画像失敗 {snapshot.imageFailures}</p><p>推論 {snapshot.inferenceMs} ms · 検索 {snapshot.searchMs} ms · 最初の表示 {snapshot.firstOutputMs === null ? "未表示" : `${snapshot.firstOutputMs} ms`}</p>{snapshot.catalogError && <p role="alert">カタログ通信: {snapshot.catalogError}</p>}<button onClick={downloadDiagnostics}>診断データを保存</button></details>
    <footer className={styles.footer}>動作確認用のプレビューです。実機カメラの相性と、顔の一致品質は引き続き確認が必要です。静止中の「0回/秒」は正常です。</footer>
  </main>;
}
