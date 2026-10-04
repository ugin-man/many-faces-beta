# Video-only ranking speed — 2026-10-05 JST

## Scope and source identity

Baseline: `03488140287d51af994417b7a4d613ac388ca46f`, application build `b8a1eac4ff107b2c`.
Measured and verified application: `518e5b23b17fd721e4e0243c2785096a7c8f0b25`, build **`c5317177db4f044f`**.
The experiment uses `astra/video-rank-speed` before integration into canonical `astra/realtime-hardening` / draft PR #3. Subsequent documentation-only commits preserve application source and its build fingerprint.

Only two application files changed: `app/live/review-search.worker.ts` and new `app/live/review-strict-ranker.ts`. Camera code, arrival detection, timeouts, the CPU model, sampling/resolution, video acquisition, the UI, the original matching module and sequence policy remain unchanged. All original public assets, including the complete 70,000-photo catalog and 23.3-second recording, remain unchanged. No base/main merge, hosted Site deployment or alternate app was made.

## Implemented changes

The video worker uses a strict-only ranking specialization rather than constructing all six sorted output lists and discarding five. All detailed numeric errors still come from the unchanged shared `projectionError`; this does not remove error fields, change weights, simplify scoring or turn sequence optimization into independent top-1 selection.

The coarse pass computes the source mouth-shape descriptor once per query, reuses candidate descriptors by their immutable projection-object identity, and compiles the unchanged mouth-action weight table once. Candidate descriptors remain ordinary JavaScript numbers, with the original arithmetic and accumulation order. They are not quantized/downcast or approximated. Weak keys cannot retain discarded projection objects; caches are scoped to one search worker and explicitly cleared. This is not a cache of old input-video analysis or selected-image results.

Candidate admission order, shape/pitch/mouth/wink specialists, stable ties, duplicate-ID replacement, result limits and the existing sequence optimizer are preserved. A candidate window still uses the same pose bounds, expansion rules, request concurrency and reference cache. The new specialization intentionally shares the public shape helper and detailed scoring function but mirrors a small private coarse-weight table; future changes to the original ranker must run the independent equality checks, not silently allow the specialization to drift.

## Completed verification

