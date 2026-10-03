"use client";
import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { Icon } from "./studio-icons";
import { shouldExitSwipe, type StudioMode, type SwipePoint } from "./studio-controls";
import styles from "./studio.module.css";

export type StudioClientProps = { onModeChange?: (mode: StudioMode) => void };
type Props = StudioClientProps & {
  mode: StudioMode; onBack: () => void; active: boolean; hasOutput: boolean;
  children: ReactNode; preview: ReactNode; controls: ReactNode;
  empty?: ReactNode; timeline?: ReactNode; settings?: ReactNode; details?: ReactNode;
  status?: string; error?: ReactNode; progress?: number; sourceVisible?: boolean;
};
export default function CallStage(props: Props) {
  const { mode, onModeChange, onBack, active, hasOutput } = props;
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<"settings" | "details" | null>(null);
  const [fit, setFit] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const swipe = useRef<SwipePoint | null>(null);
  const dialogButton = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (sheet && dialog && !dialog.open) { dialog.showModal(); dialogButton.current?.focus(); }
    if (!sheet && dialog?.open) dialog.close();
  }, [sheet]);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !dialogRef.current?.open) { setChrome(true); onBack(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onBack]);
  const back = () => { setChrome(true); setSheet(null); onBack(); };
  const pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("button,input,select,label,a,video,[data-pip],dialog")) return;
    swipe.current = { x: event.clientX, y: event.clientY, at: performance.now() };
  };
  const pointerUp = (event: PointerEvent) => {
    const start = swipe.current; swipe.current = null;
    if (!start) return;
    const end = { x: event.clientX, y: event.clientY, at: performance.now() };
    if (active && shouldExitSwipe(start, end)) back();
    else if (hasOutput && Math.hypot(end.x - start.x, end.y - start.y) < 8) setChrome(value => !value);
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen?.();
    } catch { /* The viewport is already filled when native fullscreen is unavailable. */ }
  };
  return <main ref={stageRef} className={styles.stage} data-build="fullscreen-v1" data-mode={mode}
    data-testid="call-stage" onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={() => { swipe.current = null; }}>
    <div className={styles.output} data-fit={fit ? "contain" : "cover"} data-testid="result-stage" data-ready={hasOutput}>{props.children}</div>
    <header className={styles.topbar}>
      <button className={styles.round} onClick={back} aria-label="戻る" title="戻る" data-testid="back"><Icon name="back" /></button>
      <span className={styles.brand}>Many Faces</span>
    </header>
    <aside className={styles.pip} data-pip data-visible={props.sourceVisible !== false} aria-label="入力映像" data-testid="source-pip">{props.preview}</aside>
    {!hasOutput && <div className={styles.empty}>{props.empty}</div>}
    {(props.status || props.error) && <div className={styles.status} data-error={Boolean(props.error)} role={props.error ? "alert" : "status"}>
      {props.error || props.status}
      {props.progress !== undefined && <progress max="1" value={props.progress} aria-label="解析の進捗" />}
    </div>}
    <div className={styles.bottom} data-hidden={!chrome && hasOutput} inert={!chrome && hasOutput}>
      <div className={styles.modeButtons} role="group" aria-label="モード選択">
        <button aria-pressed={mode === "video"} onClick={() => { if (mode !== "video") onModeChange?.("video"); }} data-testid="mode-video"><Icon name="video" />動画検証</button>
        <button aria-pressed={mode === "camera"} onClick={() => { if (mode !== "camera") onModeChange?.("camera"); }} data-testid="mode-camera"><Icon name="camera" />リアルタイム</button>
      </div>
      {props.timeline && <div className={styles.timeline}>{props.timeline}</div>}
      <div className={styles.dock} role="group" aria-label="操作">
        {props.controls}
        <button className={styles.tool} onClick={() => setSheet("settings")} aria-label="設定" title="設定" data-testid="settings"><Icon name="settings" /><span>設定</span></button>
      </div>
    </div>
    {!chrome && hasOutput && <button className={styles.reveal} onClick={() => setChrome(true)} aria-label="操作を表示"><Icon name="eye" /></button>}
    <dialog ref={dialogRef} className={styles.sheet} onCancel={() => setSheet(null)} onClick={event => { if (event.target === event.currentTarget) setSheet(null); }}>
      <div className={styles.sheetBody}>
        <div className={styles.sheetHeader}><h2>{sheet === "details" ? "画像情報・診断" : "設定"}</h2><button ref={dialogButton} className={styles.round} onClick={() => setSheet(null)} aria-label="閉じる"><Icon name="close" /></button></div>
        {sheet === "settings" ? <>
          {props.settings}
          <label className={styles.settingRow}><span>画像全体を表示</span><input type="checkbox" checked={fit} onChange={event => setFit(event.target.checked)} /></label>
          <button className={styles.settingRow} onClick={() => void toggleFullscreen()}><span>{fullscreen ? "全画面表示を終了" : "全画面表示"}</span><Icon name={fullscreen ? "shrink" : "expand"} /></button>
          <button className={styles.settingRow} onClick={() => setSheet("details")}><span>画像情報・診断</span><Icon name="info" /></button>
        </> : <div className={styles.details}>{props.details}<small>Fullscreen UI v1</small></div>}
      </div>
    </dialog>
  </main>;
}
