#!/usr/bin/env python3
"""Ensure the review canvas is mounted before the first output draw."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

old = '''      setPhase("review");
      video.currentTime = 0;
      drawReviewAt(0);
      await nextPaint();
      const canvas = outputCanvasRef.current;
'''
new = '''      setPhase("review");
      video.currentTime = 0;
      await nextPaint();
      drawReviewAt(0);
      await nextPaint();
      const canvas = outputCanvasRef.current;
'''

if old in text:
    PATH.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("Applied review-canvas mount barrier.")
elif new in text:
    print("Review-canvas mount barrier already applied.")
else:
    raise SystemExit("Review-canvas mount marker not found")
