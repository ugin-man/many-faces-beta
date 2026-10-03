# Many Faces current handoff — 2026-10-04 JST

Read [VIDEO_SPEED.md](VIDEO_SPEED.md) and [VIDEO_SPEED_RESULT.json](VIDEO_SPEED_RESULT.json) first. The user confirmed their realtime camera works and asked to leave realtime alone. This pass changes only the recorded-video search worker and a scheduling/window-reference cache helper.

Repository `ugin-man/many-faces-beta`; canonical working branch `astra/realtime-hardening`; draft PR #3 targets `work/coverage-driven-200k`. The experiment was isolated on `astra/video-speed` before integration. No main/base merge or hosted Site rebuild was performed.

Measured application: `5440432d6521249a75c27cf41e8b53e6532aa1f7`. Final acceptance: `fc4202ba808ea53639be9ec2082cb4e903f9ac2d`, application source identical. Later test/documentation changes preserve build **`2d8e677c69df0ccf`**. Runtime version remains `camera-arrival-v3`; that old label alone does not distinguish the video optimization.

At the same 20 samples/second, the complete 23.3-second recording was tested in before/after/after/before order with fresh browsers. Mean file-selection-to-result time fell 153.391 to 120.243 seconds (21.61%); candidate loading/search fell 83.5008 to 48.91275 seconds. All four input/output hashes matched, and a separate same-input deep comparison matched every chosen ID and numeric error/sequence decision. Assets, matching conditions, frames and loaded bytes/files stayed equal. Build, 166 tests, lint, playback/frame stepping and actual pending-network cancellation passed the recorded acceptance checks. The first run's final cancellation test timed out; final acceptance verified identical source and completed that missing check without relabelling the original run. See the report for details.

Keep the fullscreen two-mode studio, all 70,000 photographs and entire 23.3-second reference. `/` and `/live` open video validation; `/live/astra` opens camera. No reduced catalog, alternate app or extra UI mode. Realtime, media input, CPU engine, frame acquisition, shared matching math and UI are unchanged by this pass.

Rebuild the EXISTING Work Site from the canonical branch, retaining host-specific source/settings. Git updates do not update the published Site. Check matching client/server/worker identities in diagnostics and `/api/runtime`; source-identical builds report `2d8e677c69df0ccf`. Hosted-Site speed, Safari and device performance were not measured here.

Remaining measured video bottlenecks: capture plus Face Mesh ~67 seconds, actual candidate ranking ~34 seconds, and ~417 MB of logical JSON response bodies. Do not weaken acquisition, density or matching to lower a timer.

Previous fixes: [CAMERA_ARRIVAL_RECOVERY.md](CAMERA_ARRIVAL_RECOVERY.md) (camera input now confirmed working by the user, not a new hardware test by this pass); [VERIFICATION_RECOVERY.md](VERIFICATION_RECOVERY.md) (false video timeout and progress-aware worker); [FULLSCREEN_UI_OVERHAUL.md](FULLSCREEN_UI_OVERHAUL.md) (current UI); [ASTRA_INPUT_RECOVERY.md](ASTRA_INPUT_RECOVERY.md) (yaw/capture). Older audit rates are historical, and fine perceptual expression fidelity remains unresolved.
