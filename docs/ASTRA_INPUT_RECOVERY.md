# Many Faces input recovery — 2026-09-24 JST

## Scope and version

The user reported that realtime video input worked, physical camera input did not, source/output faces appeared horizontally reversed, and the other video screen failed with an incompletely remembered message beginning with 「目的」.

Repository: `ugin-man/many-faces-beta`. Branch: `astra/realtime-hardening`. Draft PR #3 still targets `work/coverage-driven-200k`. No base/main merge or hosted Site deployment was performed. The full 70,000-image catalog was retained; no reduced catalog or new application ZIP was created.

- Previously packaged source: `8eb47b7d188644e91ed883ba5757980d3b4e7f0d`.
- Input implementation and completed specialized browser checks: `5f0a0b136f9d5a5898608f75aa3d4ad7849438b1`.
- Subsequent mobile CSS correction: `99548fe830adfa81d0dc6d01947684926ed2dd77`. Input JavaScript is unchanged from the specialized-tested revision.
- Visible screen marker: **INPUT RECOVERY V1**. Diagnostic `build`: `input-recovery-v1`.
- Realtime: `/live/astra`. Fixed-video review: `/live`.

The old downloaded ZIP and an already built/deployed Site do not acquire these changes merely because the Git branch was updated. Rebuild the existing Site from the updated branch, then check the visible marker. Do not restart from the older 8eb47b7d package and assume it contains this repair.

## 1. Reproduced horizontal-pose defect

The stored catalog was generated in Python using a row-major matrix. MediaPipe Web exposes a column-major packed matrix. The browser copied the Python flat offsets directly, so its yaw calculation disagreed with the catalog coordinate convention.

A real-browser probe read 18 existing photographs from yaw cells around -30, -18, -9, +9, +18 and +30 degrees and ran the actual Face Landmarker. All 18 photographs were detected. Using the old formula, yaw sign agreed with the stored catalog for **0/18**. The corrected formula agreed for **18/18**. Mean absolute yaw error against the stored values was **37.901596 degrees before, 2.665016 degrees after**.

`app/catalog-pose.ts` now translates the matrix offsets, rather than compensating by flipping output pixels. Both the realtime worker and fixed-video review use it. The realtime landmark-pitch calibration remains present; the photograph check is a yaw-convention regression, not certification of every pitch/roll estimate or final matching quality.

Input pixels used for analysis are now unmirrored for both video and camera. Camera mirror presentation is applied to BOTH source and result panes; the user can disable it with the paired mirror checkbox. Video input defaults to original orientation in both panes. A display-only mirror cannot alter the matching coordinate convention.

The previous non-blank-output and throughput tests did not validate orientation. Their passing results were insufficient for this defect. The new suite adds a real-photo yaw check and paired presentation checks.

## 2. Reproduced paused-frame failure

The baseline probe reproduced **「目的フレームの描画待ちがタイムアウトしました」** for paused targets at 0 and 0.5 seconds. This is consistent with the user's partial recollection, but the user's exact original error text was not supplied and is not claimed confirmed.

The old path sought first and then waited for a future `requestVideoFrameCallback`. An already decoded paused frame, or another requested time within that same encoded frame, may not produce another presentation notification. The wait was therefore not a reliable condition for finishing a current-frame read.

`app/live/video-frame.ts` combines positioning and acquisition. It arms the callback before seeking, checks source identity, requested playback position, decoding readiness and dimensions, and obtains an actual decoded bitmap. When a paused frame is already available, two paint boundaries and explicit readback are used instead of requiring a nonexistent future callback. The position guard remains strict; a timeout is still an error, not successful completion. Cancellation releases listeners/callbacks and closes late bitmaps. The fixed-video screen consumes and closes the acquired snapshot before inference.

A 12-fps, three-color WebM was checked at `[0, 0, 0.04, 0.04, 0.5, 1.2, 2.2, 0.4, 2.999]` through a File-equivalent Blob URL. All **9/9** required captures returned the expected color, including initial, repeated, same-encoded-frame, backward and near-end cases. These coarse color segments are not a comprehensive per-frame timing benchmark for arbitrary moving footage.

### Intermediate test-transport failure

An intermediate cold HTTP-fixture check stalled at a seek to 0.04 seconds. We did not relax the application's playback-position guard to make that test pass. The real input screen uses user-selected Files via object URLs, so the required pixel checks were moved to a fully fetched Blob URL using the same WebM bytes, while raw HTTP behavior was recorded independently.

The separate HTTP probe observed status 200 for a Range request, `application/octet-stream`, and no Accept-Ranges/Content-Range headers. However, after buffering, native HTTP seeks to 0.04 and 1.2 seconds both succeeded. The exact cause of the earlier cold HTTP seek failure was not isolated; lack of range support is not asserted to be its sole cause. There is no evidence here that the browser normally quantizes `currentTime` to the encoded frame timestamp. The File-equivalent pixel assertions passed without weakening the requested-time check.

## 3. Camera recovery and honest diagnostics

The user's physical camera, OS permissions and hosted embedding policy were not accessible in this run. Their exact camera failure remains unconfirmed. The repair addresses testable failure modes and makes any remaining failure identifiable.

`app/live/media-input.ts` and the realtime client now provide:

