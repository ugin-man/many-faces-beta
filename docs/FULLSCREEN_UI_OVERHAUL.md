# Many Faces fullscreen studio — 2026-10-03 JST

## Scope and review target

Repository: `ugin-man/many-faces-beta`. Branch: `astra/realtime-hardening`. Draft PR #3 remains against `work/coverage-driven-200k`; no base/main merge or hosted Site deployment was performed.

The application change is commit `11312d2a83d2574d1c400a141fa6f7e8dc2f1147`. Fullscreen browser verification completed on `19874826be9edbe2a27edc9480c0cdce94884059`. Native input-policy and legacy acquisition verification completed on `e9e5c29c503100f98d93c396e23b916fe4b2f36a`. The latter two commits change test infrastructure only; their application sources are identical to 11312d2. Subsequent documentation commits do not alter the application.

Rebuild the EXISTING ChatGPT Work Site from this branch. Git updates do not automatically rebuild an existing Site. Do not create a reduced catalog or alternate preview product. The new root `/` is the studio; `/live` opens video verification and `/live/astra` opens realtime. Diagnostic build is `fullscreen-v1`, visible as `Fullscreen UI v1` only under Settings > Image information / diagnostics.

## Interface

The old three-tab navigation, landing-page concept copy, adjacent miniature result panels and persistent face-guide overlays are removed from the active interface. There are exactly two mode buttons, video verification and realtime camera, on a shared call-style surface.

The result canvas fills the viewport. The original recording or camera preview appears in a small upper-right picture-in-picture. A compact bottom dock holds actual actions. Video review has playback/pause, seeking, previous/next frame and file replacement; its idle screen has file selection and the existing fixed-recording button. Realtime has camera start/stop. Camera selection, paired mirroring, video analysis density, contain/fullscreen choices and diagnostics are in a modal settings sheet rather than permanently covering the result.

Tapping the result hides/reveals the controls. The back button, a deliberate downward or left-edge swipe, and Escape reset the current activity. Swiping a slider/button/PiP is excluded from dismissal. Switching mode unmounts the other engine and releases its resources. The former fast/fifo/legacy routes redirect to realtime rather than exposing additional products.

Default cover presentation deliberately crops square catalog images to the viewport; Settings > Show entire image switches to contain. The images themselves have NOT been upscaled with fabricated detail. Their limited original resolution remains visible when enlarged.

## Preserved reference and assets

The entire 70,000-image catalog remains byte-for-byte unchanged, Git tree `559f7f39e3a8eed452ef7eb6a3355a318235c307`. Runtime pose-local access is not catalog reduction and is not a claim of exhaustive all-70k matching for every live frame.

The existing bundled reference recording is retained in full, 23.3 seconds, not replaced by a five-second mock or silently truncated. The fixed-recording button uses that recording through the repaired File/Blob capture path. The active studio reanalyzes the footage with the current matcher; it does not silently reuse old cached ranking results from a different catalog. The original cached analysis/rankings and legacy lab source also remain in the repository for reference/rollback, not as a third active UI mode.

Unchanged SHA-256 values:

- `public/test-fixtures/reference-face-motion.mp4`: `d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b`.
- `public/test-fixtures/reference-face-motion-analysis.json`: `b84e185e726bd3f0e5966377863c03f52b795391d8d2d23628f8f5c797d314af`.
- `public/test-fixtures/reference-face-motion-rankings.json`: `6b289dafe26f4989342289e32a1c4e831e9aa0df9d8f06d748f27913345126cf`.

Testing reused this already-bundled, user-requested reference asset. A virtual-camera test transcodes its first eight seconds as a disposable CI stimulus. No newly captured private camera recording was uploaded. The standalone historical input suite separately uses catalog-photograph fixtures.

## Matching changes and limits

`catalogFeatureFromResult` now supplies both camera and video with absolute, continuous catalog-convention pose and raw face actions. The previous realtime source-only startup expression subtraction and relative-to-startup pitch calibration did not match the stored absolute photograph descriptors. They could erase a sustained initial expression or head tilt. The new unit regression preserves a 28-degree pitch, 0.8 smile and 0.9 blink value across 24 calls; it is a convention regression, not human-motion certification. Lightweight temporal smoothing remains in realtime.

Video sequence optimization explicitly allows repeated identities. It no longer has to select a worse face merely because the better identity was used recently. The distinct-identity default is retained for other callers, and repeat-enabled path states keep the cheapest history per current candidate. An exact-match regression verifies the opt-in behavior.

