# Responsive realtime pipeline

`/live` is the current realtime implementation. `/live/legacy` keeps the earlier implementation for comparison.

## Product behavior

The output is motion-driven rather than timer-driven.

- Static tracking noise holds the current face.
- Small meaningful changes accumulate instead of disappearing inside a per-frame threshold.
- While the face is moving, the controller targets roughly 10–20 output changes per second.
- The target is an output cadence, not a claim that every browser and GPU has already achieved 20 fps in camera testing.

## Runtime stages

1. MediaPipe Face Landmarker measures pose, 468-point geometry, and facial actions.
2. Current and short-horizon predicted pose neighborhoods are loaded from the 3-degree catalog.
3. A bounded hash index retrieves a fixed candidate beam.
4. Detailed projection ranking is limited to the top beam.
5. Near-tie candidates receive a small transition-continuity penalty, favoring intermediate face states over large unrelated jumps.
6. Images are prepared before display.

## Image preparation

Two paths run in parallel.

### Packed warm path

Nearby ranked faces are grouped by catalog pack. Whole packs are fetched once, sliced in the browser, decoded, and kept in a bounded cache. Only a small number of new packs can enter one preload pass.

### Direct cold-pack fast lane

The highest-ranked faces are also requested through the per-image range endpoint. This avoids waiting for a multi-megabyte pack before the first usable candidate appears. The first successfully decoded path wins; pack warm-up continues for later frames.

Queued direct requests are latest-biased, so stale camera frames cannot create an unbounded download backlog.

## Search cadence

Detailed ranking does not need to run at the full camera-detection cadence.

`AdaptiveSearchCadence` targets approximately 20 searches per second when ranking is cheap. When measured ranking time rises, it backs off toward approximately 12 searches per second, leaving main-thread time for MediaPipe and image decode.

Static frames are not repeatedly re-ranked.

## Neighborhood index reuse

The browser keeps a four-entry LRU of recent pose-neighborhood indexes. Turning back across a recently visited 3-degree boundary reuses the existing index instead of rebuilding the same roughly 2,000-candidate hash tables on the main thread.

## Telemetry

The realtime page displays:

- detection fps;
- actual output-change fps;
- target output fps;
- detailed search time;
- measured motion;
- ready image count, including direct fast-lane images;
- loaded pack count and memory;
- local candidate pool;
- loaded shard count.

## Automated gates

Realtime CI validates installation, application build, unit tests, lint, catalog delivery, and a deterministic 2,400-candidate / 240-frame search benchmark.

The latest machine-readable records are:

- `data/live-realtime-ci-result.json`
- `data/live-responsive-benchmark-result.json`

The benchmark is a regression gate for the search path. It does not replace an actual camera test on the target PC, because MediaPipe, browser image decode, network behavior, and GPU delegate performance are device-dependent.

## Catalog policy

The runtime catalog remains the 70,000-face, 775-cell, 3-degree Clean Core v3 seed with `real-photo-only-v1` policy and zero known Synthetic Humans FACS images selected at runtime.
