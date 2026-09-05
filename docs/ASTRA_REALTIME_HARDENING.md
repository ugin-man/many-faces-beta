# Many Faces realtime handoff — 2026-09-06 JST

## Current entry points

- Repository: `ugin-man/many-faces-beta`
- Working branch: `astra/realtime-hardening`; draft PR #3 targets `work/coverage-driven-200k`.
- Latest browser-tested application commit: `33e3ba843fc8e9ced7be2d3e836454112e99cd28`.
- `/live/astra`: new continuous camera/video preview with worker-based inference.
- `/live`: existing five-second fixed-video reference, not replaced by the realtime implementation.
- No merge into `main` or `work/coverage-driven-200k`, and no hosted deployment, was performed.

## What changed

The previous `/live/astra` wrapper has been replaced by a working client and dedicated classic Web Worker. The worker performs Face Landmarker inference and the existing pose/projection matcher. The UI thread handles controls, frame acquisition, decoded output images, and drawing.

A module-worker implementation built successfully but failed in a real Chromium browser with `ModuleFactory not set`. The pinned MediaPipe WASM loader needs its classic-worker registration path. Both the production build and portable build now use the tested classic-worker path.

At most one frame is in flight. Busy incoming frames are dropped instead of queued; completed results older than 500 ms are not displayed. The UI remains able to stop a stuck worker. Input and inference have an 8-second runtime watchdog; engine initialization has a 30-second deadline.

Camera startup is generation-scoped. A permission result arriving after stop or timeout immediately releases every track. Stop and restart terminate old workers, abort requests, close bitmaps, stop media tracks, and revoke object URLs. Leaving the page stops capture instead of silently keeping the camera open. Physical-device unplug/background/rotation compatibility still needs real-device verification.

Catalog reads are pinned to `source=seed`. The worker keeps at most 24 pose shards and 2,400 indexed candidates. It loads at most two shards concurrently. Output uses up to three concurrent individual image requests, an eight-candidate latest queue, a 64-image / 32 MiB decoded-image budget, bounded response reads, decode deadlines, and cleanup of late bitmaps. These are component budgets, not a claim that the entire browser uses only 32 MiB.

Static faces are held rather than rotated to inflate output FPS. Ready fallbacks must remain within a score bound of the current best candidate. The realtime search uses a bounded approximate candidate path, not a claim of the same matching quality as the expensive full-video sequence optimizer.

A successfully created GPU engine can still be slow. After four persistently slow samples, the worker benchmarks a CPU engine on the same actual frame and switches only if it is at least 20% faster without losing a detected face. CPU-probe failure leaves the working engine intact.

The dedicated CI now validates the exact source commit without rewriting or pushing application code. Two malformed historical one-time patch workflows were moved byte-for-byte into `docs/archived-workflows/`.

## Executed verification

Run: https://github.com/ugin-man/many-faces-beta/actions/runs/33986973937

Install, production build, scoped unit tests, lint, production browser verification, portable browser verification, packaging, and the final no-source-rewrite check all passed.

The browser tests use native `getUserMedia` backed by a Chromium virtual camera. Its stimulus is three changing, existing public catalog photographs, not the user's private video, not mocked landmarks, and not a physical camera. This is a pipeline/lifecycle test, not a human-motion matching-quality benchmark.

Both full-catalog production and the exact portable preview passed:

- Native camera start and non-blank output.
- Actual output changes when the input changes.
- Stop releases every media track.
- Restart produces new output.
- A delayed permission grant does not resurrect a cancelled session or leak tracks.
- Permission denial produces a recoverable error and re-enables the start button.
- One-frame in-flight bound and decoded-image memory/concurrency bounds.
- 390×844 viewport output without horizontal overflow. This is Chromium at a mobile-sized viewport, not iPhone Safari testing.

### Recorded desktop snapshots

These are the test's final one-second rate snapshots, not sustained benchmark guarantees.

| Metric | Full production catalog | Portable preview |
| --- | ---: | ---: |
| Catalog faces | 70,000 | 4,650 |
| Processed / detected face frames | 57 / 57 | 140 / 140 |
| Total actual output changes | 25 | 36 |
| Detection rate at snapshot | 7 fps | 18 fps |
| Output changes at snapshot | 3/s | 6/s |
| Frame acquisition to draw, P95 | 330 ms | 205 ms |
| Latest inference duration | 32 ms | 23 ms |
| Latest candidate search | 2 ms | 3 ms |
| Decoded image memory | 16 MiB | 16 MiB |
| Image failures | 0 | 0 |
| Maximum frames in flight | 1 | 1 |
| Runtime delegate after measurement | CPU | CPU |

The latency includes frame acquisition to a displayed candidate; it does not include physical sensor exposure and is not a camera-to-photon measurement. Initial model startup is outside the `firstOutputMs` timer. Discarded stale frames are not counted as displayed results.

## User preview

Download: https://github.com/ugin-man/many-faces-beta/actions/runs/33986973937/artifacts/9975484787

Artifact: `Many-Faces-Realtime-Preview`, 58,450,154 bytes. SHA-256 of the ZIP: `92777ce8abdeea5cba5dd321b1d80e40aca7ba07b9f64b018a1a4ec09332767c`.

This is a local PC preview, not an already hosted website. It includes the model, WASM, application, server, evidence, and a 4,650-photo subset spanning 775 pose cells. The full 70,000-photo catalog remains unchanged in Git. The preview deliberately has fewer choices, so its matching quality must not be presented as full-catalog quality.

Windows: install/use Node.js 22 or newer, extract the ZIP, and open `START-WINDOWS.cmd`. Open the camera and allow access. The local address is `http://127.0.0.1:4173/live/astra`. The server binds only to loopback and uses Node built-ins; no npm install is needed for this portable package. Stop the terminal process to close the local server.

Use the live controls to start, stop, and restart. The diagnostic panel distinguishes inference rate from actual output changes. Input imagery is analyzed locally and is not sent to a server. The user's `IMG_3665.mp4` was not used or uploaded in this run.

Screenshots and raw JSON reports are included under `verification/production` and `verification/portable` in the preview. Evidence-only artifact: https://github.com/ugin-man/many-faces-beta/actions/runs/33986973937/artifacts/9975485062

## Remaining release gates

1. Full-catalog responsiveness and quality: improve the full 70k path beyond the observed 7 fps, profile candidate-index rebuild/loading overhead, and evaluate real continuous head motion, blinking, mouth motion, matching fidelity, and end-to-end latency. The portable 18 fps result does not close this gate.
2. Real-device and duration coverage: actual Windows/phone cameras, Safari, long sessions and memory stability, low light, camera removal, real tab background/return, and orientation changes. The current virtual-camera runs are short functional tests.
3. Publication: review remaining upload authorization and historical workflow behavior, correct the production WASM MIME warning, verify fixed-video fallback using the private fixture locally, package the agreed full/compact configuration, and only then promote/deploy with rollback. No public production-readiness claim or main-branch merge yet.

Known warnings: the production asset path logs a WASM MIME mismatch and falls back to ArrayBuffer instantiation; the portable run logs a missing-resource 404 plus MediaPipe informational messages. Browser runtime gates passed despite these, but the logs are not claimed to be error-free.