These changes do NOT establish finished expression fidelity. The current reference run's mean matcher error is 0.13813 and mean mouth geometry error is 0.10573 in internal normalized units; functional output success is not perceptual acceptance. Frames with no detected face and fine mouth/eye matching still need improvement. Enlarged source-photo resolution is also a separate quality limit.

## Completed verification

### Fullscreen UI and full existing recording

Run [37070413965](https://github.com/ugin-man/many-faces-beta/actions/runs/37070413965), commit 19874826, completed successfully against the exact checked-out full-catalog source. Build, all 149 tests (149 passed, zero skipped), lint (zero errors; 13 existing warnings) and source/asset-integrity checks passed.

The actual browser UI loaded the fixed recording, analyzed its full duration at 12 samples/second, produced output, played past five seconds, paused, stepped frames, sought through the timeline, mirrored both views together, opened settings/diagnostics and switched into realtime. Result geometry covered 390x844 and 1440x900 viewports with no mobile horizontal overflow or old navigation. Screenshots were captured at 0, 5.833, 11.667, 17.5 and 21.917 seconds plus desktop/mobile camera views. Mobile/desktop output, Japanese controls, the PiP and a downward-head-pose view were visually inspected.

Recorded-video result: 279 planned samples, 243 face-detected samples, 243 sequence samples, 104 selected images, zero image-load failures and a nonblank result. Detection coverage was 87.10%. Processing took 166.46 seconds in this headless software-rendered CI run; 12 fps is sampling density, NOT processing speed. Mean absolute stored-candidate yaw/pitch differences were 4.57/2.93 degrees. These compare model descriptors, not independently labelled ground truth.

The native file-backed virtual camera reached a running snapshot with 74 processed frames, 51 face frames, 25 photo changes and zero image failures. Its instantaneous processed rate was 19 fps, photo-change rate 6/s and recorded capture-to-draw P95 77 ms. These are a short single-run snapshot, not a performance-improvement comparison or a physical-camera guarantee. Actual edge-swipe exit and mode switching stopped every acquired media track; restarting and cancelling video preparation also passed. No uncaught page errors occurred.

Evidence [artifact 11253983240](https://github.com/ugin-man/many-faces-beta/actions/runs/37070413965/artifacts/11253983240), 3,115,222 bytes, SHA-256 `5444d2d4fa7ff2d4de3e65d87cdbf2b4b732522e958ba1f2c30b7d91cbd4aef0`. The downloaded archive hash was verified and its JSON/logs/screenshots inspected.

### Input compatibility and retained fixed-file processing

Run [37070635689](https://github.com/ugin-man/many-faces-beta/actions/runs/37070635689), commit e9e5c29c, completed successfully. It retained all 18 real-photo yaw-convention cases and all nine decoded-pixel acquisition cases. Native policy denial, permission denial/retry, injected absent presentation callbacks/direct-video-bitmap incompatibility, paired mirror controls, stop/restart and mode-change track release passed.

The actual new video UI also completed the separate five-second photograph MP4 at 12/20/30-fps sampling densities: 60/100/150 planned, detected and sequence samples respectively, zero image failures, nonblank output and working playback/pause/frame stepping.

Evidence [artifact 11254563080](https://github.com/ugin-man/many-faces-beta/actions/runs/37070635689/artifacts/11254563080), SHA-256 `b4f10abfa0a9e958199092fbd71d3573d9f76919066cccd8496e2e530cff3c35`; downloaded and verified. Repository CI [37070640124](https://github.com/ugin-man/many-faces-beta/actions/runs/37070640124) also completed successfully.

The first fullscreen harness run stopped because ffmpeg was absent from the runner; the workflow now provisions ffmpeg and Japanese QA fonts explicitly. An intermediate input-policy fixture was physically covered by the new fullscreen host; its native denied-policy iframe is now placed above the host with adequate dimensions. Neither fix weakens the application assertions, injects fake matching output, or rewrites application source during testing.

## Unverified / next

The user's hosted Site has not been rebuilt or tested in this run. Physical Windows/iPhone cameras, Safari, touch hardware, long sessions and perceptual expression fidelity remain unverified. A mouse-driven browser swipe verifies the gesture handler, not an iPhone hardware gesture. Avoid describing these results as production-ready, warning-free or completed face tracking.
