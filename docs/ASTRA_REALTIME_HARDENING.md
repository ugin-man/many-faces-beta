# Many Faces realtime handoff — 2026-09-09 JST

## Canonical target

Repository: `ugin-man/many-faces-beta`. Working branch: `astra/realtime-hardening`. Draft PR #3 targets `work/coverage-driven-200k` and remains unmerged.

Use the unchanged full 70,000-photo catalog and `/live/astra` for review in ChatGPT Work Site. `/live` remains the fixed-video reference. No reduced catalog, lightweight app ZIP, separate local-preview product, main/base merge or hosted deployment was made.

## Latest tested application

`fe83ed35988ac18c0805987a176b3aac5adca203`.

Read [ASTRA_RESOURCE_AUDIT.md](ASTRA_RESOURCE_AUDIT.md) for this round's accepted and rejected changes, exact revision identities, measurements, evidence and limitations. [ASTRA_ADVERSARIAL_AUDIT.md](ASTRA_ADVERSARIAL_AUDIT.md) records the earlier e71535d round; its numbers are historical, not current comparative results.

Final runs completed successfully: repository CI `34262147315`, realtime validation `34262141157`, and resource/paired audit `34262141175`. These include configured npm tests, lint, Python-tool checks, full-catalog lifecycle checks, numerical ranking comparisons and paired production-browser measurements. This is not a warning-free, real-camera or production-ready claim. Subsequent handoff-only changes do not alter the tested application.

## Current architecture

Fresh camera/video frames go to a classic MediaPipe Worker. At most one frame is in flight; results over 500 ms old are discarded. Phase-preserving sampling targets 20 Hz without the old 30-to-15 Hz quantization bug. Stop/restart is generation-scoped and releases tracks, workers, image requests and native resources.

Catalog reads use `source=seed`. The default parsed cache is still 48-shard LRU; the active pose working set uses at most 24 shards. Frequency-aware cache admission was tested but is not enabled in the live worker. Its reduced request count did not establish reduced transfer bytes or improved visual quality.

No arbitrary 2,400-candidate thinning remains. Reusable numerical descriptors, an exact bounded top-k heap and a safe pose lower bound preserve the coarse shortlist for a given active candidate set while avoiding unnecessary complete scoring/sorting. Recent-ID reservation and tie order are retained. Detailed projection scoring uses 48 finalists. This is still pose-local access, not globally exhaustive all-70k live matching.

The new offline stress test queried all 70,000 candidates for 32 perturbed inputs with zero shortlist mismatches against the previous implementation. Independent randomized oracle tests cover additional edge cases. These validate numerical equivalence, not perceptual correctness. All catalog assets remain unchanged (Git tree `559f7f39e3a8eed452ef7eb6a3355a318235c307`).

Image caching remains bounded to 64 images / 32 MiB with at most three requests. Prefetch and display share a quality envelope; an invalid static hold can settle after movement ends. These component limits are not total-browser memory guarantees.

## Current measured result

Against baseline `a2b9bcde...`, two trials each, ABBA order, approximately 20-second windows after warmup:

- Mean processed rate: 18.456 -> 18.985 fps.
- Mean session capture-to-draw P95: 92.5 -> 91.0 ms.
- Mean actual photo changes: 2.644 -> 2.744/s, not a visual-quality measure.
- Mean shard resource entries: 285 -> 265; most were local-cache service.
- Mean browser-reported shard transfer: 8.910 -> 10.391 MB. Network-byte reduction remains unachieved.
- A Node coarse-query component benchmark (24 queries over 6,364 prepared candidates) improved from 81.944 to 16.192 ms median; not an application-wide multiplier.

GitHub Actions Chrome used the same three-photo native virtual-camera stimulus, not the user's Work Site or real continuous human movement. No private IMG_3665.mp4 was used/uploaded. No physical-camera, Safari, long-session or perceptual matching claim is made.

## Audit and next work

CI validates exact revisions without source rewriting, retains diagnostic evidence, and no longer produces reduced applications. The resource audit distinguishes window/worker resource entries, local-cache reads, browser-reported transfer and decoded-body volume. Fixture preparation in the paired workflow has a three-minute deadline.

The next architectural candidate is a non-destructive all-catalog coarse/detail index split to avoid repeatedly consuming/reconstructing geometry-heavy JSON. It is not implemented yet. Evaluate rare-expression recall and held-out head/eye/mouth motion alongside cost. Also test actual Work Site and cameras, Japanese typography, Safari, long sessions and background/orientation transitions.

Before publication, resolve catalog-write authorization/trusted-header concerns and startup/MIME warnings. Main/base promotion requires a separate decision and rollback; green CI alone is not a release authorization.
