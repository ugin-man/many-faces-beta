# Many Faces — Video face composite

Face compositing is now the **default video mode** on `/` and `/live`. The former `/demo` route uses the same Studio entry for compatibility. The existing compositor and full-catalog video pipeline are reused; the protected original `app/live/review-client-lite.tsx` remains unchanged.

## Workflow

1. Open the usual home page, select `動画`, and choose a video with `動画を選ぶ` (or use the existing fixed reference clip).
2. Wait for normal full-catalog matching. The result canvas shows the original video background and body, but overlays the matched Many Faces photo on the tracked face.
3. The original input PiP is hidden in composite mode. Settings default to `動画に顔を合成`; the two photo-only display options remain available.
4. Use `画像保存` to save `many-faces-composite.png` or `合成動画保存` to record the rendered canvas as MP4 where MediaRecorder supports H.264, otherwise WebM. Video export records in real time without audio; the settings explain this. Browser support varies. Controls wrap on narrow screens so save and playback buttons remain reachable.

## Safety

- The original video is processed locally by the browser in this mode, as with the video lab; no server-side video upload is added.
- Missing candidate images, seeking frames, missing face detections, and frame synchronization gaps **hold the last fully protected composited frame** (including its background and opaque face cover). This avoids full-frame black flashes without ever rendering an uncovered source video. Before the first safe frame, a neutral privacy slate is shown. The retained frame is cleared on input change/reset.
- A solid face-sized matte is drawn before a feathered replacement photo; a direct transparent fade over the original face is prohibited.
- This is **not guaranteed anonymization**. The original subject may still be recognizable from hair, ears, neck, body, clothing, or background. Audio is omitted in exported videos. Inspect the entire output before publication.
- Browser capture is not a deterministic frame-perfect export; for production-grade videos use a frame-by-frame offline renderer with explicit gap checks.

## Verification

- Unit tests: `tests/demo-face-composite.test.mjs` verify fresh-frame gating and matte geometry.
- Browser QA: `.github/workflows/demo-face-composite.yml` checks the default composite mode on `/`, `/live`, and `/demo`; then processes the fixed video and exports PNG/video from `/`. It also checks source PiP visibility and that all controls fit a 390px phone viewport. FFmpeg checks the exported video for full-frame black flashes.
- Realtime camera processing, the 70k assets, face matching, and the dataset remain unchanged.
- A Git commit does not deploy the existing ChatGPT Site. Rebuild and publish the existing Site separately.

## Side-facing direction QA (automated scan complete; visual report pending)

The exact-photo side/near-frontal audits checked **53,971** packed catalog images, and the same MediaPipe model found **zero** opposite-sign yaw discrepancies. This does not prove visual correctness because the original catalog and audit may share a systematic pose error. See [SIDE_YAW_AUDIT_20261014.md](SIDE_YAW_AUDIT_20261014.md). The user-reported opposite-facing photo(s) have not been replaced. Use the `誤画像を報告` button at the offending demo frame to export `many-faces-wrong-photo.json` with its exact image ID and yaw; no private video bytes are included. Once the exact original photo is independently confirmed, exclude it **before** selection, refill to 70,000, re-test and only then republish. Do not flip an entire yaw cell on suspicion.

## Black-flash regression gate

The full browser QA run [38445537467](https://github.com/ugin-man/many-faces-beta/actions/runs/38445537467) passed on commit `cbb70e0633c30bdb3d1c271a54b71da560503d0b`: real fixed-video matching, PNG export, MP4/WebM export and FFmpeg full-frame black-flash detection. A previous QA failure was due to **FFmpeg missing on the CI runner** (exit 127), not an observed black frame; the workflow now installs FFmpeg and executes the check. This validates the test fixture, not every personal recording or complete anonymity.

The deployed ChatGPT Site is managed separately from GitHub; this evidence does not establish that this commit has been published to that Site.
