# Many Faces realtime handoff — 2026-09-07 JST

## Canonical development target

- Repository: `ugin-man/many-faces-beta`
- Working branch: `astra/realtime-hardening`; draft PR #3 targets `work/coverage-driven-200k`.
- `/live/astra` is the realtime development route.
- `/live` remains the existing fixed-video reference.
- The canonical catalog is the existing full 70,000-face catalog. Do not create or use a reduced/portable catalog for development or user review.
- User review is expected through ChatGPT Work's Site capability against the repository/site project, not through a separately packaged lightweight local preview.
- No merge into `main` or `work/coverage-driven-200k`, and no hosted production deployment, has been performed.

## Realtime architecture now in the branch

The previous `/live/astra` wrapper was replaced by a continuous camera/video client and a dedicated classic Web Worker. The worker performs Face Landmarker inference and the existing pose/projection matcher. The UI thread handles controls, frame acquisition, decoded candidate images, and drawing.

A module-worker implementation built successfully but failed in real Chromium with `ModuleFactory not set`; the pinned MediaPipe WASM loader requires the tested classic-worker registration path.

At most one frame is in flight. Busy incoming frames are dropped rather than queued, and completed results older than 500 ms are not displayed. Input/inference have an 8-second runtime watchdog and engine startup has a 30-second deadline.

Camera startup is generation-scoped. A permission result arriving after stop or timeout releases every track. Stop/restart terminate old workers, abort requests, close bitmaps, stop media tracks, and revoke object URLs. Leaving the page stops capture rather than silently keeping the camera open.

Catalog reads are pinned to `source=seed`. The worker keeps a bounded pose-local working set while the underlying source remains the full 70,000-face catalog. It keeps at most 24 pose shards and 2,400 indexed candidates at once, with at most two shard loads concurrently. Output image decode/cache is bounded to 64 images / 32 MiB with up to three individual image requests. These are runtime working-set limits, not a reduced catalog.

Static faces are held rather than rotated merely to inflate output FPS. Ready fallbacks must remain within a score bound of the current best candidate. A persistently slow GPU path can be compared against CPU on the same real frame; CPU is selected only when materially faster without losing the detected face.

## Verification boundary

A successful GitHub Actions run on the full 70,000-face production catalog previously verified the continuous pipeline with Chromium's native `getUserMedia` backed by a file-based virtual camera. It covered non-blank output, actual candidate changes, camera stop/restart, delayed permission cancellation, permission denial recovery, a one-frame in-flight bound, decoded-image bounds, and a 390×844 viewport.

Those tests are useful pipeline/lifecycle evidence, but they are not a replacement for ChatGPT Work Site review, a physical camera, Safari/iPhone behavior, long-duration stability, or real continuous human motion/matching-quality evaluation.

The earlier compact/portable preview experiment is no longer part of the plan. Its generated artifacts may still exist in historical GitHub Actions runs until they expire, but no active workflow builds or publishes them now.

## Current CI policy

`.github/workflows/astra-realtime-hardening.yml` now has two purposes only:

1. build/test/lint the exact checked-out realtime source without modifying it;
2. run browser verification against the full 70,000-face catalog and retain evidence.

It no longer builds a 4,650-face subset, portable preview, local preview server, or downloadable lightweight package.

Two malformed historical one-time source-rewriting workflows are archived under `docs/archived-workflows/` and are not executable workflows on this branch.

## Next work

1. Use ChatGPT Work Site with `astra/realtime-hardening` and `/live/astra` as the immediate user-visible review path.
2. Improve full-70k responsiveness without shrinking the catalog: profile inference, candidate-index rebuilds, shard loading, image decode/cache churn, and rendering latency.
3. Evaluate actual continuous head movement, blink/mouth changes, matching fidelity, and responsiveness on the Site.
4. Test physical Windows/phone cameras, Safari, long sessions, low light, camera removal, tab background/return, and orientation changes.
5. Resolve remaining production warnings/permissions and only then decide promotion to the existing work branch and eventually `main`, with rollback preserved.

## Important interpretation

Do not quote compact-preview performance as project performance. The target is the full 70,000-face system. Runtime locality (loading only relevant pose shards/candidates at a moment) is an optimization of how the 70k catalog is accessed, not a reduction in the catalog itself.
