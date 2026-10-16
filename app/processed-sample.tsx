"use client";
import { useLanguage } from "./language";
import { useCallback, useEffect, useRef, useState } from "react";
import CallStage, { type StudioClientProps } from "./call-stage";
import { Icon } from "./studio-icons";
import { timeLabel } from "./studio-controls";
import styles from "./studio.module.css";

export const PROCESSED_SAMPLE_URL = "/demo/many-faces-sample-30fps.mp4";

/** This player only reads the finished composite; it never starts face analysis. */
export default function ProcessedSample({ onBack, onModeChange }: StudioClientProps & { onBack: () => void }) {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    // A complete local blob also supports frame seeking on hosts without byte ranges.
    void fetch(PROCESSED_SAMPLE_URL, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Sample unavailable");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setSampleUrl(objectUrl);
    }).catch(() => {
      if (!controller.signal.aborted) setError("サンプルを読み込めませんでした。ページを再読み込みしてください。");
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, []);
  const mediaCleanup = useRef<() => void>(() => {});
  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    mediaCleanup.current();
    videoRef.current = video;
    if (!video) return;
    const sync = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
      setReady(video.readyState >= 1 && !video.error);
      setTime(video.currentTime);
      setPlaying(!video.paused);
    };
    const events = ["loadedmetadata", "loadeddata", "canplay", "progress", "timeupdate", "play", "pause", "seeked"];
    for (const event of events) video.addEventListener(event, sync);
    // The nested video may mount after this component's effects, or load from cache.
    sync();
    mediaCleanup.current = () => { for (const event of events) video.removeEventListener(event, sync); };
  }, []);
  const toggle = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) { video.pause(); return; }
    try { setError(null); await video.play(); }
    catch { setError("再生できませんでした。もう一度再生ボタンを押してください。"); }
  };
  const seek = (value: number) => {
    const video = videoRef.current;
    if (!video || !ready) return;
    video.pause();
    video.currentTime = Math.max(0, Math.min(value, duration - 1 / 30));
    setTime(video.currentTime);
  };
  const saveImage = () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.seeking) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = "many-faces-sample.png"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };
  const saveVideo = () => {
    const a = document.createElement("a");
    a.href = PROCESSED_SAMPLE_URL; a.download = "many-faces-sample-30fps.mp4"; a.click();
  };
  return <CallStage mode="video" onBack={onBack} onModeChange={onModeChange}
    active hasOutput sourceVisible={false} preview={null} error={error}
    status={!ready && !error ? t("サンプルを読み込み中") : undefined}
    timeline={<><time>{timeLabel(time)}</time><input type="range" min="0" max={duration}
      step={1 / 30} value={time} disabled={!ready} aria-label={t("再生位置")} data-testid="sample-seek"
      onInput={event => seek(Number(event.currentTarget.value))} /><time>{timeLabel(duration)}</time></>}
    controls={<>
      <button className={styles.tool} disabled={!ready} onClick={saveImage} data-testid="sample-save-image"><Icon name="sample" /><span>{t("画像保存")}</span></button>
      <button className={styles.tool} onClick={saveVideo} data-testid="sample-save-video"><Icon name="video" /><span>{t("動画保存")}</span></button>
      <button className={styles.tool} disabled={!ready} onClick={() => seek(time - 1 / 30)} aria-label={t("1フレーム戻る")}><Icon name="previous" /><span>{t("1コマ戻る")}</span></button>
      <button className={`${styles.tool} ${styles.primary}`} disabled={!sampleUrl} onClick={() => void toggle()}
        aria-label={playing ? t("一時停止") : t("再生")} data-testid="sample-play-pause"><Icon name={playing ? "pause" : "play"} /><span>{playing ? t("一時停止") : t("再生")}</span></button>
      <button className={styles.tool} disabled={!ready} onClick={() => seek(time + 1 / 30)} aria-label={t("1フレーム進む")}><Icon name="next" /><span>{t("1コマ進む")}</span></button>
      <button className={styles.tool} onClick={onBack}><Icon name="upload" /><span>{t("自分の動画へ")}</span></button>
    </>}
    settings={<>
      <p className={styles.sampleCaption}>{t("顔を差し替えた処理済みサンプルです。30fps・音声なし。再生時の解析はありません。")}</p>
      <label className={styles.settingRow}><span>{t("鏡表示（再生・画像保存）")}</span><input type="checkbox" checked={mirror} onChange={event => setMirror(event.target.checked)} /></label>
    </>}
    details={<p>{t("Many Facesの合成サンプル")}<br />{duration.toFixed(1)}{t("秒・30fps・768 × 768")}<br />{t("顔を差し替えた動画のみを再生します。")}</p>}>
    <video ref={bindVideo} src={sampleUrl} data-source={PROCESSED_SAMPLE_URL} poster="/demo/poster.webp" muted playsInline loop
      preload="auto" className={mirror ? styles.mirror : undefined} data-testid="processed-sample-video"
      aria-label={t("顔を差し替えたMany Facesのサンプル動画")}
      onLoadedMetadata={event => { setDuration(event.currentTarget.duration); setReady(true); }} onLoadedData={() => setReady(true)}
      onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)} onError={() => { setReady(false); setError("サンプルを読み込めませんでした。ページを再読み込みしてください。"); }} />
  </CallStage>;
}
