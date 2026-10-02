# Many Faces current handoff — 2026-10-03 JST

## Canonical target

Repository: `ugin-man/many-faces-beta`. Branch: `astra/realtime-hardening`. Draft PR #3 targets `work/coverage-driven-200k`. No base/main merge or hosted Site deployment was performed.

Keep the unchanged full 70,000-image catalog. Rebuild the EXISTING ChatGPT Work Site from this branch; do not create a reduced catalog or alternate portable app.

## Current application: fullscreen two-mode studio

Read [FULLSCREEN_UI_OVERHAUL.md](FULLSCREEN_UI_OVERHAUL.md) first. It supersedes the old three-tab layout and visible INPUT RECOVERY V1 marker. The root `/` and `/live` open video verification; `/live/astra` opens realtime. Both share a viewport-filling result canvas with a small top-right input preview. Controls are buttons; diagnostics and configuration are in a settings sheet. Only video verification and realtime are active modes.

The fixed-recording button retains the entire existing 23.3-second reference video. The active studio reanalyzes it with the current matcher; the old reference analysis/ranking files remain unchanged but are not silently reused. All 70k catalog assets remain unchanged.

Current application commit: `11312d2a83d2574d1c400a141fa6f7e8dc2f1147`. Test-only commits 19874826 and e9e5c29c have identical application source. Completed checks and inspected screenshots are documented in FULLSCREEN_UI_OVERHAUL.md. Current diagnostic build is `fullscreen-v1` / `Fullscreen UI v1`, under Settings > Image information / diagnostics.

Git updates do not automatically update an old ZIP or an already built Site. No hosted deployment was made. Full-catalog native virtual-camera testing is not a claim that the user's physical camera or hosted iframe has been verified.

## Retained engine and matching corrections

Realtime remains a classic MediaPipe worker with one in-flight frame, stale-result rejection, bounded shard/image caches and generation-scoped lifecycle cleanup. Stop, back/swipe and mode changes release camera tracks and engine resources. Video retains the atomic decoded-frame acquisition fix and cancellation checks.

Both modes now use absolute catalog-compatible pose/actions without source-only startup expression subtraction or a relative pitch origin. Video sequence matching may keep a better repeated identity rather than force a worse different face. Fine expression fidelity and source-image resolution remain unresolved quality limits; functional test success does not establish perceptual acceptance.

## Historical evidence

[ASTRA_INPUT_RECOVERY.md](ASTRA_INPUT_RECOVERY.md) documents the earlier yaw-sign and paused-frame failure reproduction and repair. Its old UI screenshots/version marker and statements about which stimulus was used apply to that historical pass, not the current full-recording test.

[ASTRA_RESOURCE_AUDIT.md](ASTRA_RESOURCE_AUDIT.md) and [ASTRA_ADVERSARIAL_AUDIT.md](ASTRA_ADVERSARIAL_AUDIT.md) contain older resource comparisons. Do not present historical rates as current improvement measurements.

Before production publication: review physical cameras/Safari/long sessions, fine head/eye/mouth fidelity, startup MIME warnings and catalog-write authorization. Promotion to base/main is a separate decision.