[Workflow 37222658011](https://github.com/ugin-man/many-faces-beta/actions/runs/37222658011) completed successfully for the exact application commit. Build, **173 tests (zero failed/skipped)**, lint, full-catalog ranking audit, browser comparison, playback operations, pending-request cancellation and protected-source/asset checks passed. The workflow has read-only repository permissions and does not rewrite application source. Lint's warning count was not separately summarized in this pass; success is not a warning-free claim.

The new unit cases cover the detailed-stage boundary, different limits, both wink directions, mouth actions/pitch, stable ties, duplicate IDs with different geometry, number/Float32 projections, cache reuse/clear and non-mutation. The unchanged six-mode implementation is the oracle.

The independent catalog audit loads **all 775 shards / 70,000 valid unique records**. Across **24 queries**, including perturbed source poses, each new top-64 list and every numeric error exactly match the old implementation with the entire catalog available as candidates. This audit is not a claim that the production pose-local path exhaustively searches all 70,000 photos per frame. Warm in-memory component timings for eight queries, in before/after/after/before order, were 3950.390 / 3342.803 / 3423.761 / 4032.309 ms. They are separate from end-to-end browser timing.

## Actual full-recording ABBA comparison

Both exact source versions were built on the same runner and served locally. Each trial used a fresh Chromium process/profile and the unchanged full 23.3-second reference at **20 samples/second**. Acquisition and the CPU inference engine were unchanged.

| Order | Version | File selection to report (s) | Loading/search (s) | Ranking inside search (s) |
| --- | --- | ---: | ---: | ---: |
| 1 | Before | 99.594 | 48.0297 | 33.5416 |
| 2 | After | 94.029 | 43.2082 | 28.6544 |
| 3 | After | 92.894 | 42.7535 | 28.5858 |
| 4 | Before | 97.508 | 47.1087 | 33.0638 |
| Mean | Before | **98.551** | **47.5692** | **33.3027** |
| Mean | After | **93.4615** | **42.98085** | **28.6201** |

End-to-end wait decreased **5.0895 seconds / 5.1643%**. Ranking decreased **14.0607%**. This is a modest improvement, not a several-fold application speedup. The combined frame-acquisition/Face Mesh phase was 46.98355 s before and 46.6961 s after; no acquisition/inference improvement is attributed to this change. Sequence optimization was 2.23855/2.2571 s and image preload 0.88115/0.8242 s. Ranking is contained in loading/search and must not be added to it.

The new ranker made 4,156,689 coarse candidate comparisons and 428,835 detailed comparisons per video run. Within the coarse descriptor cache, 67,131 candidate mouth descriptors were computed and 4,089,558 subsequent accesses reused them. These counters do not imply that all detailed mouth calculations disappeared. The contribution of strict-only sorting versus descriptor preparation was not measured in isolated ablations.

## Exact output, unchanged work coverage

All four acquired-descriptor hashes match, and deep comparison of the complete selected IDs, times, numeric error fields, emissions, acceptance flags and expression-motion decisions passes. Every run sampled 466 positions, detected/returned 410 face frames, selected 141 unique images, made 153 identity changes, loaded images without failure and produced nonblank output. Detection coverage remains 87.9828%, not 100%.

A separate replay sends the EXACT same acquired frame arrays through both unmodified compiled search workers. Every output field equals both the other replay and the four UI outputs. Replay loading/search times were 46.0387/41.5724 s; shared-origin sequential replay is an equality test, not the cold-profile headline benchmark. Peak candidate count remained 15,488.

Input hash: `e14e8727696fc54a4be92a380436722d6a60b5d2f07632235f1cb412c2dd4fc1`.
Output decision hash: `f414f310cfa7b7619f1c53433b42f1bfd75790646d7093ae3c2bab0762fd3fb1`.
Sequence fingerprint: `e91d5bf5`.
Every UI trial and replay still read **417,215,798 logical JSON-body bytes**, **722 shards**, and **67,131 decoded candidates**. These are not compressed wire bytes. No network-volume reduction is claimed.

Actual UI playback/pause, frame stepping and timeline seeking passed. With four actual shard requests blocked, normal Cancel returned to idle in **38 ms**, without a false result, uncaught error or late restart. No watchdog limit was weakened.

Catalog Git tree: `559f7f39e3a8eed452ef7eb6a3355a318235c307`.
Reference recording SHA-256: `d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b`.

## Evidence and handoff

[Artifact 11310419904](https://github.com/ugin-man/many-faces-beta/actions/runs/37222658011/artifacts/11310419904), 610,117 bytes; GitHub-reported SHA-256 `f3e9fe0d2e0918319de88b18e908397790a68051d12744750fe6600a4ac8bae0`. It includes the four raw decisions, browser report, full-catalog audit, cancellation, identities and build/test/lint logs. Results were inspected in completed workflow logs; no local archive-hash or screenshot inspection is claimed in this pass. Summary: [VIDEO_RANK_SPEED_RESULT.json](VIDEO_RANK_SPEED_RESULT.json).

Integrate the canonical branch into the EXISTING Work Site, preserve host-specific source/settings, rebuild client/server/workers together and check matching build identities. The version text remains `camera-arrival-v3`; only the build **`c5317177db4f044f`** distinguishes this exact source snapshot. Host-specific edits may change the fingerprint, but component identities must agree. Git updates do not rebuild a deployed Site.

No hosted-device/Safari/long-session or new physical-camera validation was performed. No improvement in expression fidelity or playback FPS is claimed: the selected sequence is deliberately unchanged. Roughly 47 s of acquisition/Face Mesh and 43 s of loading/search remain in this runner; the application still needs about 93 s to prepare this 23 s recording. Larger gains require profiling/changing the remaining acquisition or detailed-search/data-access work, with separate equality/quality gates, rather than treating this cleanup as sufficient.
