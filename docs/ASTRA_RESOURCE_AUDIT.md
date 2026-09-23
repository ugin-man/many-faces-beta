# Many Faces resource and exact-search audit — 2026-09-09 JST

## Identity and decision

Repository: `ugin-man/many-faces-beta`. Branch: `astra/realtime-hardening`. Review route: `/live/astra` in ChatGPT Work Site, using the unchanged full 70,000-photo asset. `/live` remains the fixed-video reference. No reduced catalog, portable application, base/main merge or hosted deployment was made.

Baseline: `a2b9bcde2d2be2c6b84e0ee88a6845ce37f86d77` (the already improved application, not the older 7-fps baseline).

Final tested application: `fe83ed35988ac18c0805987a176b3aac5adca203`.

Accepted: exact bounded top-k selection and safe pose-distance lower-bound pruning for the existing coarse score. Default parsed-cache replacement remains LRU, with its original 48-shard capacity. A frequency-based alternative was implemented and tested, then rejected as the default because a reduced request count did not establish a transfer-byte or quality improvement. It is available only through an explicit constructor argument for experiments; the live worker does not enable it.

Catalog Git tree in both baseline and final: `559f7f39e3a8eed452ef7eb6a3355a318235c307`. Assets were not removed, recompressed or replaced.

## Executed checks and evidence

Final exact revision:

