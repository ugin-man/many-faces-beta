# Video frame acquisition speed — 2026-10-05 JST

## Scope and exact source

The user confirmed camera input works and requested video-only performance work with unchanged sampling, resolution and matching results. This pass changes only `app/live/video-frame.ts` in the application. Realtime, camera arrival/lifecycle, CPU model, video UI, candidate search/ranking, sequence policy and all original public assets remain unchanged.

Baseline: `8f075841995d20710ea72300b980b8d125659235` (previous video-search optimization).
Application change: `e9413d40509f29097082eadb4a7bfd331213e71f`.
Completed verification commit: `2ec6cb2de59359a4870e9789c72b62735d566345`. Intervening commits change only the test workflow, not application source.
Application build: **`b8a1eac4ff107b2c`**. The version text remains `camera-arrival-v3`; use the build fingerprint, not that label alone.

The experiment was isolated on `astra/video-capture-speed` before integration into `astra/realtime-hardening` / draft PR #3. No main/base merge or hosted Work Site rebuild was performed.

## Change and preserved safeguards

The previous acquisition helper waited for a presentation callback or a 100 ms grace timer after a paused frame was already positioned. This speculative future-notification wait was followed by two paint boundaries and a decoded bitmap readback anyway. A repeated or already paused frame need not produce another presentation callback.

The helper no longer waits on that extra callback/timer race. It still arms the callback before seeking as supplementary evidence. It retains both paint boundaries, paused/ready/dimension/position/source checks, decoded bitmap acquisition, post-acquisition validation, single-flight enforcement, cancellation and late-bitmap cleanup, and the original 8-second error deadline. Neither a seek notification nor a timeout is treated as successful acquisition. The return value adds position/paint/bitmap/total timing measurements.

This is not a new codec/demuxer, a resolution reduction or a frame-dropping shortcut. WebCodecs and strict-only ranking are not implemented by this pass.

## Full application comparison

