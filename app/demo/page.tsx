"use client";
import { lazy, Suspense, useState } from "react";
import type { StudioMode } from "../studio-controls";
import styles from "../studio.module.css";

const DemoVideo = lazy(() => import("../live/demo-client"));
const Realtime = lazy(() => import("../live/astra/client"));

export default function DemoPage() {
  const [mode, setMode] = useState<StudioMode>("video");
  return <Suspense fallback={<main className={styles.stage} aria-busy="true"><div className={styles.empty}>準備中…</div></main>}>
    {mode === "video" ? <DemoVideo onModeChange={setMode} /> : <Realtime onModeChange={setMode} />}
  </Suspense>;
}
