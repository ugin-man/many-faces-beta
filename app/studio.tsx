"use client";
import { lazy, Suspense, useState } from "react";
import type { StudioMode } from "./studio-controls";
import styles from "./studio.module.css";

const VideoComposite = lazy(() => import("./live/demo-client"));
const ProcessedSample = lazy(() => import("./processed-sample"));
const Realtime = lazy(() => import("./live/astra/client"));

export default function Studio({ initialMode = "video", initialSample = false }: { initialMode?: StudioMode; initialSample?: boolean }) {
  const [mode, setMode] = useState<StudioMode>(initialMode);
  const [sample, setSample] = useState(initialSample);
  const changeMode = (next: StudioMode) => { setSample(false); setMode(next); };
  return <Suspense fallback={<main className={styles.stage} aria-busy="true"><div className={styles.empty}>準備中…</div></main>}>
    {sample ? <ProcessedSample onBack={() => setSample(false)} onModeChange={changeMode} />
      : mode === "video" ? <VideoComposite onModeChange={changeMode} onOpenSample={() => setSample(true)} /> : <Realtime onModeChange={changeMode} />}
  </Suspense>;
}
