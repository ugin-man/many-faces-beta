"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FaceLandmarker,
  FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { faceFeatureFromScores } from "./face-actions";
import {
  faceGeometryFromLandmarks,
  type FaceGeometry,
  type SequenceFrame,
} from "./offline-matching";
import {
  rankProjectionCandidateModesTwoStage,
  type ProjectionError,
} from "./projection-matching";
import { FaithfulStrictSequence } from "./live-faithful-sequence";
import styles from "./live-faithful-lab.module.css";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SAMPLE_FPS = 30;
const INDEX_BEAM_PER_FRAME = 64;

type CatalogEntry = {
  id: string;
  name?: string;
  image?: string;
  pack?: string;
  offset?: number;
  length?: number;
  feature: number[];
  shape?: string;
  mesh?: string;
  projection?: string;
  layout?: [number, number, number, number];
  sourceName?: string;
  creator?: string;
};

type CatalogManifest = {
  schemaVersion: 1 | 2 | 3;
  catalogId?: string;
  generatedAt?: string;
  totalFaces: number;
  indexFile?: string;
  indexFiles?: string[];
  cells: Record<string, { shards?: string[]; shard?: string }>;
};

type Candidate = {
  id: string;
  name: string;
  url: string;
  feature: number[];
  geometry: FaceGeometry;
  sourceName?: string;
  creator?: string;
};

type QueueItem = {
  frame: SequenceFrame;
  capturedAt: number;
};

type Output = {
  candidate: Candidate;
  error: ProjectionError;
  frameTime: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function quantizePose(value: number) {
  const degrees = clamp(value * 90, -45, 45);
  return Math.round(degrees / 3) * 3 / 90;
}

function featureFromResult(result: FaceLandmarkerResult) {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  const scores = new Map(
    (result.faceBlendshapes[0]?.categories ?? []).map((category) => [
      category.categoryName,
      category.score,
    ]),
  );
  let pose = [0, 0, 0];
  if (matrix && matrix.length >= 11) {
    const pitch = Math.atan2(matrix[9], matrix[10]);
    const yaw = Math.atan2(-matrix[8], Math.hypot(matrix[9], matrix[10]));
    const roll = Math.atan2(matrix[4], matrix[0]);
    pose = [
      yaw / (Math.PI / 2),
      pitch * 1.4 / (Math.PI / 2),
      roll / (Math.PI / 2),
    ].map(quantizePose);
  }
  return faceFeatureFromScores(pose, scores);
}

function decodeVector(encoded: string | undefined) {
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (!bytes.byteLength || bytes.byteLength % 2) return null;
    const values = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    return Float32Array.from(values, (value) => value / 4096);
  } catch {
    return null;
  }
}

function candidateUrl(entry: CatalogEntry) {
  if (entry.image) return `/api/catalog/image?id=${encodeURIComponent(entry.image)}`;
  if (!entry.pack || entry.offset == null || entry.length == null) return null;
  return `/api/catalog/image?pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}`;
}

function candidateFromEntry(entry: CatalogEntry): Candidate | null {
  const structure = decodeVector(entry.shape);
  const surface = decodeVector(entry.mesh);
  const projection = decodeVector(entry.projection);
  const url = candidateUrl(entry);
  if (
    !entry.id || !Array.isArray(entry.feature) || entry.feature.length < 22 ||
    !structure || structure.length < 13 ||
    !surface || surface.length < 300 ||
    !projection || projection.length < 936 ||
    !entry.layout || entry.layout.length !== 4 ||
    !url
  ) return null;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    url,
    feature: entry.feature,
    geometry: { structure, surface, projection, layout: entry.layout },
    sourceName: entry.sourceName,
    creator: entry.creator,
  };
}

function localCandidates(frame: SequenceFrame, candidates: Candidate[]) {
  const within = (yawLimit: number, pitchLimit: number) => candidates.filter((candidate) =>
    Math.abs(Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0)) * 90 <= yawLimit &&
    Math.abs(Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0)) * 90 <= pitchLimit
  );
  let local = within(12, 15);
  if (local.length < Math.min(384, candidates.length)) local = within(18, 21);
  return local.length >= 4 ? local : candidates;
}

