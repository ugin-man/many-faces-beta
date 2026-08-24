"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { faceFeatureFromScores } from "../face-actions";
import {
  faceGeometryFromLandmarks,
  type FaceGeometry,
  type SequenceFrame,
} from "../offline-matching";
import {
  rankProjectionCandidateModesTwoStage,
  type ProjectionError,
} from "../projection-matching";
import { DelayedFaithfulCommitter } from "./faithful-delay";
import styles from "../live-faithful-lab.module.css";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const CAPTURE_FPS = 30;
const CAPTURE_INTERVAL_MS = 1_000 / CAPTURE_FPS;
const INDEX_BEAM_PER_FRAME = 64;
const CAPTURE_SIZE = 512;

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
  blob: Blob;
  time: number;
};

type Output = {
  candidate: Candidate;
  error: ProjectionError;
  frameTime: number;
};

type WorkerMessage = {
  type?: string;
  blob?: Blob;
  timestamp?: number;
  sequence?: number;
  gapMs?: number;
  estimatedSourceDrops?: number;
  rawQueue?: number;
  message?: string;
};

type VideoFrameCallbackMetadata = {
  mediaTime?: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (id: number) => void;
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
    const bytes = Uint8Array.from(
      atob(encoded),
      (character) => character.charCodeAt(0),
    );
    if (!bytes.byteLength || bytes.byteLength % 2) return null;
    const values = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    );
    return Float32Array.from(values, (value) => value / 4096);
  } catch {
    return null;
  }
}

function candidateUrl(entry: CatalogEntry) {
  if (entry.image) {
    return `/api/catalog/image?id=${encodeURIComponent(entry.image)}`;
  }
  if (!entry.pack || entry.offset == null || entry.length == null) return null;
  return `/api/catalog/image?pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}`;
}

function candidateFromEntry(entry: CatalogEntry): Candidate | null {
  const structure = decodeVector(entry.shape);
  const surface = decodeVector(entry.mesh);
  const projection = decodeVector(entry.projection);
  const url = candidateUrl(entry);
  if (
    !entry.id ||
    !Array.isArray(entry.feature) ||
    entry.feature.length < 22 ||
    !structure ||
    structure.length < 13 ||
    !surface ||
    surface.length < 300 ||
    !projection ||
    projection.length < 936 ||
    !entry.layout ||
    entry.layout.length !== 4 ||
    !url
  ) {
    return null;
  }
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
  const within = (yawLimit: number, pitchLimit: number) =>
    candidates.filter(
      (candidate) =>
        Math.abs(
          Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0),
        ) * 90 <= yawLimit &&
        Math.abs(
          Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0),
        ) * 90 <= pitchLimit,
    );
  let local = within(12, 15);
  if (local.length < Math.min(384, candidates.length)) {
    local = within(18, 21);
  }
  return local.length >= 4 ? local : candidates;
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("FRAME ENCODE FAILED"))),
      "image/webp",
      0.94,
    );
  });
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function decodeImage(url: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    let settled = false;
    const timeout = window.setTimeout(() => finish(false), 20_000);
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      if (success) resolve();
      else reject(new Error("OUTPUT IMAGE DECODE FAILED"));
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
    void image.decode?.().then(() => finish(true)).catch(() => undefined);
  });
}

