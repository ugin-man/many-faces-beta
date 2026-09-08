# Many Faces adversarial audit — 2026-09-08 JST

## Scope and identity

Repository: `ugin-man/many-faces-beta`. Working branch: `astra/realtime-hardening`. Draft PR #3 still targets `work/coverage-driven-200k`; neither that branch nor `main` was merged or deployed by this audit.

- Baseline application: `e6e380a1b4f585a1b0836b262c991e4c8b188939`.
- Corrected and browser-tested application: `e71535d1480e0b61b8ff813e3cfd89312779f1ee`.
- Catalog Git tree before AND after: `559f7f39e3a8eed452ef7eb6a3355a318235c307`.
- Canonical review: the full 70,000-face `/live/astra` route through ChatGPT Work Site. No compact catalog, portable server or app ZIP was created.
- Actual execution here: GitHub Actions, native Chromium virtual camera, and production `vinext start`. Not the user's hosted Work Site or physical camera. The private `IMG_3665.mp4` was not used or uploaded.

## Executed evidence

[Standard verification](https://github.com/ugin-man/many-faces-beta/actions/runs/34159127418) completed successfully: production build, 43 scoped tests (43 passed, zero failed/skipped), lint, full-catalog browser lifecycle verification, resource profiling and source-integrity check. Lint had zero errors and 13 existing warnings; this is not a warning-free or whole-repository-test claim.

[Adversarial and paired comparison](https://github.com/ugin-man/many-faces-beta/actions/runs/34159127550) also completed successfully, including actual baseline-failure reproductions, every-record asset checks and an ABBA browser comparison. The 27 Astra tests in this second run overlap the 43 scoped tests; do not add them together as 70 distinct tests.

[Evidence artifact](https://github.com/ugin-man/many-faces-beta/actions/runs/34159127550/artifacts/10032075159): `astra-adversarial-34159127550`, 2,234,009 bytes. SHA-256 `e270d92ba1021293fb5f07bacdf547faf801cfa510ae3e53fa30fb8adb7fcb9e`. Contains `adversarial-report.json`, `paired-browser-report.json`, before/after screenshots, fixture/build/server logs. This is evidence, not a lightweight version of the application.

## Reproduced failures, not just code-review suspicions

### A. Frame limiter reduced a 20 Hz target to 15 Hz

The previous sampler waited 50 ms after each accepted frame. With input arriving every 33.3 ms, it accepted every second frame. A deterministic three-second, 30 Hz input test measured 45 accepted frames in the baseline versus the required 60. The corrected deadline-preserving sampler accepts 60, while remaining single-flight and dropping missed deadlines instead of building a catch-up queue. Both 30 Hz and 60 Hz sources are covered by regression tests. This isolated scheduler test is not a guarantee that real inference can sustain 20 Hz.

### B. Prefetch optimization could permanently starve the best image

The baseline counted any three ready/pending candidates in the first six as a sufficient reserve. Those images could all lie outside the presentation quality envelope, leaving the new winner permanently unfetched. The baseline reproduction loaded three images and never requested the new winner; corrected code makes the fourth request and loads it.

Prefetch now uses the same quality envelope as display and prioritizes the top three eligible candidates. A best candidate is not blocked just because three inferior but still close images happen to be cached. Cancellation cleanup also handles an A-to-B-to-A request sequence without leaving A stuck behind its own aborted request.

### C. Static hold could keep a now-incorrect face forever

When motion stopped before the new image arrived, the baseline would only accept the current ID. If that ID was now outside the quality envelope, it returned no replacement even when a valid new image was available. The baseline reproduction returns null; corrected code selects the new image. An acceptable current candidate still remains held, preserving useful static stability. This corrects an invalid hold, not permission to rotate unrelated images to inflate FPS.

### D. Protected entries could bypass a cache capacity

With capacity two and three protected keys, the baseline retained three entries. Protection is now an eviction preference, not permission to exceed the hard bound. The same reproduction retains two entries after correction.

## Architecture changes and measured tradeoffs

The active pose working set previously rebuilt five string-hash tables and candidate sketches repeatedly, and evenly thinned more than 2,400 candidates down to 2,400. That thinning could discard a relevant rare candidate before the actual matching stage.

The Astra route now caches numerical descriptors in a WeakMap keyed by immutable candidate objects. Rebuilding an active index mainly assembles references. Membership signatures prevent rebuilds caused only by ordering differences, and `peek` avoids mutating LRU recency during an index read. The arbitrary 2,400-candidate stride thinning is removed. Coarse ranking scans every candidate in the active set; detailed projection ranking still runs on 48 of the 128 shortlisted candidates.

This is NOT a global exhaustive search of all 70,000 faces. The active set still consists of up to 24 pose-local shards, backed by a 48-shard parsed cache. Entries outside that working set are not evaluated for the current frame. An all-catalog coarse index and rare-expression routing remain separate design work.

The vector decoder was also changed from iterator-based temporary typed arrays to direct little-endian signed-int16 decoding into the final float array. Numerical equivalence was checked, not assumed.

### Same-run Node microbenchmarks

Medians after two warmup iterations. Decoder/index measurements each have nine measured repeats; query measurement has five. These are component timings, not total UI speed multipliers.

| Operation | Baseline | Corrected |
| --- | ---: | ---: |
| Decode 192 catalog entries | 73.403 ms | 3.020 ms |
| Rebuild the active index | 24.346 ms | 0.144 ms |
| Candidates included by that index | 2,400 | 4,695 |
| Rank 24 queries, including detailed comparison | 32.472 ms | 72.672 ms |

**Query computation became slower**, because the corrected path scans more active candidates instead of hash-subsampling a thinned pool. The selected tradeoff is cheaper decoding/rebuilds, retained active candidates and better measured complete-pipeline throughput. Warm descriptor reuse is essential to interpreting the 0.144 ms index result; it is not a cold-start timing.

The catalog-self-retrieval probe found its source ID in the shortlist for 24/24 queries in both versions. It establishes no improvement in real matching quality. Its evenly spaced query positions can align with the old stride sample, so it is especially weak evidence for general recall. The separate adversarial rare-candidate test covers a candidate beyond the old thinning boundary, but neither test replaces independent head/eye/mouth-motion validation.

## Paired full-catalog browser results

Both exact application revisions ran on the same runner, using the same full catalog and the existing three-public-photograph camera fixture. Order: baseline, corrected, corrected, baseline. Each trial had a fresh Chromium process, waited for actual output and warmup, then measured roughly 12 seconds of frame-count and output-count deltas.

| Metric | Baseline, two-trial mean | Corrected, two-trial mean |
| --- | ---: | ---: |
| Processed frames per second | 7.561 | 18.332 |
| Actual displayed-image changes per second | 3.365 | 2.827 |
| Session capture-to-draw P95, mean of trial P95s | 263 ms | 86.5 ms |
| Image requests during the measured window | 82 | 53.5 |
| Shard responses during the measured window | 88 | 172.5 |

Individual processing rates: baseline 6.809 and 8.313 fps; corrected 18.290 and 18.375 fps. Individual P95 values: baseline 252 and 274 ms; corrected 88 and 85 ms. Every processed frame in these measured windows had a detected face. Image failures were zero in the four final snapshots. All trials retained a maximum of one in-flight frame and remained within decoded-image bounds.

Interpretation:

- Throughput improved by about 2.42x in this environment; the observed capture-to-draw latency was lower.
- Displayed-image changes decreased. Do not describe this as faster face switching or proven better facial-expression fidelity. Static hold, a changed shortlist and the stepped-photo stimulus all affect this count; their contributions were not isolated.
- Image requests decreased, but shard responses nearly doubled. Therefore the claim that all network traffic decreased is false. Exact transferred byte totals and cache-hit ratios were not measured by this paired report. More frequent processing/access is a possible contributor, not a demonstrated sole cause. This is a remaining resource-pressure issue.
- P95 is the application's acquisition-to-draw statistic over that trial's session, not a newly calculated 12-second-only percentile and not sensor-to-photon latency. It excludes frames never displayed. The table averages two trial P95s; it is not a pooled percentile.
- `firstObservedOutputFromClickMs` in raw evidence waits for the readiness guard (including ten processed frames), so it must not be relabelled as exact time to first drawing.
- `shardParseMs` diagnostics include response-body reading plus JSON parsing and may overlap between requests. They are not pure CPU parse time and must not be summed as sequential blocking time.
- There were only two trials per version and a three-photo virtual-camera stimulus. This is functional/performance evidence under these conditions, not a real-device or continuous-human-motion performance guarantee.

## The 70,000-face asset was independently checked

The audit read all 775 shards and their referenced image segments. It found:

- 70,000 records, 70,000 unique IDs, 70,000 unique encoded-image SHA-256 hashes; zero exact encoded duplicates.
- All 70,000 referenced image ranges were within their pack and had consistent RIFF/WebP magic and declared payload length.
- 210,000 shape/mesh/projection vectors and 132,930,000 decoded numeric values compared between old and new decoder; zero mismatches.
- Actual pixel decoding succeeded for 1,550 samples: the first and last item of every shard. The remaining entries were not all pixel-decoded, so this is not a claim that every image underwent a complete codec check.
- The entire catalog Git tree was identical before and after. No images were removed, recompressed or replaced.

The stored expression labels were recounted from actual entries: `winkLeft` 6, `winkRight` 6, `eyesWide` 5, `mouthRound` 4, `mouthOpen` 43. Background-labelled records total 55,507. These are stored category counts, not a manual semantic classification of the photographs. They flag a coverage risk, but do not prove that all other images lack those visible expressions. Existing `gatePassed: true` metadata should not be read as a guarantee of good coverage for arbitrary live expressions.

## Remaining release risks and next priority

1. **Measured shard churn:** trace distinct versus repeated shard requests, bytes, cache hits and pose transitions. Prefer a non-destructive coarse/detail split over a blindly larger cache or reduced catalog. No sidecar index was implemented in this pass.
2. **Independent matching-quality benchmark:** use held-out continuous head, blink and mouth motion, expected pose/expression error and stale-output duration. Catalog-derived queries and a three-photo fixture cannot certify visual correspondence. Reassess the local working-set heuristic against rare-expression queries.
3. **Published-write authorization:** source review found `canUploadCatalog` returns true when BUCKET is present and CATALOG_UPLOAD_KEY is absent, and otherwise may trust `oai-authenticated-user-email`. The hosted gateway/header trust boundary was not tested. Treat this as an unresolved configuration-dependent publication risk, not a demonstrated external exploit. The existing upload contract was not silently changed during this realtime optimization.
4. **Startup and runtime coverage:** WASM MIME fallback, duplicate GPU/CPU initialization cost, actual Work Site, physical cameras, Safari, long sessions, background/return and orientation remain open. The prior warnings are not claimed fixed.

The project is ready for the user's next Site review of the corrected full-catalog route, not declared production-complete. Changes to the audit handoff after the tested commit are documentation only.
