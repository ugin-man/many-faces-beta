#!/usr/bin/env python3
from pathlib import Path

path = Path("app/live/review-client-lite.tsx")
text = path.read_text(encoding="utf-8")

if 'data-testid="verification-file-input"' in text:
    print("Deterministic video UI is already applied.")
    raise SystemExit(0)

source = (
    '    setRecordingRemaining(CAPTURE_SECONDS);\n'
    '    setPhase("recording");\n'
)
target = (
    '      setRecordingRemaining(CAPTURE_SECONDS);\n'
    '      setPhase("recording");\n'
)

if source in text:
    path.write_text(text.replace(source, target, 1), encoding="utf-8")
    print("Normalized deterministic camera-source marker.")
elif target in text:
    print("Deterministic camera-source marker already normalized.")
else:
    raise SystemExit("Camera-source marker was not found in the live review client")