- Secure-context/API/embedding-policy checks before capture, with a direct-Site link when embedded.
- Explicit camera selection. Optional capture constraints are relaxed only after an OverconstrainedError; permission denials are not silently retried, and a selected device is not silently replaced.
- Immediate cancellation, bounded permission/startup waits and cleanup of late camera grants.
- Input readiness only after play, decoded data and nonzero video dimensions, not merely a resolved permission request.
- A playback-clock fallback when the video plays but presentation callbacks do not arrive. The frame gate still rejects duplicates and keeps one frame in flight.
- A reusable canvas between video decoding and bitmap conversion, avoiding direct `createImageBitmap(video)` compatibility dependence for live input.
- Visible stages: preflight, camera-permission, video-start, model-start and running. Error codes distinguish camera denial/policy/absence/busy/startup, worker/model and stalled-frame failures.

Diagnostic JSON contains scalar state and errors, not captured images, the 55-dimensional face feature vector, or camera device IDs. Mirror controls, long camera labels and the revision marker have responsive sizing rather than an overflow-hiding workaround.

### Executed camera tests

A native Chromium virtual camera was used with actual MediaPipe inference and catalog images. The harness deliberately suppressed video-frame callbacks and made direct video-to-bitmap conversion throw, while leaving canvas bitmap conversion functional. The repaired screen produced output through `playback-clock`, made no direct video-bitmap calls, released every track on stop, and produced output after restart. Video-file input also continued to work under this injection.

Both panes were verified to use the same transform with mirror on and off. A native iframe `allow="camera 'none'"` restriction produced **CAMERA_POLICY_BLOCKED** and a visible 「サイトを別タブで開く」 link. Native permission denial produced **CAMERA_PERMISSION_DENIED** and left retry available. These are controlled compatibility/policy tests, not proof that any one injected failure was the user's physical-camera cause.

## Completed actual fixed-video screen verification

The actual `/live` file picker, analysis, path generation, image loading and output canvas were exercised with a five-second MP4 assembled from an existing public catalog photograph. The UI's playback, pause and one-frame step controls were also exercised.

| Analysis density | Planned | Face-detected | Sequence | Image failures | Canvas/gate |
| --- | ---: | ---: | ---: | ---: | --- |
| 12 fps | 60 | 60 | 60 | 0 | non-blank / PASS |
| 20 fps | 100 | 100 | 100 | 0 | non-blank / PASS |
| 30 fps | 150 | 150 | 150 | 0 | non-blank / PASS |

These values are analysis sampling densities, NOT realtime processing speeds. In the completed 5f0a0b1 run the processing durations were approximately 31.9, 46.3 and 65.6 seconds respectively. The fixture is not a held-out continuous-human-motion quality benchmark. The user's private IMG_3665.mp4 was not used or uploaded.

## Evidence

- [Baseline diagnostic run 35914477290](https://github.com/ugin-man/many-faces-beta/actions/runs/35914477290): original yaw mismatch and post-seek future-callback failures. Diagnostic commit 08d69452e3963f2e411c0cc6efebfa6bc5ec4a5a. [Artifact 10774332199](https://github.com/ugin-man/many-faces-beta/actions/runs/35914477290/artifacts/10774332199).
- [Completed specialized input run 35918143174](https://github.com/ugin-man/many-faces-beta/actions/runs/35918143174): commit 5f0a0b136f9d5a5898608f75aa3d4ad7849438b1; 13 input/source-guard tests, build, real-photo yaw, all nine File-equivalent pixel captures, camera API/policy injection, actual fixed-video 12/20/30-fps screen checks and source-integrity check succeeded. [Evidence artifact 10776022301](https://github.com/ugin-man/many-faces-beta/actions/runs/35918143174/artifacts/10776022301), 1,599,459 bytes, SHA-256 `1189b47ec215e0b3693f80926c0a7c49710f6597412b733891d0fe3e617693d4`.
- [Repository CI 35918680767](https://github.com/ugin-man/many-faces-beta/actions/runs/35918680767): commit 99548fe830adfa81d0dc6d01947684926ed2dd77; configured npm test, lint and Python-tool check succeeded.
- [Full-catalog realtime verification 35918676286](https://github.com/ugin-man/many-faces-beta/actions/runs/35918676286): same 99548fe8 revision; build, targeted tests, lint, real-browser camera lifecycle, **390x844 viewport**, resource profiling and source-integrity check succeeded. The preceding revision had revealed horizontal overflow; the last CSS-only change repaired it and this rerun passed.
- [Specialized input rerun on 99548fe8](https://github.com/ugin-man/many-faces-beta/actions/runs/35918676518) records the repeated input suite after the CSS-only change; consult its job result for that additional run rather than treating a queued job as passed.

All executed browser checks used GitHub Actions Chromium and the production Site runtime, not the user's already hosted Work Site or an actual iPhone/Safari. Passing lint is not a claim of zero pre-existing warnings. Earlier audit timings preceded the yaw correction and must not be used to claim that reversed-output matching was correct.

## Next user review

Rebuild the existing Site from `astra/realtime-hardening`, open `/live/astra` and confirm **INPUT RECOVERY V1**. Test camera selection/start and paired orientation; use `/live` for fixed-video analysis. If camera input still fails, retain the displayed error code or the 「診断データを保存」 JSON, which now identifies the failing stage.

Still open: the user's exact physical-camera failure, independent continuous head/blink/mouth matching fidelity, Safari/device coverage, long-session behavior and previously recorded publication/authorization risks. No claim of production completion or perfect pose/expression matching is made.
