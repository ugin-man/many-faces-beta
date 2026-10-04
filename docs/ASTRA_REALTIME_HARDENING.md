# Many Faces current handoff — 2026-10-05 JST

Read [VIDEO_CAPTURE_SPEED.md](VIDEO_CAPTURE_SPEED.md) and [VIDEO_CAPTURE_SPEED_RESULT.json](VIDEO_CAPTURE_SPEED_RESULT.json) first. The user confirmed camera input works and requested video-only performance work. This pass changes only `app/live/video-frame.ts` in application code, preserving the original result and all assets on the tested recording.

Repository `ugin-man/many-faces-beta`; canonical working branch `astra/realtime-hardening`; draft PR #3 targets `work/coverage-driven-200k`. The capture experiment was isolated on `astra/video-capture-speed` before integration. No main/base merge or hosted Site rebuild was performed.

Application change: `e9413d40509f29097082eadb4a7bfd331213e71f`. Verified commit: `2ec6cb2de59359a4870e9789c72b62735d566345`, identical application source. Later documentation changes preserve build **`b8a1eac4ff107b2c`**. Runtime version text remains `camera-arrival-v3`; that label alone does not identify the latest video optimization.

The helper removes a speculative 100 ms presentation-notification wait, not decoded-frame validation. It retains two paint boundaries, position/source/data checks, bitmap validation and the 8-second error deadline, cancellation, cleanup and single-flight enforcement. No resolution, sampling, matching, model, UI or realtime change.

The complete 23.3-second recording at 20 samples/second was processed in before/after/after/before order with fresh browsers. Mean file-selection-to-result time fell **115.513 to 98.0355 seconds (15.13%)**; the frame-acquisition/Face Mesh phase fell **64.35575 to 46.6597 seconds**. All four input-descriptor and output-decision hashes match. A separate diagnostic verified full-resolution decoded pixels and descriptors at all 466 positions. The 432 known-color acquisitions, cancellation/true-stall/retry gates and UI playback/frame stepping passed. The completed run 37215745487 also passed build, all 168 tests with no skips/failures, lint with zero errors/13 existing warnings, and protected-source/asset checks. Do not substitute separately instrumented component timings for the application benchmark.

Keep the fullscreen two-mode studio, all 70,000 photographs and entire 23.3-second reference. `/` and `/live` open recorded-video validation; `/live/astra` opens camera. No reduced catalog, alternate app or extra mode. The camera's existing arrival fix is preserved, not reimplemented or performance-tuned.

Rebuild the EXISTING Work Site from the canonical branch, retaining host-specific source/settings. Git updates do not change the deployed Site. Rebuild client/server/workers together and check matching identities in diagnostics and `/api/runtime`; source-identical builds report `b8a1eac4ff107b2c`. A host-specific source modification may legitimately change that fingerprint, but its components must still agree.

Recorded-video search remains about 47.5 seconds, including about 33 seconds of ranking, and still consumes ~417 MB of logical JSON bodies. Strict-only ranking and sequential decoder access are future separate experiments. Perceptual expression quality, hosted speed, Safari and long sessions are not certified by these tests.

Historical evidence: [VIDEO_SPEED.md](VIDEO_SPEED.md) (previous search/window-cache optimization); [CAMERA_ARRIVAL_RECOVERY.md](CAMERA_ARRIVAL_RECOVERY.md) (camera fix subsequently confirmed by the user); [VERIFICATION_RECOVERY.md](VERIFICATION_RECOVERY.md) (false video timeout and progress-aware worker); [FULLSCREEN_UI_OVERHAUL.md](FULLSCREEN_UI_OVERHAUL.md) (current UI); [ASTRA_INPUT_RECOVERY.md](ASTRA_INPUT_RECOVERY.md) (yaw/capture). Older timings are not current device guarantees.
