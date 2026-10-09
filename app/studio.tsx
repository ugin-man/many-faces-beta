"use client";
import { lazy, Suspense, useState } from "react";
import type { StudioMode } from "./studio-controls";
import styles from "./studio.module.css";

const VideoReview = lazy(() => import("./live/review-client-lite"));
const Realtime = lazy(() => import("./live/astra/client"));

export default function Studio({ initialMode = "video" }: { initialMode?: StudioMode }) {
  const [mode, setMode] = useState<StudioMode>(initialMode);
  return <Suspense fallback={<main className={styles.stage} aria-busy="true"><div className={styles.empty}>準備中…</div></main>}>
    {mode === "video" ? <VideoReview onModeChange={setMode} /> : <Realtime onModeChange={setMode} />}
  </Suspense>;
}
