#!/usr/bin/env python3
"""Allow faithful camera capture to begin while catalog/model setup continues."""

from pathlib import Path

PATH = Path("app/live/faithful-client.tsx")
text = PATH.read_text(encoding="utf-8")

if "const engineReadyRef = useRef(false);" in text:
    print("Faithful early-capture patch already applied.")
    raise SystemExit(0)

replacements = [
    (
        'import { DelayedFaithfulCommitter } from "./faithful-delay";\n',
        'import { DelayedFaithfulCommitter } from "./faithful-delay";\n'
        'import {\n'
        '  canProcessFaithfulQueue,\n'
        '  canStartFaithfulCapture,\n'
        '} from "./faithful-startup";\n',
        "startup helper import",
    ),
    (
        '  const landmarkerRef = useRef<FaceLandmarker | null>(null);\n'
        '  const candidatesRef = useRef<Candidate[]>([]);\n',
        '  const landmarkerRef = useRef<FaceLandmarker | null>(null);\n'
        '  const engineReadyRef = useRef(false);\n'
        '  const catalogReadyRef = useRef(false);\n'
        '  const candidatesRef = useRef<Candidate[]>([]);\n',
        "readiness refs",
    ),
    (
        '  const processQueue = useCallback(() => {\n'
        '    if (processingRef.current) return;\n'
        '    processingRef.current = true;\n',
        '  const processQueue = useCallback(() => {\n'
        '    if (\n'
        '      processingRef.current ||\n'
        '      !canProcessFaithfulQueue(\n'
        '        Boolean(landmarkerRef.current),\n'
        '        candidatesRef.current.length,\n'
        '      )\n'
        '    ) {\n'
        '      return;\n'
        '    }\n'
        '    processingRef.current = true;\n',
        "queue readiness gate",
    ),
    (
        '      } finally {\n'
        '        processingRef.current = false;\n'
        '        if (queueRef.current.length) processQueueRef.current();\n'
        '      }\n',
        '      } finally {\n'
        '        processingRef.current = false;\n'
        '        if (\n'
        '          queueRef.current.length &&\n'
        '          canProcessFaithfulQueue(\n'
        '            Boolean(landmarkerRef.current),\n'
        '            candidatesRef.current.length,\n'
        '          )\n'
        '        ) {\n'
        '          processQueueRef.current();\n'
        '        }\n'
        '      }\n',
        "queue restart gate",
    ),
    (
        '        candidatesRef.current = candidates;\n'
        '        if (!disposed) {\n'
        '          setCandidateCount(candidates.length);\n'
        '          setCatalogReady(true);\n'
        '        }\n\n'
        '        const { FaceLandmarker, FilesetResolver } = await import(\n',
        '        candidatesRef.current = candidates;\n'
        '        catalogReadyRef.current = true;\n'
        '        if (!disposed) {\n'
        '          setCandidateCount(candidates.length);\n'
        '          setCatalogReady(true);\n'
        '        }\n'
        '        processQueueRef.current();\n\n'
        '        const { FaceLandmarker, FilesetResolver } = await import(\n',
        "catalog ready resume",
    ),
    (
        '        landmarkerRef.current = landmarker;\n'
        '        setEngineReady(true);\n',
        '        landmarkerRef.current = landmarker;\n'
        '        engineReadyRef.current = true;\n'
        '        setEngineReady(true);\n'
        '        processQueueRef.current();\n',
        "engine ready resume",
    ),
    (
        '      disposedRef.current = true;\n'
        '      capturingRef.current = false;\n',
        '      disposedRef.current = true;\n'
        '      engineReadyRef.current = false;\n'
        '      catalogReadyRef.current = false;\n'
        '      capturingRef.current = false;\n',
        "cleanup readiness",
    ),
    (
        '    if (\n'
        '      !engineReady ||\n'
        '      !catalogReady ||\n'
        '      capturingRef.current ||\n'
        '      draining\n'
        '    ) {\n'
        '      return;\n'
        '    }\n',
        '    if (!canStartFaithfulCapture(capturingRef.current, draining)) {\n'
        '      return;\n'
        '    }\n',
        "camera start gate",
    ),
    (
        '          <button type="button" onClick={start} disabled={!ready || busy}>\n'
        '            カメラを開始\n'
        '          </button>\n',
        '          <button type="button" onClick={start} disabled={busy}>\n'
        '            {ready ? "カメラを開始" : "準備中からカメラを開始"}\n'
        '          </button>\n',
        "camera button",
    ),
    (
        '              <strong>{ready ? "CAMERA START" : "LOADING FULL CATALOG"}</strong>\n'
        '              <span>\n'
        '                {busy\n'
        '                  ? `${lookaheadSeconds.toFixed(0)}秒ぶんの経路が確定するまで保持中`\n'
        '                  : "高速化・フレーム破棄・ready fallbackなし"}\n'
        '              </span>\n',
        '              <strong>{busy ? "CAPTURING INTO FIFO" : "CAMERA START"}</strong>\n'
        '              <span>\n'
        '                {busy\n'
        '                  ? ready\n'
        '                    ? `${lookaheadSeconds.toFixed(0)}秒ぶんの経路が確定するまで保持中`\n'
        '                    : "カタログと追跡エンジンの準備中。入力はFIFOへ保持中"\n'
        '                  : ready\n'
        '                    ? "高速化・フレーム破棄・ready fallbackなし"\n'
        '                    : "準備完了を待たずにカメラ入力をFIFOへ積めます"}\n'
        '              </span>\n',
        "preparing stage copy",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Patch marker not found: {label}")
    text = text.replace(old, new, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied faithful early-capture patch.")
