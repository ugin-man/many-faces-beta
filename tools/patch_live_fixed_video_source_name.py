#!/usr/bin/env python3
"""Pass the submitted video name directly into the processing callback.

React state updates are asynchronous. The previous callback captured the prior
`sourceName`, so a fixed-video run could complete successfully but be reported
as `camera-five-seconds.webm`. That made evidence ambiguous across repeated
runs.
"""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

text = text.replace(
    '''  const processRecording = useCallback(async (
    videoUrl: string,
    duration: number,
  ) => {''',
    '''  const processRecording = useCallback(async (
    videoUrl: string,
    duration: number,
    inputName: string,
  ) => {''',
    1,
)
text = text.replace(
    '''        sourceName: sourceName || "camera-five-seconds.webm",''',
    '''        sourceName: inputName,''',
    1,
)
text = text.replace(
    '''    sourceName,
    waitUntilPrepared,''',
    '''    waitUntilPrepared,''',
    1,
)
text = text.replace(
    '''      void processRecording(url, duration);''',
    '''      void processRecording(url, duration, file.name);''',
    1,
)
text = text.replace(
    '''      void processRecording(url, duration);
    } catch (caught) {''',
    '''      void processRecording(url, duration, "camera-five-seconds.webm");
    } catch (caught) {''',
    1,
)

if "inputName: string" not in text or "sourceName: inputName" not in text:
    raise SystemExit("Fixed-video source-name patch did not apply")
if "processRecording(url, duration, file.name)" not in text:
    raise SystemExit("Fixed-video call marker did not apply")
if 'processRecording(url, duration, "camera-five-seconds.webm")' not in text:
    raise SystemExit("Camera call marker did not apply")

PATH.write_text(text, encoding="utf-8")
print("Applied deterministic video source-name patch.")
