#!/usr/bin/env python3
"""Remove the derived-state effect from the five-second review client."""

from pathlib import Path

PATH = Path("app/live/review-client.tsx")
text = PATH.read_text(encoding="utf-8")

if "const reviewEngineReadyRef = useRef(false);" in text:
    print("Review readiness patch already applied.")
    raise SystemExit(0)

replacements = [
    (
        '  const landmarkerRef = useRef<FaceLandmarker | null>(null);\n'
        '  const candidatesRef = useRef<Candidate[]>([]);\n',
        '  const landmarkerRef = useRef<FaceLandmarker | null>(null);\n'
        '  const reviewEngineReadyRef = useRef(false);\n'
        '  const reviewCatalogReadyRef = useRef(false);\n'
        '  const candidatesRef = useRef<Candidate[]>([]);\n',
        "review readiness refs",
    ),
    (
        '        candidatesRef.current = candidates;\n'
        '        setCandidateCount(candidates.length);\n'
        '        setCatalogReady(true);\n',
        '        candidatesRef.current = candidates;\n'
        '        reviewCatalogReadyRef.current = true;\n'
        '        setCandidateCount(candidates.length);\n'
        '        setCatalogReady(true);\n'
        '        if (reviewEngineReadyRef.current) {\n'
        '          setPhase((current) => current === "preparing" ? "ready" : current);\n'
        '        }\n',
        "catalog completion transition",
    ),
    (
        '        landmarkerRef.current = landmarker;\n'
        '        setEngineReady(true);\n',
        '        landmarkerRef.current = landmarker;\n'
        '        reviewEngineReadyRef.current = true;\n'
        '        setEngineReady(true);\n'
        '        if (reviewCatalogReadyRef.current) {\n'
        '          setPhase((current) => current === "preparing" ? "ready" : current);\n'
        '        }\n',
        "engine completion transition",
    ),
    (
        '      cleanupRecording();\n'
        '      cleanupReview();\n'
        '      landmarkerRef.current?.close();\n',
        '      cleanupRecording();\n'
        '      cleanupReview();\n'
        '      reviewEngineReadyRef.current = false;\n'
        '      reviewCatalogReadyRef.current = false;\n'
        '      landmarkerRef.current?.close();\n',
        "readiness cleanup",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Patch marker not found: {label}")
    text = text.replace(old, new, 1)

old_effect = '''\n  useEffect(() => {
    if (
      phase === "preparing" &&
      engineReady &&
      catalogReady
    ) {
      setPhase("ready");
    }
  }, [catalogReady, engineReady, phase]);
'''
if old_effect not in text:
    raise SystemExit("Patch marker not found: derived readiness effect")
text = text.replace(old_effect, "\n", 1)

PATH.write_text(text, encoding="utf-8")
print("Applied event-driven review readiness patch.")
