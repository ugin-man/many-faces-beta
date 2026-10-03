# Many Faces current handoff — 2026-10-04 JST

Read [VERIFICATION_RECOVERY.md](VERIFICATION_RECOVERY.md) first. Machine-readable receipt: [VERIFICATION_RECOVERY_RESULT.json](VERIFICATION_RECOVERY_RESULT.json).

Repository `ugin-man/many-faces-beta`, branch `astra/realtime-hardening`, draft PR #3 targeting `work/coverage-driven-200k`. No base/main merge or hosted Site deployment was performed.

Tested application commit: `c1d5faa883f139beb9c51d41402cf87c87e76e2d`. Source-content build ID `3268c1736ea0d3fd`, version `verification-recovery-v2`. Later documentation-only commits do not change this application fingerprint.

Keep the existing full-screen two-mode studio, all 70,000 photographs and the entire 23.3-second fixed recording. `/` and `/live` open video validation, `/live/astra` opens camera. Do not create a smaller catalog, alternate app or extra UI modes. Rebuild the EXISTING Work Site from this branch. Verify the client/server/worker identity under Settings > Image information / diagnostics; the new `/api/runtime` endpoint must return the same build. The previously used hosted URL returned 404 for this endpoint and was not redeployed here.

## Latest repair

The original false 90-second video timeout was reproduced using a real slow HTTP body. Video search now runs in a cancellable worker and emits real byte/file/decode/frame progress without reducing its pose window. The UI's liveness clock advances on those events, not only on a completed matched frame. Stalled streams, invalid responses and cancellation have explicit bounded handling.

Camera startup now downloads and initializes one CPU model with progress, performs the first actual inference during preparation, and only then starts the live frame watchdog. Mid-frame GPU-to-CPU probing was removed. The 8-second live-frame watchdog remains; unrelated background progress does not mask a hung inference. This fixes testable startup coupling, but the user's precise physical-camera cause remains unconfirmed.

All six recorded workflows completed successfully, including real slow-body old/new comparison, 156 unit tests, full-recording playback, native virtual-camera lifecycle, input regressions and adversarial audit. These are not a hosted-deployment, physical-camera, Safari, sustained-performance or perceptual-fidelity certification. Initial detailed-JSON loading remains large.

## Historical context

[FULLSCREEN_UI_OVERHAUL.md](FULLSCREEN_UI_OVERHAUL.md) documents the interface reconstruction. Its old `fullscreen-v1` runtime identity and GPU-probe description are superseded by this recovery. [ASTRA_INPUT_RECOVERY.md](ASTRA_INPUT_RECOVERY.md) records the earlier yaw and decoded-frame fixes. [ASTRA_RESOURCE_AUDIT.md](ASTRA_RESOURCE_AUDIT.md) and [ASTRA_ADVERSARIAL_AUDIT.md](ASTRA_ADVERSARIAL_AUDIT.md) contain historical benchmarks, not current speed guarantees.