export default function LiveFaithfulLab() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const candidatesRef = useRef<Candidate[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  const processingRef = useRef(false);
  const runningRef = useRef(false);
  const captureStartRef = useRef(0);
  const lastCaptureRef = useRef(0);
  const capturedRef = useRef(0);
  const processedRef = useRef(0);
  const latestCapturedTimeRef = useRef(0);
  const sequenceRef = useRef(new FaithfulStrictSequence<Candidate>());
  const frameCallbackRef = useRef<number | null>(null);
  const processQueueRef = useRef<() => void>(() => undefined);

  const [engineReady, setEngineReady] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogCount, setCatalogCount] = useState(0);
  const [catalogLoaded, setCatalogLoaded] = useState(0);
  const [candidateCount, setCandidateCount] = useState(0);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<Output | null>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [captured, setCaptured] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [lagSeconds, setLagSeconds] = useState(0);
  const [frameMs, setFrameMs] = useState(0);
  const [searchPool, setSearchPool] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (frameCallbackRef.current !== null) {
      const video = videoRef.current as HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void;
      } | null;
      video?.cancelVideoFrameCallback?.(frameCallbackRef.current);
      frameCallbackRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    async function prepare() {
      try {
        const manifestResponse = await fetch("/api/catalog/manifest", { cache: "no-store" });
        if (!manifestResponse.ok) throw new Error(`CATALOG ${manifestResponse.status}`);
        const manifest = await manifestResponse.json() as CatalogManifest;
        if (disposed) return;
        setCatalogCount(manifest.totalFaces);
        const indexFiles = manifest.indexFiles?.length
          ? manifest.indexFiles
          : manifest.indexFile
            ? [manifest.indexFile]
            : [...new Set(Object.values(manifest.cells).flatMap((cell) =>
              cell.shards?.length ? cell.shards : cell.shard ? [cell.shard] : []
            ))];
        const entries: CatalogEntry[] = [];
        for (let index = 0; index < indexFiles.length; index += 2) {
          const batch = indexFiles.slice(index, index + 2);
          const payloads = await Promise.all(batch.map(async (file) => {
            const catalog = manifest.catalogId || manifest.generatedAt || "current";
            const endpoint = manifest.indexFiles?.length || manifest.indexFile
              ? `/api/catalog/index?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`
              : `/api/catalog/shard?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`;
            const response = await fetch(endpoint);
            if (!response.ok) throw new Error(`INDEX ${response.status}`);
            return response.json() as Promise<{ items?: CatalogEntry[] }>;
          }));
          payloads.forEach((payload) => entries.push(...(payload.items ?? [])));
          if (!disposed) setCatalogLoaded(Math.min(index + batch.length, indexFiles.length));
        }
        const candidates = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
          .flatMap((entry) => {
            const candidate = candidateFromEntry(entry);
            return candidate ? [candidate] : [];
          });
        if (candidates.length < 4) throw new Error("骨格比較できる顔素材がありません");
        candidatesRef.current = candidates;
        if (!disposed) {
          setCandidateCount(candidates.length);
          setCatalogReady(true);
        }

        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        const options = {
          runningMode: "IMAGE" as const,
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: 0.45,
          minFacePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        };
        let landmarker: FaceLandmarker;
        try {
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...options,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          });
        } catch {
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...options,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          });
        }
        if (disposed) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setEngineReady(true);
      } catch (caught) {
        console.error("Faithful live setup failed.", caught);
        if (!disposed) setError(caught instanceof Error ? caught.message : "準備に失敗しました");
      }
    }
    void prepare();
    return () => {
      disposed = true;
      stop();
      landmarkerRef.current?.close();
    };
  }, [stop]);

  const processQueue = useCallback(() => {
    if (processingRef.current) return;
    processingRef.current = true;
    const run = () => {
      if (!queueRef.current.length) {
        processingRef.current = false;
        return;
      }
      const item = queueRef.current.shift() as QueueItem;
      setQueueSize(queueRef.current.length);
      const started = performance.now();
      const pool = localCandidates(item.frame, candidatesRef.current);
      const ranked = rankProjectionCandidateModesTwoStage(
        item.frame,
        pool,
        INDEX_BEAM_PER_FRAME,
        Math.min(1_024, pool.length),
      ).strict;
      const choice = sequenceRef.current.push(item.frame, ranked);
      const elapsed = performance.now() - started;
      processedRef.current += 1;
      setProcessed(processedRef.current);
      setFrameMs(elapsed);
      setSearchPool(pool.length);
      if (choice) {
        setOutput({
          candidate: choice.candidate,
          error: choice.error,
          frameTime: choice.frame.time,
        });
        setLagSeconds(Math.max(0, latestCapturedTimeRef.current - choice.frame.time));
      }
      window.setTimeout(run, 0);
    };
    run();
  }, []);

  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  const start = useCallback(async () => {
    if (!engineReady || !catalogReady || runningRef.current) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
      const video = videoRef.current;
      if (!video) throw new Error("VIDEO ELEMENT MISSING");
      streamRef.current = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      queueRef.current = [];
      sequenceRef.current.reset();
      capturedRef.current = 0;
      processedRef.current = 0;
      latestCapturedTimeRef.current = 0;
      captureStartRef.current = performance.now();
      lastCaptureRef.current = 0;
      setOutput(null);
      setQueueSize(0);
      setCaptured(0);
      setProcessed(0);
      setLagSeconds(0);
      setFrameMs(0);
      runningRef.current = true;
      setRunning(true);

      const frameVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: (now: number) => void) => number;
      };
      const capture = (now: number) => {
        if (!runningRef.current) return;
        const minimumInterval = 1_000 / SAMPLE_FPS;
        if (now - lastCaptureRef.current >= minimumInterval) {
          lastCaptureRef.current = now;
          const landmarker = landmarkerRef.current;
          if (landmarker && video.readyState >= 2) {
            const result = landmarker.detect(video);
            const landmarks = result.faceLandmarks[0];
            if (landmarks && result.faceBlendshapes.length) {
              const geometry = faceGeometryFromLandmarks(
                landmarks,
                video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1,
              );
              if (geometry) {
                const time = (now - captureStartRef.current) / 1_000;
                const frame: SequenceFrame = {
                  time,
                  feature: featureFromResult(result),
                  geometry,
                };
                queueRef.current.push({ frame, capturedAt: now });
                capturedRef.current += 1;
                latestCapturedTimeRef.current = time;
                setCaptured(capturedRef.current);
                setQueueSize(queueRef.current.length);
                processQueueRef.current();
              }
            }
          }
        }
        if (frameVideo.requestVideoFrameCallback) {
          frameCallbackRef.current = frameVideo.requestVideoFrameCallback(capture);
        } else {
          frameCallbackRef.current = requestAnimationFrame(capture);
        }
      };
      if (frameVideo.requestVideoFrameCallback) {
        frameCallbackRef.current = frameVideo.requestVideoFrameCallback(capture);
      } else {
        frameCallbackRef.current = requestAnimationFrame(capture);
      }
    } catch (caught) {
      console.error("Faithful camera start failed.", caught);
      setError("カメラを開始できませんでした");
      stop();
    }
  }, [catalogReady, engineReady, stop]);

  const ready = engineReady && catalogReady;
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p>MANY FACES / FAITHFUL LIVE BASELINE</p>
          <h1>動画版を削らず、そのままカメラへ。</h1>
        </div>
        <nav className={styles.nav}>
          <Link href="/">VIDEO LAB</Link>
          <Link href="/live/fast">FAST LIVE</Link>
          <Link href="/live/legacy">LEGACY</Link>
          <span className={styles.badge}>{ready ? "READY" : "PREPARING"}</span>
        </nav>
      </header>

      <section className={styles.grid}>
        <div className={styles.stage}>
          {output ? (
            <img src={output.candidate.url} alt="動画版と同じ処理で選ばれた顔" draggable={false} />
          ) : (
            <div className={styles.empty}>
              <strong>{ready ? "CAMERA START" : "LOADING FULL CATALOG"}</strong>
              <span>高速化・先読み・ready fallbackなし</span>
            </div>
          )}
          <div className={styles.camera}>
            <span>RAW CAMERA / 30 FPS TARGET</span>
            <video ref={videoRef} muted playsInline />
          </div>
          <div className={styles.meta}>
            <span>{output?.candidate.name ?? "NO OUTPUT"}</span>
            <b>{output?.candidate.sourceName || output?.candidate.creator || "—"}</b>
          </div>
        </div>

        <aside className={styles.telemetry}>
          <div><span>CAPTURED</span><strong>{captured}</strong></div>
          <div><span>PROCESSED</span><strong>{processed}</strong></div>
          <div><span>FIFO QUEUE</span><strong>{queueSize} frames</strong></div>
          <div><span>PIPELINE LAG</span><strong>{lagSeconds.toFixed(2)} s</strong></div>
          <div><span>FRAME SEARCH</span><strong>{frameMs.toFixed(1)} ms</strong></div>
          <div><span>SEARCH POOL</span><strong>{searchPool.toLocaleString()}</strong></div>
          <div><span>STRICT ERROR</span><strong>{output?.error.strictTotal.toFixed(4) ?? "—"}</strong></div>
          <div><span>CATALOG</span><strong>{candidateCount.toLocaleString()} / {catalogCount.toLocaleString()}</strong></div>
        </aside>
      </section>

      <section className={styles.controls}>
        <div className={styles.buttons}>
          <button type="button" onClick={start} disabled={!ready || running}>カメラを開始</button>
          <button type="button" onClick={stop} disabled={!running}>停止</button>
        </div>
        {!catalogReady && catalogCount > 0 && (
          <p className={styles.progress}>FULL INDEX: {catalogLoaded} chunks / {catalogCount.toLocaleString()} faces</p>
        )}
        <p className={styles.note}>
          この画面では入力側のフレームをFIFOへ積み、動画版と同じ3度量子化、同じ12°/15°→18°/21°の候補絞り込み、同じ二段階3D投影比較、strict 64候補、同じ別人制約・12フレームcooldown・経路連続性で順番に処理します。処理が追いつかなければFIFOが伸び、表示だけが遅れます。
        </p>
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </main>
  );
}
