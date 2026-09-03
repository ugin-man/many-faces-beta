#!/usr/bin/env python3
"""Add deterministic sequence IDs and phase timing telemetry to /live."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

if "sequenceFingerprint: string;" in text:
    print("Fixed-video verification metrics already applied.")
    raise SystemExit(0)

replacements = [
    (
        'import { evaluateVerificationGate } from "./verification-gate";\n',
        'import { evaluateVerificationGate } from "./verification-gate";\n'
        'import {\n'
        '  emptyReviewPhaseTimings,\n'
        '  reviewSequenceFingerprint,\n'
        '  roundedReviewPhaseTimings,\n'
        '  type ReviewPhaseTimings,\n'
        '} from "./review-sequence-metrics";\n',
        "metrics import",
    ),
    (
        '  processingMs: number;\n'
        '  canvasNonBlank: boolean;\n',
        '  processingMs: number;\n'
        '  phaseTimingsMs: ReviewPhaseTimings;\n'
        '  sequenceIds: string[];\n'
        '  sequenceFingerprint: string;\n'
        '  canvasNonBlank: boolean;\n',
        "report fields",
    ),
    (
        '    const started = performance.now();\n'
        '    setError(null);\n',
        '    const started = performance.now();\n'
        '    const phaseTimings = emptyReviewPhaseTimings();\n'
        '    let phaseStarted = started;\n'
        '    setError(null);\n',
        "timer initialization",
    ),
    (
        '      setPhase("waiting");\n'
        '      await waitUntilPrepared(token);\n'
        '      const video = playbackVideoRef.current;\n',
        '      setPhase("waiting");\n'
        '      await waitUntilPrepared(token);\n'
        '      phaseTimings.preparation = performance.now() - phaseStarted;\n'
        '      const video = playbackVideoRef.current;\n',
        "preparation timer",
    ),
    (
        '      const frames: SequenceFrame[] = [];\n\n'
        '      setPhase("analyzing");\n',
        '      const frames: SequenceFrame[] = [];\n\n'
        '      phaseStarted = performance.now();\n'
        '      setPhase("analyzing");\n',
        "analysis timer start",
    ),
    (
        '      setFaceFrames(frames.length);\n'
        '      if (frames.length < 2) {\n',
        '      phaseTimings.faceMesh = performance.now() - phaseStarted;\n'
        '      setFaceFrames(frames.length);\n'
        '      if (frames.length < 2) {\n',
        "analysis timer end",
    ),
    (
        '      setPhase("searching");\n'
        '      const beams: Array<Array<{ candidate: Candidate; error: ProjectionError }>> = [];\n',
        '      phaseStarted = performance.now();\n'
        '      setPhase("searching");\n'
        '      const beams: Array<Array<{ candidate: Candidate; error: ProjectionError }>> = [];\n',
        "search timer start",
    ),
    (
        '      // The beams retain every candidate needed by the final path. Clearing the\n',
        '      phaseTimings.candidateSearch = performance.now() - phaseStarted;\n\n'
        '      // The beams retain every candidate needed by the final path. Clearing the\n',
        "search timer end",
    ),
    (
        '      setPhase("optimizing");\n'
        '      setProgress({ done: 0, total: 1, label: "5秒全体のstrict経路を計算中" });\n',
        '      phaseStarted = performance.now();\n'
        '      setPhase("optimizing");\n'
        '      setProgress({ done: 0, total: 1, label: "5秒全体のstrict経路を計算中" });\n',
        "optimizer timer start",
    ),
    (
        '      if (!choices.length) throw new Error("連続経路を作れませんでした");\n'
        '      const timeline = choices.map((choice) => ({\n',
        '      if (!choices.length) throw new Error("連続経路を作れませんでした");\n'
        '      phaseTimings.pathOptimization = performance.now() - phaseStarted;\n'
        '      const timeline = choices.map((choice) => ({\n',
        "optimizer timer end",
    ),
    (
        '      setPhase("preloading");\n'
        '      const selected = [...new Map(\n',
        '      phaseStarted = performance.now();\n'
        '      setPhase("preloading");\n'
        '      const selected = [...new Map(\n',
        "preload timer start",
    ),
    (
        '      setImageFailures(failures);\n'
        '      const changes = choices.reduce((count, choice, index) =>\n',
        '      phaseTimings.imagePreload = performance.now() - phaseStarted;\n'
        '      setImageFailures(failures);\n'
        '      const sequenceIds = choices.map((choice) => choice.candidate.id);\n'
        '      const sequenceFingerprint = reviewSequenceFingerprint(sequenceIds);\n'
        '      const changes = choices.reduce((count, choice, index) =>\n',
        "preload timer end and sequence",
    ),
    (
        '        processingMs: elapsed,\n'
        '        canvasNonBlank,\n',
        '        processingMs: elapsed,\n'
        '        phaseTimingsMs: roundedReviewPhaseTimings(phaseTimings),\n'
        '        sequenceIds,\n'
        '        sequenceFingerprint,\n'
        '        canvasNonBlank,\n',
        "report metrics",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Patch marker not found: {label}")
    text = text.replace(old, new, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied fixed-video verification metrics.")
