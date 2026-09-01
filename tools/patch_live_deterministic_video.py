#!/usr/bin/env python3
from pathlib import Path

TSX = Path('app/live/review-client-lite.tsx')
CSS = Path('app/live/review-client-lite.module.css')
text = TSX.read_text(encoding='utf-8')
css = CSS.read_text(encoding='utf-8')

if 'data-testid="verification-file-input"' in text:
    print('Deterministic video verification patch already applied.')
    raise SystemExit(0)

replacements = [
    (
        'import {\n  processingSecondsPerOutputSecond,\n  quantizeReviewTime,\n  reviewItemAtTime,\n} from "./review-timeline";\n',
        'import {\n  processingSecondsPerOutputSecond,\n  quantizeReviewTime,\n  reviewItemAtTime,\n} from "./review-timeline";\nimport { evaluateVerificationGate } from "./verification-gate";\n',
        'verification gate import',
    ),
    (
        'type Progress = {\n  done: number;\n  total: number;\n  label: string;\n};\n',
        'type Progress = {\n  done: number;\n  total: number;\n  label: string;\n};\n\n'
        'type VerificationReport = {\n'
        '  sourceName: string;\n'
        '  plannedFrames: number;\n'
        '  faceFrames: number;\n'
        '  sequenceFrames: number;\n'
        '  selectedImages: number;\n'
        '  imageFailures: number;\n'
        '  outputChanges: number;\n'
        '  uniqueFaces: number;\n'
        '  processingMs: number;\n'
        '  canvasNonBlank: boolean;\n'
        '  faceCoverage: number;\n'
        '  passed: boolean;\n'
        '  reasons: string[];\n'
        '};\n\n'
        'declare global {\n'
        '  interface Window {\n'
        '    __MANY_FACES_VERIFY__?: VerificationReport;\n'
        '  }\n'
        '}\n',
        'verification report type',
    ),
    (
        'function phaseText(phase: Phase) {\n',
        'function canvasHasVisiblePixels(canvas: HTMLCanvasElement) {\n'
        '  const context = canvas.getContext("2d", { willReadFrequently: true });\n'
        '  if (!context) return false;\n'
        '  const width = Math.min(canvas.width, 96);\n'
        '  const height = Math.min(canvas.height, 64);\n'
        '  const scratch = document.createElement("canvas");\n'
        '  scratch.width = width;\n'
        '  scratch.height = height;\n'
        '  const target = scratch.getContext("2d", { willReadFrequently: true });\n'
        '  if (!target) return false;\n'
        '  target.drawImage(canvas, 0, 0, width, height);\n'
        '  const pixels = target.getImageData(0, 0, width, height).data;\n'
        '  let visible = 0;\n'
        '  for (let index = 0; index < pixels.length; index += 4) {\n'
        '    if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 45) {\n'
        '      visible += 1;\n'
        '    }\n'
        '  }\n'
        '  return visible > width * height * 0.08;\n'
        '}\n\n'
        'function phaseText(phase: Phase) {\n',
        'canvas verification helper',
    ),
    (
        '  const [catalogTotal, setCatalogTotal] = useState(0);\n'
        '  const [analysisFps, setAnalysisFps] = useState(12);\n',
        '  const [catalogTotal, setCatalogTotal] = useState(0);\n'
        '  const [sourceName, setSourceName] = useState("");\n'
        '  const [report, setReport] = useState<VerificationReport | null>(null);\n'
        '  const [analysisFps, setAnalysisFps] = useState(12);\n',
        'verification state',
    ),
    (
        '  useEffect(() => {\n'
        '    replayFpsRef.current = replayFps;\n'
        '  }, [replayFps]);\n\n'
        '  const busy =',
        '  useEffect(() => {\n'
        '    replayFpsRef.current = replayFps;\n'
        '  }, [replayFps]);\n\n'
        '  useEffect(() => {\n'
        '    window.__MANY_FACES_VERIFY__ = report ?? undefined;\n'
        '  }, [report]);\n\n'
        '  const busy =',
        'verification report effect',
    ),
    (
        '    sequenceRef.current = [];\n'
        '    lastOutputIdRef.current = null;\n',
        '    sequenceRef.current = [];\n'
        '    lastOutputIdRef.current = null;\n'
        '    setReport(null);\n'
        '    window.__MANY_FACES_VERIFY__ = undefined;\n',
        'clear report',
    ),
    (
        '      setUniqueFaces(selected.length);\n'
        '      setProcessingMs(performance.now() - started);\n'
        '      setProgress(null);\n'
        '      setPlaybackTime(0);\n'
        '      setPhase("review");\n'
        '      video.currentTime = 0;\n'
        '      drawReviewAt(0);\n'
        '      await nextPaint();\n',
        '      setUniqueFaces(selected.length);\n'
        '      const elapsed = performance.now() - started;\n'
        '      setProcessingMs(elapsed);\n'
        '      setProgress(null);\n'
        '      setPlaybackTime(0);\n'
        '      setPhase("review");\n'
        '      video.currentTime = 0;\n'
        '      drawReviewAt(0);\n'
        '      await nextPaint();\n'
        '      const canvas = outputCanvasRef.current;\n'
        '      const canvasNonBlank = Boolean(\n'
        '        canvas && canvasHasVisiblePixels(canvas),\n'
        '      );\n'
        '      const gate = evaluateVerificationGate({\n'
        '        plannedFrames: frameCount,\n'
        '        faceFrames: frames.length,\n'
        '        sequenceFrames: choices.length,\n'
        '        selectedImages: selected.length,\n'
        '        imageFailures: failures,\n'
        '        outputChanges: changes,\n'
        '        canvasNonBlank,\n'
        '      });\n'
        '      const nextReport: VerificationReport = {\n'
        '        sourceName: sourceName || "camera-five-seconds.webm",\n'
        '        plannedFrames: frameCount,\n'
        '        faceFrames: frames.length,\n'
        '        sequenceFrames: choices.length,\n'
        '        selectedImages: selected.length,\n'
        '        imageFailures: failures,\n'
        '        outputChanges: changes,\n'
        '        uniqueFaces: selected.length,\n'
        '        processingMs: elapsed,\n'
        '        canvasNonBlank,\n'
        '        faceCoverage: gate.faceCoverage,\n'
        '        passed: gate.passed,\n'
        '        reasons: gate.reasons,\n'
        '      };\n'
        '      setReport(nextReport);\n'
        '      window.__MANY_FACES_VERIFY__ = nextReport;\n',
        'verification result creation',
    ),
    (
        '  }, [analysisFps, drawReviewAt, loadFrameCandidates, waitUntilPrepared]);\n\n'
        '  const recordFiveSeconds = useCallback(async () => {\n',
        '  }, [\n'
        '    analysisFps,\n'
        '    drawReviewAt,\n'
        '    loadFrameCandidates,\n'
        '    sourceName,\n'
        '    waitUntilPrepared,\n'
        '  ]);\n\n'
        '  const verifyVideoFile = useCallback(async (file: File | null) => {\n'
        '    if (!file || busy) return;\n'
        '    clearReview();\n'
        '    cleanupRecording();\n'
        '    setError(null);\n'
        '    setSourceName(file.name);\n'
        '    try {\n'
        '      const url = URL.createObjectURL(file);\n'
        '      recordingUrlRef.current = url;\n'
        '      const video = playbackVideoRef.current;\n'
        '      if (!video) throw new Error("検証用動画を準備できませんでした");\n'
        '      video.src = url;\n'
        '      video.load();\n'
        '      await waitForVideoMetadata(video);\n'
        '      const duration = Number.isFinite(video.duration) && video.duration > 0\n'
        '        ? Math.min(CAPTURE_SECONDS, video.duration)\n'
        '        : CAPTURE_SECONDS;\n'
        '      setClipDuration(duration);\n'
        '      void processRecording(url, duration);\n'
        '    } catch (caught) {\n'
        '      console.error("Fixed video verification failed.", caught);\n'
        '      setError(caught instanceof Error ? caught.message : "動画を開けませんでした");\n'
        '      setPhase("error");\n'
        '      setProgress(null);\n'
        '    }\n'
        '  }, [busy, cleanupRecording, clearReview, processRecording]);\n\n'
        '  const recordFiveSeconds = useCallback(async () => {\n',
        'file verification handler',
    ),
    (
        '      setRecordingRemaining(CAPTURE_SECONDS);\n'
        '      setPhase("recording");\n',
        '      setSourceName("camera-five-seconds.webm");\n'
        '      setRecordingRemaining(CAPTURE_SECONDS);\n'
        '      setPhase("recording");\n',
        'camera source name',
    ),
    (
        '    setCurrentError(null);\n'
        '  }, [cleanupRecording, clearReview]);\n',
        '    setCurrentError(null);\n'
        '    setSourceName("");\n'
        '    setReport(null);\n'
        '  }, [cleanupRecording, clearReview]);\n',
        'reset source and report',
    ),
    (
        '  return (\n'
        '    <main className={styles.shell}>\n',
        '  return (\n'
        '    <main\n'
        '      className={styles.shell}\n'
        '      data-testid="verification-root"\n'
        '      data-state={phase}\n'
        '      data-verdict={report ? (report.passed ? "passed" : "failed") : "pending"}\n'
        '    >\n',
        'root test state',
    ),
    (
        '          <p className={styles.eyebrow}>MANY FACES / 5 SECOND REVIEW</p>\n'
        '          <h1>重い処理は後回し。まず5秒だけ撮る。</h1>\n'
        '          <p className={styles.lead}>\n'
        '            起動時に70,000枚を展開しません。録画をFace Meshで解析した後、必要な角度のshardだけを読み込みます。\n'
        '          </p>\n',
        '          <p className={styles.eyebrow}>MANY FACES / DETERMINISTIC VIDEO CHECK</p>\n'
        '          <h1>カメラの前に、同じ動画で壊れ方を潰す。</h1>\n'
        '          <p className={styles.lead}>\n'
        '            固定動画なら、毎回同じ入力でFace Mesh、角度shard、3D照合、strict経路、画像表示まで確認できます。カメラは比較用の実験扱いです。\n'
        '          </p>\n',
        'header copy',
    ),
    (
        '          <span>{phase === "review" ? "SOURCE VIDEO" : "CAMERA"}</span>\n'
        '          <b>{phase === "recording" ? `${recordingRemaining.toFixed(1)}s` : "5.0s"}</b>\n',
        '          <span>{phase === "review" ? "SOURCE VIDEO" : "INPUT"}</span>\n'
        '          <b>{phase === "recording" ? `${recordingRemaining.toFixed(1)}s` : sourceName || "NO VIDEO"}</b>\n',
        'source panel header',
    ),
    (
        '                    : "カメラを押すだけ。モデルやカタログの準備完了は待たなくて大丈夫です。"}\n',
        '                    : "まず固定動画を選んでください。同じ入力でこちら側も自動検証できます。"}\n',
        'placeholder copy',
    ),
    (
        '        <div className={styles.primaryRow}>\n'
        '          <button\n'
        '            type="button"\n'
        '            className={styles.primaryButton}\n'
        '            onClick={recordFiveSeconds}\n'
        '            disabled={busy}\n'
        '          >\n'
        '            {phase === "recording" ? "録画中" : "5秒撮る"}\n'
        '          </button>\n',
        '        <div className={styles.primaryRow}>\n'
        '          <label className={styles.filePicker}>\n'
        '            <span>固定動画で検証</span>\n'
        '            <input\n'
        '              type="file"\n'
        '              accept="video/*"\n'
        '              data-testid="verification-file-input"\n'
        '              onChange={(event) => {\n'
        '                void verifyVideoFile(event.target.files?.[0] ?? null);\n'
        '              }}\n'
        '              disabled={busy}\n'
        '            />\n'
        '          </label>\n'
        '          <button\n'
        '            type="button"\n'
        '            className={styles.cameraButton}\n'
        '            onClick={recordFiveSeconds}\n'
        '            disabled={busy}\n'
        '          >\n'
        '            {phase === "recording" ? "録画中" : "カメラで5秒（実験）"}\n'
        '          </button>\n',
        'file picker controls',
    ),
    (
        '        {error && <p className={styles.error}>{error}</p>}\n',
        '        {report && (\n'
        '          <div className={report.passed ? styles.passBox : styles.failBox}>\n'
        '            <strong>{report.passed ? "自動検証 PASS" : "自動検証で問題を検出"}</strong>\n'
        '            <span>\n'
        '              顔検出 {(report.faceCoverage * 100).toFixed(1)}% · {report.sequenceFrames} frames · {report.uniqueFaces} faces · {(report.processingMs / 1_000).toFixed(1)}秒\n'
        '            </span>\n'
        '            {!report.passed && report.reasons.map((reason) => (\n'
        '              <small key={reason}>{reason}</small>\n'
        '            ))}\n'
        '          </div>\n'
        '        )}\n\n'
        '        {error && <p className={styles.error}>{error}</p>}\n',
        'verification result UI',
    ),
    (
        '      </details>\n'
        '    </main>\n',
        '      </details>\n'
        '      <output hidden data-testid="verification-report">\n'
        '        {report ? JSON.stringify(report) : ""}\n'
        '      </output>\n'
        '    </main>\n',
        'hidden report output',
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f'Patch marker not found: {label}')
    text = text.replace(old, new, 1)

css += '''
.filePicker{position:relative;display:inline-flex;align-items:center;min-height:42px;padding:9px 15px;border:1px solid #eef2f7;border-radius:10px;background:#eef2f7;color:#11151b;font-weight:750;cursor:pointer}.filePicker input{position:absolute;inset:0;opacity:0;cursor:pointer}.filePicker:has(input:disabled){opacity:.4;cursor:not-allowed}.cameraButton{background:#171a21!important;color:#cbd1dc!important}.passBox,.failBox{display:flex;flex-direction:column;gap:5px;margin-top:12px;padding:12px 14px;border-radius:12px}.passBox{border:1px solid #315842;background:#102119;color:#bce8cd}.failBox{border:1px solid #6a353d;background:#241419;color:#ffbdc4}.passBox span,.failBox span{color:inherit;opacity:.82;font-size:12px}.passBox small,.failBox small{display:block;line-height:1.45}
'''

TSX.write_text(text, encoding='utf-8')
CSS.write_text(css, encoding='utf-8')
print('Applied deterministic video verification patch.')
