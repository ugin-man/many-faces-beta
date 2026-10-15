# Video preprocessing speed — 2026-10-04 JST

## Scope

The user confirmed their realtime camera works and asked to leave realtime alone. Only `app/live/review-search.worker.ts` and the new video-only `review-work-cache.ts` change application behavior in this pass. Realtime, media input, the CPU model, video frame acquisition, shared matching formulas/weights, UI, playback, 70,000 images and reference assets are unchanged.

Baseline: `7eff666803fa5143e154995fae280453d21ec5f6`.
Measured application: `5440432d6521249a75c27cf41e8b53e6532aa1f7`.
Final acceptance: `fc4202ba808ea53639be9ec2082cb4e903f9ac2d`, with identical application source. Later changes to tests/docs preserve application build `2d8e677c69df0ccf`. The existing version label remains `camera-arrival-v3`; use the build ID to identify this video change.

The experiment used `astra/video-speed` before integration into the canonical `astra/realtime-hardening` branch/PR #3. No main/base merge, hosted Site rebuild, alternate app or reduced catalog was performed.

## Change

The old worker cached individual shards but still walked all files in groups of four and used a zero-delay timer after every group, including fully cached groups. It repeatedly rebuilt and deduplicated the same ordered candidate arrays. Decoder batches also yielded unconditionally every 32 entries.

The replacement uses an eight-millisecond work budget and a MessageChannel task yield between small batches, forcing a genuine task yield after each matched frame. It preserves cancellation and real-progress deadlines. Zero-delay nested timers are not free: the [HTML timer specification](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers) specifies a four-millisecond minimum after sufficient nesting.

An LRU retains at most eight complete ordered windows and 100,000 references to already parsed candidates. Keys preserve file order and thus tie-breaking. Oversized windows are processed in full without caching, never truncated. Ports/caches are cleaned up; cancellation still terminates the worker. Request concurrency remains four; pose windows remain 12/15 degrees and the existing 18/21-degree expansion. Rankers, repeat policy and sequence weights are byte-identical to baseline.

## Measured full-video comparison

[Measurement run 37154910278](https://github.com/ugin-man/many-faces-beta/actions/runs/37154910278) processed the complete 23.3-second reference at the existing 20 samples/second through the actual browser UI. Order was before/after/after/before, with a fresh Chromium process/profile each time. Both versions used the same runner, local servers, full catalog and settings. This is not a public-network or hosted-Site benchmark.

| Order | Version | File selection to result, seconds | Candidate loading/search, seconds |
| --- | --- | ---: | ---: |
| 1 | Before | 154.583 | 83.7961 |
| 2 | After | 119.686 | 49.0687 |
| 3 | After | 120.800 | 48.7568 |
| 4 | Before | 152.199 | 83.2055 |
| Mean | Before | 153.391 | 83.5008 |
| Mean | After | 120.243 | 48.91275 |

Mean end-to-end wait fell 33.148 seconds, **21.6101%**. Candidate loading/search fell **41.4224%**. Capture plus Face Mesh did not improve: 65.7336 seconds before and 67.31095 seconds after. Path optimization remained about 2.27/2.29 seconds and image preload 0.98/0.96 seconds. Phase timers exclude some boundary overhead. This is preprocessing speed, not playback FPS.

After trials each had 248 whole-window cache hits and 162 misses. Actual ranking still costs about 34 seconds. The recording does not yet process in realtime.

## Identical output and unchanged assets

All four trials produced identical source-descriptor hashes and output hashes. Each sampled 466 positions, detected faces in 410, generated 410 sequence items, selected 141 unique photos and made 153 identity changes. Image failures were zero and output was nonblank. Detection coverage remains 87.9828%, not 100%.

A separate replay sent the EXACT same acquired descriptor arrays through both unedited compiled workers. Deep comparison of every ID, timestamp, numeric error field, emission, acceptance flag and expression-motion decision found no differences. Both replay outputs also matched the four UI outputs. Replay search timings were 81.9805 seconds before and 47.8751 after; sequential shared-origin replay is an equality test, not the cold-browser headline benchmark.

Every trial/replay still consumed 417,215,798 logical response-body bytes, 722 shard files and 67,131 decoded candidates. Replay peak candidates remained 15,488. These are not compressed on-wire byte counts. Network volume has NOT been reduced.

Catalog Git tree remains `559f7f39e3a8eed452ef7eb6a3355a318235c307`. Reference MP4 SHA-256 remains `d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b`. The protected realtime/capture/UI/matching/assets diff checks passed. Equality on the tested recording is not a universal proof or a claim of improved perceptual mouth/eye/wink quality.

## Acceptance boundary

The first workflow is correctly FAILED: four complete UI trials, playback/frame stepping and exact same-frame equality passed, but the last cancellation subtest timed out waiting to observe search. It sent a native file-change event after DOMContentLoaded without first verifying hydration and did not save a failure-state snapshot; its precise cause is not independently established.

[Final acceptance run 37156096656](https://github.com/ugin-man/many-faces-beta/actions/runs/37156096656) verified identical application/public/build/dependency source and the same build fingerprint, rebuilt, and passed all **166 tests (zero failed/skipped)** and lint. It reused the digest-verified completed measurements and executed the missing cancellation check with client-readiness and real pending-request evidence. Four actual shard requests were pending; normal Cancel returned to idle in 35 ms without false success, late restart or uncaught errors. No application source was changed to make that test pass. The original failed workflow was not relabelled. The corrected full benchmark now uses this same cancellation helper.

Measurement artifact: [11285377236](https://github.com/ugin-man/many-faces-beta/actions/runs/37154910278/artifacts/11285377236), SHA-256 `d7d9efb558ee0452c69a435b19ebb4fc234c6d71e2dff7f7f6fb85b7215cf1a1`.
Final receipt: [11285632087](https://github.com/ugin-man/many-faces-beta/actions/runs/37156096656/artifacts/11285632087), SHA-256 `30e80f91a17ec372757a9ac73854a30d27737f5b8ed9d010656254253a0c525f`.

Measurements/status were read from logs; no screenshot inspection or hosted performance test is claimed. Lint success does not mean no existing warnings. Summary: [VIDEO_SPEED_RESULT.json](VIDEO_SPEED_RESULT.json).

## Handoff

Rebuild the EXISTING Work Site from the canonical branch, preserving host-specific changes/settings, and check matching client/server/worker build identities. Source-identical builds report `2d8e677c69df0ccf`; a host-specific source change can alter that fingerprint. Git updates do not rebuild an already published Site.

Realtime remains unchanged. Next measured bottlenecks are capture/Face Mesh (~67 seconds), actual ranking (~34 seconds), and the unchanged detailed-data volume. Do not reduce sampling, resolution or matching neighborhoods, silently reuse old analysis, or remove acquisition safeguards merely to lower the reported duration.