[Run 37215745487](https://github.com/ugin-man/many-faces-beta/actions/runs/37215745487) completed every step successfully. The actual production UI processed the complete existing 23.3-second reference at 20 samples/second. Order was before/after/after/before, with a fresh Chromium process/profile each trial, the same runner and local servers. There was no mocked inference or substituted matching output.

| Order | Version | File selection to report (s) | Frame acquisition + Face Mesh (s) | Candidate loading + search (s) |
| --- | --- | ---: | ---: | ---: |
| 1 | Before | 114.669 | 63.5608 | 47.2135 |
| 2 | After | 97.995 | 46.6139 | 47.4838 |
| 3 | After | 98.076 | 46.7055 | 47.5589 |
| 4 | Before | 116.357 | 65.1507 | 47.3181 |
| Mean | Before | 115.513 | 64.35575 | 47.2658 |
| Mean | After | 98.0355 | 46.6597 | 47.52135 |

Mean end-to-end wait fell **17.4775 seconds (15.1303%)**; the acquisition/Face Mesh phase fell **27.4972%**. Search was essentially unchanged, slightly slower in this comparison. Sequence optimization was 2.26415/2.23545 seconds and selected-image preload 0.93105/0.8953 seconds. Phase timers exclude some boundary overhead.

The baseline was measured again in this run, not copied from the earlier 120.243-second result. Do not compare timings from different runners as if they were a controlled before/after pair. This is preprocessing wall time, not playback FPS, hosted-Site speed or a device guarantee.

All four runs sampled 466 positions, detected faces in 410, returned 410 sequence items, selected 141 distinct photographs and made 153 identity changes. Image failures were zero and the output canvas was nonblank. All four acquired-descriptor hashes match, and all four hashes of every selected ID, timestamp, numeric error, emission, acceptance flag and expression-motion decision match. Candidate math was not changed. Detection coverage remains 87.9828%, not 100%.

Input descriptor SHA-256: `e14e8727696fc54a4be92a380436722d6a60b5d2f07632235f1cb412c2dd4fc1`.
Output decision SHA-256: `f414f310cfa7b7619f1c53433b42f1bfd75790646d7093ae3c2bab0762fd3fb1`.
Sequence fingerprint: `e91d5bf5`.

Every run still read 417,215,798 logical JSON body bytes, 722 shards and 67,131 candidate records. These are not compressed on-wire bytes; transfer-volume reduction is not claimed.

## Separate acquisition-versus-inference diagnostic

A separate browser probe imported the two unedited acquisition implementations and the same CPU IMAGE engine. It acquired all 466 reference positions at the original 512x910 resolution, copied each to a canvas, ran inference and hashed full RGBA pixels plus face descriptors. Model startup and pixel hashing are outside the per-operation timers below.

| Probe component | Before (s) | After (s) |
| --- | ---: | ---: |
| Frame acquisition | 65.4525 | 32.0653 |
| Actual Face Landmarker inference | 12.6056 | 12.5183 |
| Bitmap-to-canvas copy | 0.4391 | 0.4304 |

This sequential probe creates a canvas per sample and performs extra readbacks/hashing. It changes task/presentation scheduling relative to the application and is **not** the headline benchmark or an additive decomposition of the application phase. Its before/after acquisition savings must not be substituted for the 17.4775-second end-to-end result.

Within the new helper, summed probe timings were position/seek 21.4108 seconds, two paint boundaries 9.3182 seconds and bitmap acquisition 1.3239 seconds. These are useful profiling clues for the next iteration, not evidence that the preserved barriers can safely be removed. Actual inference time remained nearly unchanged; a substantial part of this pipeline is acquisition/scheduling, not model computation.

All 466 pixel hashes and descriptor hashes matched at identical requested times and dimensions, including the 56 positions without detected faces. Thus this test did not obtain speed by substituting old/blank frames or silently skipping positions.

## Acquisition and UI failure gates

The known-color VP8 fixture checks decoded pixels, not merely seek events. Six cases cover 12/20/30-fps sampling, each with normal and absent presentation callbacks, for 432 acquisitions total. They include time zero, duplicate and within-encoded-frame samples, backward seeks and the final frame. Every expected color check passed.

Invalid time, pre-cancelled input, concurrent capture rejection, cancellation during acquisition, retry after cancellation, a genuine no-current-frame decoder stall and retry after that timeout all passed. The stalled-decoder unit stimulus supplies a short test-only deadline; the production default remains 8 seconds.

The actual application also passed playback/pause/frame stepping. In a separate UI cancellation check, the full reference reached four blocked shard requests; Cancel returned to idle in 39 ms without a false success, late restart or uncaught page errors.

Build, **168 unit tests (zero failures/skips)** and lint passed. Lint has zero errors and 13 existing warnings, not a warning-free claim. Protected-source diff and original catalog tree checks passed. No camera-source change was made; this pass is not a new physical-camera or Safari certification.

## Evidence and unchanged original assets

Artifact `video-capture-speed-37215745487`, ID **11308566585**, 117,337 bytes. SHA-256: `1381744445f169040d19463fc6036d021e9f353ad3df884bef44a760129db0b6`.
The ZIP was downloaded, its SHA-256 and ZIP integrity verified, and the JSON receipts and build/unit/lint logs inspected. It contains per-trial timings, per-frame pixel/descriptor hashes, cancellation and runtime identities. No screenshot inspection is claimed.

Catalog Git tree: `559f7f39e3a8eed452ef7eb6a3355a318235c307` (unchanged all-70k asset tree).
Reference MP4 SHA-256: `d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b` (unchanged full 23.3 seconds).

Earlier setup attempts remain failed: run 37215187600 generated its QA page after production public-asset copying, so the page never loaded; run 37215505504 generated the probe before copying but lint then inspected bundled third-party code. The final workflow lints tracked source before probe generation, then generates the QA assets before building. Application source was unchanged across these test-order fixes. No failed assertion was removed to obtain acceptance.

## Handoff and remaining work

Rebuild the EXISTING Work Site from the canonical branch while retaining its host-specific settings/changes. Rebuild client/server/workers together and check their identities in diagnostics and `/api/runtime`. Source-identical builds report `b8a1eac4ff107b2c`; host-specific source changes can change the fingerprint. Git changes do not automatically update a deployed Site or old ZIP.

Keep the realtime path, fullscreen two-mode UI, 70k photographs and complete reference. Perceptual expression fidelity is not improved or certified by this speed-only pass. Browser/codec support beyond the tested Chromium H.264 reference and VP8 fixture, Safari, hosted performance and long sessions remain unverified.

Candidate ranking still costs about 33 seconds within the unchanged roughly 47.5-second search phase; eliminating unused ranking modes is a separate next change. Sequential decoder access is also a future experiment, not part of this patch. Preserve output equality and the current acquisition fallback/guards when evaluating either.
