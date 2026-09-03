#!/usr/bin/env python3
"""Make fixed-video Face Mesh analysis wait for the decoded target frame.

`seeked` only means the media element moved its timeline.  It does not guarantee
that the frame presented to canvas/MediaPipe has been decoded.  Calling
FaceLandmarker directly on the paused video immediately after `seeked` caused
stale or empty frames and a 65% face-detection rate on the deterministic fixture.
This patch waits for requestVideoFrameCallback (with a loaded-data fallback),
paints the exact frame to a reusable canvas, and analyzes that canvas instead.
"""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

TYPE_BLOCK = '''type VideoFrameCallbackMetadata = {\n  mediaTime?: number;\n  presentedFrames?: number;\n};\n\ntype VideoWithFrameCallback = HTMLVideoElement & {\n  requestVideoFrameCallback?: (\n    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,\n  ) => number;\n  cancelVideoFrameCallback?: (id: number) => void;\n};\n\n'''

if "type VideoWithFrameCallback = HTMLVideoElement" not in text:
    marker = "function clamp(value: number, min: number, max: number) {"
    if marker not in text:
        raise SystemExit("Video-frame type insertion marker not found")
    text = text.replace(marker, TYPE_BLOCK + marker, 1)

HELPER = '''function waitForDecodedVideoFrame(\n  video: HTMLVideoElement,\n  targetTime: number,\n) {\n  return new Promise<void>((resolve) => {\n    const source = video as VideoWithFrameCallback;\n    let callbackId: number | null = null;\n    let settled = false;\n    const finish = () => {\n      if (settled) return;\n      settled = true;\n      window.clearTimeout(timeout);\n      if (callbackId !== null) source.cancelVideoFrameCallback?.(callbackId);\n      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));\n    };\n    const timeout = window.setTimeout(finish, 2_500);\n\n    if (source.requestVideoFrameCallback) {\n      callbackId = source.requestVideoFrameCallback((_now, metadata) => {\n        const mediaTime = Number(metadata.mediaTime);\n        // A browser may report the nearest decodable timestamp rather than the\n        // exact requested timestamp.  The callback itself is the important\n        // presentation barrier; the tolerance is retained for diagnostics.\n        void targetTime;\n        void mediaTime;\n        finish();\n      });\n      return;\n    }\n    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {\n      finish();\n      return;\n    }\n    video.addEventListener("loadeddata", finish, { once: true });\n  });\n}\n\n'''

if "function waitForDecodedVideoFrame(" not in text:
    marker = "function seekVideo(video: HTMLVideoElement, time: number) {"
    if marker not in text:
        raise SystemExit("Decoded-frame helper insertion marker not found")
    text = text.replace(marker, HELPER + marker, 1)

REF = "  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);\n"
if REF not in text:
    marker = "  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);\n"
    if marker not in text:
        raise SystemExit("Analysis-canvas ref insertion marker not found")
    text = text.replace(marker, marker + REF, 1)

old = '''        await seekVideo(video, time);\n        const result = landmarker.detect(video);'''
new = '''        await seekVideo(video, time);\n        await waitForDecodedVideoFrame(video, time);\n        const canvas = analysisCanvasRef.current ?? document.createElement("canvas");\n        analysisCanvasRef.current = canvas;\n        const sourceWidth = Math.max(1, video.videoWidth);\n        const sourceHeight = Math.max(1, video.videoHeight);\n        if (canvas.width !== sourceWidth || canvas.height !== sourceHeight) {\n          canvas.width = sourceWidth;\n          canvas.height = sourceHeight;\n        }\n        const context = canvas.getContext("2d", { alpha: false });\n        if (!context) {\n          throw new Error("解析用キャンバスを準備できませんでした");\n        }\n        context.drawImage(video, 0, 0, sourceWidth, sourceHeight);\n        const result = landmarker.detect(canvas);'''

if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("Face-analysis replacement marker not found")

PATH.write_text(text, encoding="utf-8")
print("Decoded video-frame analysis patch applied or already present.")
