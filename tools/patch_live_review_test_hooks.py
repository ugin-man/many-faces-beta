#!/usr/bin/env python3
"""Add stable, non-visual selectors for the deterministic browser verifier."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

replacements = [
    (
        '<main className={styles.shell}>',
        '<main className={styles.shell} data-live-review-root data-phase={phase}>',
        'review root',
    ),
    (
        '<strong>{phaseText(phase)}</strong>',
        '<strong data-verification-phase>{phaseText(phase)}</strong>',
        'phase label',
    ),
    (
        '<div className={styles.progressBox}>',
        '<div className={styles.progressBox} data-verification-progress>',
        'progress box',
    ),
    (
        '<canvas\n                ref={outputCanvasRef}',
        '<canvas\n                data-output-canvas\n                ref={outputCanvasRef}',
        'output canvas',
    ),
]

for old, new, label in replacements:
    if new in text:
        continue
    if old not in text:
        raise SystemExit(f"Browser-verification marker not found: {label}")
    text = text.replace(old, new, 1)

if 'data-fixed-video-input' not in text:
    marker = 'type="file"'
    if marker not in text:
        raise SystemExit("Fixed-video file input marker not found")
    text = text.replace(
        marker,
        'data-fixed-video-input\n                type="file"',
        1,
    )

PATH.write_text(text, encoding="utf-8")
print("Browser verification hooks applied or already present.")
