# Many Faces realtime handoff — 2026-09-08 JST

## Canonical target

Repository: `ugin-man/many-faces-beta`. Working branch: `astra/realtime-hardening`. Draft PR #3 targets `work/coverage-driven-200k` and remains unmerged.

Use the existing full 70,000-face catalog and `/live/astra` for review in ChatGPT Work Site. `/live` remains the fixed-video reference. Do not create a reduced catalog, lightweight app ZIP or separate local-preview product. Neither main/base promotion nor hosted deployment was performed in this pass.

## Latest tested application

Application commit: `e71535d1480e0b61b8ff813e3cfd89312779f1ee`.

Read [ASTRA_ADVERSARIAL_AUDIT.md](ASTRA_ADVERSARIAL_AUDIT.md) for exact baseline, reproduction cases, measurements, evidence links and limitations. Later handoff edits do not change the tested application.

The standard run `34159127418` passed build, 43 scoped tests, lint and full-catalog browser lifecycle verification. Lint had zero errors and 13 existing warnings. The separate run `34159127550` passed adversarial baseline reproductions, every-record catalog audit and a paired before/after browser comparison. These checks completed; they are not merely queued.

## Current architecture

A continuous camera/video client acquires fresh frames. A classic Web Worker performs MediaPipe face inference and candidate matching, leaving controls/drawing on the UI thread. At most one frame is in flight, and results older than 500 ms are discarded. Generation-scoped stop/restart closes workers, media tracks, image requests and native image resources. A cancelled late permission grant cannot resurrect capture.

The frame sampler preserves its target timing phase. Unlike the prior delay-after-accept sampler, a nominal 20 Hz target no longer silently becomes 15 Hz with a 30 Hz input. This does not guarantee that inference on every device can sustain 20 Hz.

Catalog reads stay on `source=seed`. A parsed LRU cache keeps at most 48 shards; the active pose working set uses at most 24. The old 2,400-candidate stride thinning is removed. Every candidate in the active set receives coarse scoring using reusable numerical descriptors, followed by detailed comparison of 48 shortlisted candidates. This is still pose-local approximate access, not a global all-70k detailed scan.

Base64 geometry decoding uses a direct signed little-endian loop. All 132,930,000 geometry values across the full catalog matched the old decoder exactly in the executed audit. The source catalog tree did not change.

Candidate image storage remains bounded at 64 decoded images / 32 MiB with at most three requests. Prefetch and display now share a quality envelope, so cached inferior faces cannot starve the new best image. A now-invalid static hold can settle to an eligible replacement after motion stops. Valid static images are not arbitrarily rotated to inflate output rate.

## Actual comparative result

Two trials per revision, ABBA order, fresh Chromium processes, same full catalog and three-public-photo virtual camera. Rates use approximately 12-second frame/output deltas after warmup.

- Mean processed rate: 7.561 -> 18.332 fps.
- Mean of session capture-to-draw P95s: 263 -> 86.5 ms.
- Mean image requests per measured window: 82 -> 53.5.
- Mean shard responses per measured window: 88 -> 172.5, an unresolved increase.
- Mean actual face-image changes: 3.365 -> 2.827 per second; this is not proof of better motion correspondence.

These are GitHub Actions production-browser measurements, not Work Site/physical-camera performance guarantees. The fixture is not independent human-motion quality evaluation. The private IMG_3665.mp4 was not used or uploaded.

## Audit and CI

`.github/workflows/astra-realtime-hardening.yml` validates the exact source and full-catalog pipeline without rewriting or pushing code. `.github/workflows/astra-adversarial-audit.yml` reproduces baseline defects, scans the unchanged assets and executes a paired comparison. Both retain evidence only, not a reduced application.

Known malformed one-time source-rewriting workflows remain archived in `docs/archived-workflows/`.

## Remaining priorities

First trace the increased shard traffic (unique/repeated reads, bytes and cache misses). Then evaluate a non-destructive all-catalog coarse/detail index split and independent real-motion quality tests, especially rare eye/mouth expressions. A nominal 70k count and legacy asset gates alone do not prove expression coverage.

Before publication, review catalog-write authorization and trusted gateway headers; resolve startup/MIME warnings; test actual Work Site, real cameras, Safari, long sessions and background/orientation transitions. Do not promote or deploy merely because scoped CI is green.
