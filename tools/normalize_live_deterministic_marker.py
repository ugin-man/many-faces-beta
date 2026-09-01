#!/usr/bin/env python3
from pathlib import Path

path = Path("app/live/review-client-lite.tsx")
text = path.read_text(encoding="utf-8")

if 'data-testid="verification-file-input"' in text:
    print("Deterministic video UI is already applied.")
    raise SystemExit(0)

changed = False

camera_source = (
    '    setRecordingRemaining(CAPTURE_SECONDS);\n'
    '    setPhase("recording");\n'
)
camera_target = (
    '      setRecordingRemaining(CAPTURE_SECONDS);\n'
    '      setPhase("recording");\n'
)
if camera_source in text:
    text = text.replace(camera_source, camera_target, 1)
    changed = True
elif camera_target not in text:
    raise SystemExit("Camera-source marker was not found in the live review client")

panel_source = (
    '            <span>{phase === "review" ? "SOURCE VIDEO" : "CAMERA"}</span>\n'
    '            <b>{phase === "recording" ? `${recordingRemaining.toFixed(1)}s` : "5.0s"}</b>\n'
)
panel_target = (
    '          <span>{phase === "review" ? "SOURCE VIDEO" : "CAMERA"}</span>\n'
    '          <b>{phase === "recording" ? `${recordingRemaining.toFixed(1)}s` : "5.0s"}</b>\n'
)
if panel_source in text:
    text = text.replace(panel_source, panel_target, 1)
    changed = True
elif panel_target not in text:
    raise SystemExit("Source-panel marker was not found in the live review client")

if changed:
    path.write_text(text, encoding="utf-8")
    print("Normalized deterministic video patch markers.")
else:
    print("Deterministic video patch markers were already normalized.")