- [Repository CI](https://github.com/ugin-man/many-faces-beta/actions/runs/34262147315): success, including the configured `npm test`, lint and Python-tool check.
- [Realtime verification](https://github.com/ugin-man/many-faces-beta/actions/runs/34262141157): success, including build, targeted tests, full-catalog browser lifecycle checks, resource profiling and source-integrity check.
- [Resource audit and paired comparison](https://github.com/ugin-man/many-faces-beta/actions/runs/34262141175): success, including all Astra invariants, all-70k offline shortlist comparisons, controlled cache replays, both production builds and four browser trials.

[Final evidence artifact](https://github.com/ugin-man/many-faces-beta/actions/runs/34262141175/artifacts/10070466795): `astra-resource-audit-34262141175`, 2,285,512 bytes, SHA-256 `34c494fac92bc676a6b068e781a12b80213edd9e39b5c367aa81473b03d047a7`. Contains numerical/cache report, paired-resource report, individual resource timing entries, screenshots and build/server/fixture logs. This is diagnostic evidence, not a reduced application.

The rejected frequency-default experiment was application `fc51b818d4c9c4428e72ae84b56debf894f5af88`, tested in [run 34261260185](https://github.com/ugin-man/many-faces-beta/actions/runs/34261260185). Its [evidence](https://github.com/ugin-man/many-faces-beta/actions/runs/34261260185/artifacts/10070177085) is retained separately. The earlier run 34260272410 was superseded/cancelled before its browser comparison completed; do not count it as a completed comparison.

All browser tests here used GitHub Actions and production `vinext start`, with Chromium's native virtual camera cycling the same three public catalog photographs. They did not use the user's Work Site, physical camera, Safari or private `IMG_3665.mp4`. The results are not independent continuous-human-motion or expression-quality validation. Screenshot evidence in this CI environment renders Japanese glyphs as boxes; it is not proof of correct Japanese typography on the actual Site. Lint success is not a claim of zero warnings.

## Exact ranking optimization

Previously every active candidate received the complete coarse score, followed by a full sort. The replacement keeps an exact size-k max heap and maintains a separate bounded reserve for previous IDs. Tie ordering remains original candidate index order. Previous IDs retain their existing score bias and reservation behavior.

The pose contribution is a lower bound because all remaining coarse-distance terms are nonnegative. A non-previous candidate is excluded from further arithmetic only when its pose-only bound is strictly worse than the current kth complete score. Equality is not excluded. Recent IDs are always fully evaluated. No stride sampling, changed score weights or reduced asset is involved.

This preserves the shortlist for a given candidate set; it is not a claim that the coarse score itself is perceptually correct. Timing changes can change the video frames and pose neighborhoods encountered at runtime.

Verification:

- An independent full-sort test oracle covered 45 randomized/perturbed queries, missing projections, varied structure lengths, multiple budgets, stable ties and previous-ID edge cases.
- A separate all-asset test constructed candidates from all 70,000 actual records and compared the complete ordered shortlist against the previous implementation for 32 perturbed queries. Each offline query considered all 70,000 candidates. Mismatches: zero.
- Every candidate was visited for its bound; only 1,380 to 21,701 candidates per tested offline query needed the remaining coarse-distance terms. This range is workload-specific, not a universal bound.
- A far-away reserved previous ID and equal-score boundary candidates were explicitly covered by regression tests.

The live application is STILL pose-local: up to 24 active shards backed by a 48-shard parsed cache. The offline all-70k test does not mean global search was enabled in `/live/astra`. Detailed projection scoring still uses 48 shortlisted candidates. An all-catalog coarse/detail split remains future work.

### Same-run Node component timing

A prepared 6,364-candidate set, 24 coarse queries per iteration, two warmup iterations and nine measured repeats:

| Component | Baseline median | Final median |
| --- | ---: | ---: |
| 24 coarse queries | 81.944 ms | 16.192 ms |

This is about a fivefold improvement in this component. It excludes MediaPipe inference, image loading, detailed projection comparison and drawing. The old/new timing loops were not interleaved; do not interpret this as an application-wide speed multiplier or a statistical performance guarantee.

## Final paired browser comparison

Order: baseline, final, final, baseline. Fresh Chromium process per trial. Each trial waited for output and a three-second warmup, then measured approximately 20 seconds. The table gives means of two trials per version; MB below is decimal.

| Metric | Baseline | Final (LRU restored) |
| --- | ---: | ---: |
| Processed frames/second | 18.456 | 18.985 |
| Actual displayed-photo changes/second | 2.644 | 2.744 |
| Mean of session capture-to-draw P95 values | 92.5 ms | 91.0 ms |
| Shard resource entries in measured interval | 285 | 265 |
| Distinct shard URLs in interval | 64 | 69 |
| Locally cached shard resource entries | 265 | 243 |
| Browser-reported shard transfer bytes | 8.910 MB | 10.391 MB |
| Shard decoded response-body bytes consumed | 221.351 MB | 207.247 MB |
| Browser-reported image transfer bytes | 0.366 MB | 0.352 MB |

Individual processed rates: baseline 18.257 and 18.655 fps; final 19.111 and 18.859 fps. Individual session P95 values: baseline 94 and 91 ms; final 96 and 86 ms. Individual shard transfer totals: baseline 10.159 and 7.660 MB; final 12.974 and 7.807 MB. Every final snapshot had zero image failures. No measured request failures or HTTP errors were recorded. Capacity/lifecycle gates passed.

Interpretation:

- The final system remained around 19 fps. The modest mean throughput change is not another twofold application speedup. P95 was essentially similar within the small sample.
- Shard resource-entry counts and decoded-body bytes decreased in this comparison, but mean browser-reported shard transfer bytes increased about 16.6%. Network-byte reduction is NOT achieved. The individual ranges vary substantially; two trials do not identify a stable effect or its cause.
- Restoring LRU was not sufficient to make the final transfer-byte mean lower. The data do not support attributing all transfer changes to cache policy alone. Faster scoring, timing and the resulting sampled pose path can affect accessed objects; those contributions were not isolated.
- Default-cache deterministic traces exactly matched baseline miss counts: repeated sweep 45/45, changing route 635/635, stationary 9/9. Runtime payload capacity stayed 48, not a hidden larger cache.
- Actual photo-change counts are not matching accuracy. The same-image hold behavior, source stimulus and timing matter. No claim of improved blink/mouth correspondence is made.

## Why the cache experiment was not adopted

The frequency-default experiment combined the same exact-search optimization with frequency-aware cache admission. It reduced mean shard resource entries from 243 to 217 over its own 20-second paired windows, but browser-reported shard transfer rose from 11.013 MB to 13.439 MB (about 22%). A changing-path deterministic trace also increased misses from 635 to 647. Other controlled paths were unchanged, while a synthetic one-pass-pollution test improved.

Thus the attractive synthetic cache test was not enough. No universal cache-policy improvement or independent quality benefit was established, so the default was restored to LRU and a regression test now enforces that choice. These experiments do not prove frequency policies are generally inferior, and the browser comparison does not isolate cache causality from the simultaneous search change.

## Measurement correction: reads are not wire traffic

The harness records Resource Timing independently in the window and each worker. It retains only entries started and ended within the corresponding scope's measured interval, plus HTTP/error lifecycle observations. Resource entries can include failed/cancelled operations, so they are not blindly named successful responses. In the recorded final/rejected trials, the shard entries had successful status and cache metadata consistent with the counters.

A zero transfer size with a positive decoded-body size was counted as local cache service in this same-origin test. Around 92-93% of shard entries in the final comparison were served locally. The remaining reads, object sizes and access pattern determine network use; response count alone cannot establish it. The earlier audit's count increase must not be relabelled a measured byte increase.

`transferSize` is the browser's Resource Timing accounting, including its fixed header contribution, not packet-captured wire bytes. `decodedBodySize` is the response body after content decoding, not the RAM footprint of parsed JSON, MediaPipe or the whole browser. Neither counter measures pure JSON parse CPU time. See the [W3C Resource Timing specification](https://www.w3.org/TR/resource-timing/) for these fields.

P95 remains the application's statistic over each trial's whole session, excluding never-displayed frames; the table averages trial P95 values. It is not a pooled percentile, a 20-second-only percentile or sensor-to-display latency. No startup acceleration or memory-leak-free long-session claim is made.

## Next priority

The expensive remaining pattern is repeated consumption/reconstruction of large geometry-bearing JSON, even when HTTP cache avoids a network transfer. A non-destructive all-catalog coarse index with detail loaded only for finalists is the next architectural candidate; it was not implemented in this pass. Its evaluation must include recall, rare-expression access and total resource cost, not just fps.

Independent continuous head/eye/mouth-motion evaluation, actual Work Site and device review, startup/WASM MIME behavior, camera/background/rotation compatibility and catalog-write authorization remain open release gates. Do not promote or deploy merely because CI is green.
