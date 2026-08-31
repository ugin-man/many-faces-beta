#!/usr/bin/env python3
"""Make the lightweight review's replay-FPS ref React-safe and idempotent."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

text = text.replace(
    '/* eslint-disable @next/next/no-img-element */\n\n',
    '',
    1,
)

old = '  replayFpsRef.current = replayFps;\n\n  const busy ='
new = (
    '  useEffect(() => {\n'
    '    replayFpsRef.current = replayFps;\n'
    '  }, [replayFps]);\n\n'
    '  const busy ='
)

if old in text:
    text = text.replace(old, new, 1)
elif 'replayFpsRef.current = replayFps;\n  }, [replayFps]);' not in text:
    raise SystemExit("Lightweight review replay-FPS marker not found")

PATH.write_text(text, encoding="utf-8")
print("Lightweight review lint patch applied or already present.")
