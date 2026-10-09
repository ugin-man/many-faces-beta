# Many Faces current handoff — 2026-10-05 JST

Read [WINK_SUPPORT.md](WINK_SUPPORT.md) and [WINK_SUPPORT_RESULT.json](WINK_SUPPORT_RESULT.json) first. The user confirmed the camera milestone and subsequently requested targeted dataset reinforcement for winks. The current change is recorded-video wink support, not realtime tuning or another identical-output speed optimization.

Repository: `ugin-man/many-faces-beta`. Canonical development branch: `astra/realtime-hardening`. Draft PR #3 targets `work/coverage-driven-200k`; no base/main merge. The experiment was tested on `astra/wink-coverage` before integration.

Verified application: **`149200d521f04ab96300ad0f9902dc721dfe46c0`**, build **`9902e78e96670c77`**. Subsequent documentation-only commits preserve application source. The version text `camera-arrival-v3` alone does not identify the new data/worker behavior.

## Original assets preserved; supplement added

The complete original 70,000-photo catalog and original descriptors are byte-identical, subtree `559f7f39e3a8eed452ef7eb6a3355a318235c307`. The 23.3-second reference and current two-mode fullscreen UI are retained.

A supplementary index reuses 271 original photographs with fresh descriptors from their exact encoded pixels, plus six separately attributed real photographs. It contains 277 records (151 left / 126 right), but only SIX photos are new: 70,006 photos in total, not 70,277. Original files are not overwritten. Fresh inference covered 562 screened original candidates, not the entire 70k corpus. The source/licence page is available through the existing video's diagnostics sheet.

The video worker loads `public/wink-support/v1/catalog.json` only when the source has corroborated asymmetric action/eyelid evidence. It ranks same-side, pose-compatible photographs with the unchanged detailed scorer. Ambiguous/ordinary/no-compatible frames retain the original matcher. Missing optional data records a failure and falls back rather than breaking video processing.

This is an explicit eye-state-priority policy. It improves automatic same-side consistency in the selected tests but increases some mouth/pose/overall errors. Do not describe it as uniformly improved facial similarity or a 100% wink detector. The unchanged sequence optimizer can propagate changes to neighboring final choices.

## Executed verification

Run **37227084067** on exact application149200d passed build, all **180 tests (zero failures/skips)**, lint, actual full-reference UI processing, playback/pause/frame stepping, credit availability, source/worker/server identity, missing-index recovery and cancellation with four real pending requests. Original camera/input/acquisition/model/scorer/reference assets passed protected-diff checks. No application rewriting in CI.

Thirty selected source-photo-held-out queries improved from 4/30 to 30/30 same-anatomical-eye outputs under automatic fresh-pixel reanalysis; this is not person-disjoint or human-labelled evaluation. In the actual reference recording, 16 detected-positive frames had 16 same-side outputs. In a separate 120-frame video built from six still photos, with all six query photos excluded from the support index, the source gate activated on 100 frames and those 100 outputs retained the eye side. Twenty frames did not activate support. The test is not continuous human motion.

Read the report's measured mouth/pose tradeoffs and unresolved false-positive/sensitivity limits before promoting. Logs were read; no supplemental-crop visual approval, local archive hash or screenshot inspection is claimed.

## Existing Work Site

Rebuild the EXISTING Site from the canonical branch, retaining host-specific changes/settings. Include **code AND all `public/wink-support/v1/` assets**. Keep the original full catalog and video/camera entries (`/`, `/live`, `/live/astra`); do not create a reduced catalog, separate app or third UI mode.

Rebuild server/client/workers together and check matching build IDs in diagnostics and `/api/runtime`. Source-identical builds report **9902e78e96670c77**; host-specific source changes may legitimately alter the fingerprint but components must agree. Git updates do not update a published Site or an older ZIP. **No hosted Site rebuild/deployment has been performed here.**

The working camera source remains unchanged and DOES NOT consume the new wink index in this pass. Physical-camera wink fidelity, Safari, long sessions, independent expression labels, visual whole-face similarity and temporal false activation remain unverified.

## Historical speed work

[VIDEO_RANK_SPEED.md](VIDEO_RANK_SPEED.md), [VIDEO_CAPTURE_SPEED.md](VIDEO_CAPTURE_SPEED.md) and [VIDEO_SPEED.md](VIDEO_SPEED.md) document prior result-identical speedups, retained in the current code. Their output-equality statements and timings apply to those historical experiments; current wink policy intentionally changes the video result. Current single before/after UI observations are not a new ABBA speed benchmark.

Camera/input recovery and UI evidence remain in [CAMERA_ARRIVAL_RECOVERY.md](CAMERA_ARRIVAL_RECOVERY.md), [VERIFICATION_RECOVERY.md](VERIFICATION_RECOVERY.md) and [FULLSCREEN_UI_OVERHAUL.md](FULLSCREEN_UI_OVERHAUL.md).
