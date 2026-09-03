#!/usr/bin/env python3
"""Mount the review canvas before drawing and expose stable E2E selectors."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

old_order = '''      setPhase("review");
      video.currentTime = 0;
      drawReviewAt(0);
      await nextPaint();
      const canvas = outputCanvasRef.current;
'''
new_order = '''      setPhase("review");
      video.currentTime = 0;
      await nextPaint();
      drawReviewAt(0);
      await nextPaint();
      const canvas = outputCanvasRef.current;
'''

if old_order in text:
    text = text.replace(old_order, new_order, 1)
elif new_order not in text:
    raise SystemExit("Review-canvas mount marker not found")

old_canvas = '''              <canvas
                ref={outputCanvasRef}
                className={styles.canvas}
                width={768}
                height={512}
              />
'''
new_canvas = '''              <canvas
                ref={outputCanvasRef}
                className={styles.canvas}
                width={768}
                height={512}
                data-testid="verification-output-canvas"
              />
'''
if old_canvas in text:
    text = text.replace(old_canvas, new_canvas, 1)
elif new_canvas not in text:
    raise SystemExit("Review-canvas selector marker not found")

PATH.write_text(text, encoding="utf-8")
print("Review-canvas mount barrier and E2E selector are present.")