export default function FaithfulLiveClient() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerTrackRef = useRef<MediaStreamTrack | null>(null);
  const fallbackFrameCallbackRef = useRef<number | null>(null);
  const fallbackEncodeChainRef = useRef<Promise<void>>(Promise.resolve());
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackPreviousTimeRef = useRef<number | null>(null);
  const fallbackDropEstimateRef = useRef(0);

  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const candidatesRef = useRef<Candidate[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  const processingRef = useRef(false);
  const capturingRef = useRef(false);
  const captureFinishedRef = useRef(true);
  const disposedRef = useRef(false);
  const firstTimestampRef = useRef<number | null>(null);
  const latestCapturedTimeRef = useRef(0);
  const decodedImagesRef = useRef(new Map<string, Promise<void>>());
  const committerRef = useRef(
    new DelayedFaithfulCommitter<Candidate>(CAPTURE_FPS * 3),
  );
  const processQueueRef = useRef<() => void>(() => undefined);

  const capturedRef = useRef(0);
  const analyzedRef = useRef(0);
  const matchedRef = useRef(0);
  const presentedRef = useRef(0);
  const noFaceRef = useRef(0);
  const imageFailureRef = useRef(0);

  const [engineReady, setEngineReady] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogCount, setCatalogCount] = useState(0);
  const [catalogFiles, setCatalogFiles] = useState(0);
  const [catalogLoaded, setCatalogLoaded] = useState(0);
  const [candidateCount, setCandidateCount] = useState(0);
  const [running, setRunning] = useState(false);
  const [draining, setDraining] = useState(false);
  const [output, setOutput] = useState<Output | null>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [captured, setCaptured] = useState(0);
  const [analyzed, setAnalyzed] = useState(0);
  const [matched, setMatched] = useState(0);
  const [presented, setPresented] = useState(0);
  const [noFace, setNoFace] = useState(0);
  const [lagSeconds, setLagSeconds] = useState(0);
  const [analysisMs, setAnalysisMs] = useState(0);
  const [displayMs, setDisplayMs] = useState(0);
  const [searchPool, setSearchPool] = useState(0);
  const [lookaheadSeconds, setLookaheadSeconds] = useState(3);
  const [pendingLookahead, setPendingLookahead] = useState(0);
  const [captureMode, setCaptureMode] = useState("WORKER FIFO");
  const [rawCaptureQueue, setRawCaptureQueue] = useState(0);
  const [sourceDrops, setSourceDrops] = useState(0);
  const [imageFailures, setImageFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const rememberDecodedImage = useCallback((url: string) => {
    const existing = decodedImagesRef.current.get(url);
    if (existing) return existing;
    const promise = decodeImage(url).catch((caught) => {
      decodedImagesRef.current.delete(url);
      throw caught;
    });
    decodedImagesRef.current.set(url, promise);
    return promise;
  }, []);

  const presentChoices = useCallback(async (
    choices: ReturnType<DelayedFaithfulCommitter<Candidate>["flush"]>,
  ) => {
    for (const choice of choices) {
      const started = performance.now();
      try {
        await rememberDecodedImage(choice.candidate.url);
      } catch (caught) {
        console.warn("Faithful output image failed to decode.", caught);
        imageFailureRef.current += 1;
        setImageFailures(imageFailureRef.current);
      }
      if (disposedRef.current) return;
      setOutput({
        candidate: choice.candidate,
        error: choice.error,
        frameTime: choice.frame.time,
      });
      presentedRef.current += 1;
      setPresented(presentedRef.current);
      setLagSeconds(
        Math.max(0, latestCapturedTimeRef.current - choice.frame.time),
      );
      await waitForPaint();
      setDisplayMs(performance.now() - started);
    }
  }, [rememberDecodedImage]);

  const finishCaptureIfDrained = useCallback(async () => {
    if (!captureFinishedRef.current || queueRef.current.length) return;
    const remaining = committerRef.current.flush();
    if (remaining.length) await presentChoices(remaining);
    const stats = committerRef.current.stats();
    setPendingLookahead(stats.pendingLookaheadFrames);
    setDraining(false);
  }, [presentChoices]);

  const processQueue = useCallback(() => {
    if (processingRef.current) return;
    processingRef.current = true;

    const run = async () => {
      try {
        while (queueRef.current.length) {
          const item = queueRef.current.shift() as QueueItem;
          setQueueSize(queueRef.current.length);
          const started = performance.now();
          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await createImageBitmap(item.blob);
            const landmarker = landmarkerRef.current;
            if (!landmarker) throw new Error("FACE LANDMARKER NOT READY");
            const result = landmarker.detect(bitmap);
            analyzedRef.current += 1;
            setAnalyzed(analyzedRef.current);
            const landmarks = result.faceLandmarks[0];
            if (!landmarks || !result.faceBlendshapes.length) {
              noFaceRef.current += 1;
              setNoFace(noFaceRef.current);
              continue;
            }
            const geometry = faceGeometryFromLandmarks(
              landmarks,
              bitmap.width && bitmap.height ? bitmap.width / bitmap.height : 1,
            );
            if (!geometry) {
              noFaceRef.current += 1;
              setNoFace(noFaceRef.current);
              continue;
            }
            const frame: SequenceFrame = {
              time: item.time,
              feature: featureFromResult(result),
              geometry,
            };
            const pool = localCandidates(frame, candidatesRef.current);
            const ranked = rankProjectionCandidateModesTwoStage(
              frame,
              pool,
              INDEX_BEAM_PER_FRAME,
              Math.min(1_024, pool.length),
            ).strict;
            matchedRef.current += 1;
            setMatched(matchedRef.current);
            setSearchPool(pool.length);
            const committed = committerRef.current.push(frame, ranked);
            const stats = committerRef.current.stats();
            setPendingLookahead(stats.pendingLookaheadFrames);
            if (committed.length) await presentChoices(committed);
          } catch (caught) {
            console.warn("Faithful queued frame failed.", caught);
          } finally {
            bitmap?.close();
            setAnalysisMs(performance.now() - started);
          }
        }
        await finishCaptureIfDrained();
      } finally {
        processingRef.current = false;
        if (queueRef.current.length) processQueueRef.current();
      }
    };
    void run();
  }, [finishCaptureIfDrained, presentChoices]);

  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  const enqueueCapturedFrame = useCallback((
    blob: Blob,
    rawTimestamp: number,
    estimatedDrops = 0,
    rawQueue = 0,
  ) => {
    if (firstTimestampRef.current === null) {
      firstTimestampRef.current = rawTimestamp;
    }
    const time = Math.max(
      0,
      rawTimestamp - Number(firstTimestampRef.current ?? rawTimestamp),
    );
    queueRef.current.push({ blob, time });
    capturedRef.current += 1;
    latestCapturedTimeRef.current = time;
    setCaptured(capturedRef.current);
    setQueueSize(queueRef.current.length);
    setSourceDrops(estimatedDrops);
    setRawCaptureQueue(rawQueue);
    processQueueRef.current();
  }, []);

  const markCaptureFinished = useCallback(() => {
    captureFinishedRef.current = true;
    capturingRef.current = false;
    setRunning(false);
    setDraining(true);
    processQueueRef.current();
  }, []);

  const stopFallbackCapture = useCallback(() => {
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (
      fallbackFrameCallbackRef.current !== null &&
      video?.cancelVideoFrameCallback
    ) {
      video.cancelVideoFrameCallback(fallbackFrameCallbackRef.current);
    }
    fallbackFrameCallbackRef.current = null;
    void fallbackEncodeChainRef.current.finally(markCaptureFinished);
  }, [markCaptureFinished]);

  const startFallbackCapture = useCallback((video: VideoWithFrameCallback) => {
    setCaptureMode("MAIN FIFO FALLBACK");
    fallbackPreviousTimeRef.current = null;
    fallbackDropEstimateRef.current = 0;
    fallbackEncodeChainRef.current = Promise.resolve();
    if (!fallbackCanvasRef.current) {
      fallbackCanvasRef.current = document.createElement("canvas");
    }
    const capture = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!capturingRef.current) return;
      const rawTime = Number.isFinite(metadata.mediaTime)
        ? Number(metadata.mediaTime)
        : now / 1_000;
      const previous = fallbackPreviousTimeRef.current;
      const gapMs = previous === null ? 0 : Math.max(0, (rawTime - previous) * 1_000);
      if (gapMs > CAPTURE_INTERVAL_MS * 1.5) {
        fallbackDropEstimateRef.current += Math.max(
          0,
          Math.round(gapMs / CAPTURE_INTERVAL_MS) - 1,
        );
      }
      fallbackPreviousTimeRef.current = rawTime;
      const bitmapPromise = createImageBitmap(video);
      fallbackEncodeChainRef.current = fallbackEncodeChainRef.current.then(async () => {
        const bitmap = await bitmapPromise;
        try {
          const scale = Math.min(
            1,
            CAPTURE_SIZE / Math.max(bitmap.width, bitmap.height),
          );
          const width = Math.max(1, Math.round(bitmap.width * scale));
          const height = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = fallbackCanvasRef.current as HTMLCanvasElement;
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("FALLBACK CANVAS UNAVAILABLE");
          context.drawImage(
            bitmap,
            0,
            0,
            bitmap.width,
            bitmap.height,
            0,
            0,
            width,
            height,
          );
          const blob = await canvasToBlob(canvas);
          enqueueCapturedFrame(
            blob,
            rawTime,
            fallbackDropEstimateRef.current,
            0,
          );
        } finally {
          bitmap.close();
        }
      }).catch((caught) => {
        console.warn("Fallback capture frame failed.", caught);
      });
      if (video.requestVideoFrameCallback) {
        fallbackFrameCallbackRef.current = video.requestVideoFrameCallback(capture);
      } else {
        fallbackFrameCallbackRef.current = requestAnimationFrame((nextNow) =>
          capture(nextNow, { mediaTime: nextNow / 1_000 })
        );
      }
    };
    if (video.requestVideoFrameCallback) {
      fallbackFrameCallbackRef.current = video.requestVideoFrameCallback(capture);
    } else {
      fallbackFrameCallbackRef.current = requestAnimationFrame((now) =>
        capture(now, { mediaTime: now / 1_000 })
      );
    }
  }, [enqueueCapturedFrame]);

  const requestStop = useCallback(() => {
    if (!capturingRef.current) return;
    capturingRef.current = false;
    setRunning(false);
    setDraining(true);
    const worker = workerRef.current;
    if (worker) {
      worker.postMessage({ type: "stop" });
    } else {
      stopFallbackCapture();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [stopFallbackCapture]);

  useEffect(() => {
    disposedRef.current = false;
    let disposed = false;
    async function prepare() {
      try {
        const manifestResponse = await fetch(
          "/api/catalog/manifest",
          { cache: "no-store" },
        );
        if (!manifestResponse.ok) {
          throw new Error(`CATALOG ${manifestResponse.status}`);
        }
        const manifest = await manifestResponse.json() as CatalogManifest;
        if (disposed) return;
        setCatalogCount(manifest.totalFaces);
        const indexFiles = manifest.indexFiles?.length
          ? manifest.indexFiles
          : manifest.indexFile
            ? [manifest.indexFile]
            : [...new Set(
                Object.values(manifest.cells).flatMap((cell) =>
                  cell.shards?.length
                    ? cell.shards
                    : cell.shard
                      ? [cell.shard]
                      : [],
                ),
              )];
        setCatalogFiles(indexFiles.length);
        const entries: CatalogEntry[] = [];
        for (let index = 0; index < indexFiles.length; index += 2) {
          const batch = indexFiles.slice(index, index + 2);
          const payloads = await Promise.all(
            batch.map(async (file) => {
              const catalog =
                manifest.catalogId || manifest.generatedAt || "current";
              const endpoint = manifest.indexFiles?.length || manifest.indexFile
                ? `/api/catalog/index?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`
                : `/api/catalog/shard?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`;
              const response = await fetch(endpoint, { cache: "force-cache" });
              if (!response.ok) throw new Error(`INDEX ${response.status}`);
              return response.json() as Promise<{ items?: CatalogEntry[] }>;
            }),
          );
          payloads.forEach((payload) => entries.push(...(payload.items ?? [])));
          if (!disposed) {
            setCatalogLoaded(Math.min(index + batch.length, indexFiles.length));
          }
        }
        const candidates = [
          ...new Map(entries.map((entry) => [entry.id, entry])).values(),
        ].flatMap((entry) => {
          const candidate = candidateFromEntry(entry);
          return candidate ? [candidate] : [];
        });
        if (candidates.length < 4) {
          throw new Error("骨格比較できる顔素材がありません");
        }
        candidatesRef.current = candidates;
        if (!disposed) {
          setCandidateCount(candidates.length);
          setCatalogReady(true);
        }

        const { FaceLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
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
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : "準備に失敗しました");
        }
      }
    }
    void prepare();
    return () => {
      disposed = true;
      disposedRef.current = true;
      capturingRef.current = false;
      workerRef.current?.terminate();
      workerRef.current = null;
      workerTrackRef.current?.stop();
      workerTrackRef.current = null;
      const video = videoRef.current as VideoWithFrameCallback | null;
      if (
        fallbackFrameCallbackRef.current !== null &&
        video?.cancelVideoFrameCallback
      ) {
        video.cancelVideoFrameCallback(fallbackFrameCallbackRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      landmarkerRef.current?.close();
    };
  }, []);

  const start = useCallback(async () => {
    if (
      !engineReady ||
      !catalogReady ||
      capturingRef.current ||
      draining
    ) {
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 720 },
          height: { ideal: 720 },
          frameRate: { ideal: CAPTURE_FPS, max: CAPTURE_FPS },
        },
        audio: false,
      });
      const video = videoRef.current as VideoWithFrameCallback | null;
      if (!video) throw new Error("VIDEO ELEMENT MISSING");
      streamRef.current = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      queueRef.current = [];
      decodedImagesRef.current.clear();
      firstTimestampRef.current = null;
      latestCapturedTimeRef.current = 0;
      capturedRef.current = 0;
      analyzedRef.current = 0;
      matchedRef.current = 0;
      presentedRef.current = 0;
      noFaceRef.current = 0;
      imageFailureRef.current = 0;
      fallbackDropEstimateRef.current = 0;
      committerRef.current.reset(
        Math.round(lookaheadSeconds * CAPTURE_FPS),
      );
      setOutput(null);
      setQueueSize(0);
      setCaptured(0);
      setAnalyzed(0);
      setMatched(0);
      setPresented(0);
      setNoFace(0);
      setLagSeconds(0);
      setAnalysisMs(0);
      setDisplayMs(0);
      setSearchPool(0);
      setPendingLookahead(0);
      setRawCaptureQueue(0);
      setSourceDrops(0);
      setImageFailures(0);
      captureFinishedRef.current = false;
      capturingRef.current = true;
      setRunning(true);
      setDraining(false);

      const sourceTrack = stream.getVideoTracks()[0];
      if (!sourceTrack) throw new Error("CAMERA TRACK MISSING");
      let workerStarted = false;
      try {
        const worker = new Worker("/faithful-capture-worker-v2.js");
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          if (message.type === "frame" && message.blob) {
            enqueueCapturedFrame(
              message.blob,
              Number(message.timestamp ?? 0),
              Number(message.estimatedSourceDrops ?? 0),
              Number(message.rawQueue ?? 0),
            );
            return;
          }
          if (message.type === "stats") {
            setRawCaptureQueue(Number(message.rawQueue ?? 0));
            setSourceDrops(Number(message.estimatedSourceDrops ?? 0));
            return;
          }
          if (message.type === "stopped") {
            workerRef.current?.terminate();
            workerRef.current = null;
            workerTrackRef.current = null;
            markCaptureFinished();
            return;
          }
          if (message.type === "error") {
            console.warn("Capture worker unavailable; falling back.", message.message);
            workerRef.current?.terminate();
            workerRef.current = null;
            workerTrackRef.current?.stop();
            workerTrackRef.current = null;
            if (capturingRef.current) startFallbackCapture(video);
          }
        };
        worker.onerror = () => {
          workerRef.current?.terminate();
          workerRef.current = null;
          workerTrackRef.current?.stop();
          workerTrackRef.current = null;
          if (capturingRef.current) startFallbackCapture(video);
        };
        const captureTrack = sourceTrack.clone();
        workerTrackRef.current = captureTrack;
        worker.postMessage(
          {
            type: "start",
            track: captureTrack,
            size: CAPTURE_SIZE,
            quality: 0.94,
          },
          [captureTrack],
        );
        setCaptureMode("WORKER FIFO / FULL FRAME");
        workerStarted = true;
      } catch (caught) {
        console.warn("Worker capture startup failed; using fallback.", caught);
      }
      if (!workerStarted) startFallbackCapture(video);
    } catch (caught) {
      console.error("Faithful camera start failed.", caught);
      setError("カメラを開始できませんでした");
      capturingRef.current = false;
      captureFinishedRef.current = true;
      setRunning(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, [
    catalogReady,
    draining,
    engineReady,
    enqueueCapturedFrame,
    lookaheadSeconds,
    markCaptureFinished,
    startFallbackCapture,
  ]);

  const ready = engineReady && catalogReady;
  const busy = running || draining;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p>MANY FACES / OFFLINE-FAITHFUL FIFO</p>
          <h1>動画版を削らず、遅延として積む。</h1>
        </div>
        <nav className={styles.nav}>
          <Link href="/">VIDEO LAB</Link>
          <Link href="/live/fast">FAST LIVE</Link>
          <Link href="/live/legacy">LEGACY</Link>
          <span className={styles.badge}>
            {running ? "CAPTURING" : draining ? "DRAINING" : ready ? "READY" : "PREPARING"}
          </span>
        </nav>
      </header>

      <section className={styles.grid}>
        <div className={styles.stage}>
          {output ? (
            <img
              src={output.candidate.url}
              alt="動画版と同じ処理で確定した顔"
              draggable={false}
            />
          ) : (
            <div className={styles.empty}>
              <strong>{ready ? "CAMERA START" : "LOADING FULL CATALOG"}</strong>
              <span>
                {busy
                  ? `${lookaheadSeconds.toFixed(0)}秒ぶんの経路が確定するまで保持中`
                  : "高速化・フレーム破棄・ready fallbackなし"}
              </span>
            </div>
          )}
          <div className={styles.camera}>
            <span>RAW CAMERA / {captureMode}</span>
            <video ref={videoRef} muted playsInline />
          </div>
          <div className={styles.meta}>
            <span>{output?.candidate.name ?? "NO OUTPUT"}</span>
            <b>{output?.candidate.sourceName || output?.candidate.creator || "—"}</b>
          </div>
        </div>

        <aside className={styles.telemetry}>
          <div><span>CAPTURED</span><strong>{captured}</strong></div>
          <div><span>ANALYZED</span><strong>{analyzed}</strong></div>
          <div><span>MATCHED</span><strong>{matched}</strong></div>
          <div><span>PRESENTED</span><strong>{presented}</strong></div>
          <div><span>FIFO QUEUE</span><strong>{queueSize} frames</strong></div>
          <div><span>LOOKAHEAD</span><strong>{pendingLookahead} / {Math.round(lookaheadSeconds * CAPTURE_FPS)}</strong></div>
          <div><span>PIPELINE LAG</span><strong>{lagSeconds.toFixed(2)} s</strong></div>
          <div><span>ANALYSIS</span><strong>{analysisMs.toFixed(1)} ms</strong></div>
          <div><span>DISPLAY BARRIER</span><strong>{displayMs.toFixed(1)} ms</strong></div>
          <div><span>SEARCH POOL</span><strong>{searchPool.toLocaleString()}</strong></div>
          <div><span>STRICT ERROR</span><strong>{output?.error.strictTotal.toFixed(4) ?? "—"}</strong></div>
          <div><span>NO FACE</span><strong>{noFace}</strong></div>
          <div><span>SOURCE GAPS</span><strong>{sourceDrops}</strong></div>
          <div><span>CAPTURE RAW FIFO</span><strong>{rawCaptureQueue}</strong></div>
          <div><span>IMAGE FAILURES</span><strong>{imageFailures}</strong></div>
          <div><span>CATALOG</span><strong>{candidateCount.toLocaleString()} / {catalogCount.toLocaleString()}</strong></div>
        </aside>
      </section>

      <section className={styles.controls}>
        <div className={styles.buttons}>
          <button type="button" onClick={start} disabled={!ready || busy}>
            カメラを開始
          </button>
          <button type="button" onClick={requestStop} disabled={!running}>
            入力を止めてFIFOを処理
          </button>
          <label>
            経路確定の先読み
            <select
              value={lookaheadSeconds}
              onChange={(event) => setLookaheadSeconds(Number(event.target.value))}
              disabled={busy}
            >
              <option value="0">0秒</option>
              <option value="3">3秒</option>
              <option value="10">10秒</option>
            </select>
          </label>
        </div>
        {!catalogReady && catalogCount > 0 && (
          <p className={styles.progress}>
            FULL INDEX: {catalogLoaded} / {catalogFiles} files · {catalogCount.toLocaleString()} faces
          </p>
        )}
        <p className={styles.note}>
          カメラの全画角を保ったまま30fps入力をFIFOへ積み、動画版と同じ3度量子化、12°/15°→18°/21°の候補絞り込み、二段階3D投影比較、strict 64候補、別人制約、12フレームcooldown、経路連続性を順番に実行します。確定した画像もdecodeと1描画を待ってから次へ進みます。処理が追いつかない場合、フレームを最新へ飛ばさずFIFOと表示遅延が増えます。
        </p>
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </main>
  );
}
