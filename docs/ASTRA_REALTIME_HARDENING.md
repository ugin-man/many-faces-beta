# Many Faces — Astra realtime hardening

Audited base: `work/coverage-driven-200k` at `0ddb7a72a794f410424793a290a221d456739478`.

## Current truth

- `/live` is a verified fixed-video-first five-second review path.
- The private fixed-video browser run previously reached 100% face coverage at 12/20/30 fps and mobile 390x844 layout verification.
- `/live/fast` is the existing frame-responsive realtime experiment.
- Physical-camera operation is still experimental and must not be represented as production-ready.
- `main` is far behind the working branch; the current feature work lives in draft PR #1.
- The working branch contains many historical write-capable workflows. Treat workflow churn and self-mutating CI as a reliability risk until release promotion is simplified.

## End goal

A user opens one route, grants camera permission, and sees another catalog face follow pose/expression continuously without a record-then-process pause. The route must fail visibly rather than display stale state, and it must stay usable under ordinary desktop and mobile browser load.

## Remaining gates

### G1 — Deterministic reference path hardening — IN PROGRESS

Acceptance:
- fixed-video decode/presentation barriers fail closed;
- a timeout cannot silently be counted as a decoded target frame;
- build, targeted tests, and lint pass on the hardening branch.

This branch adds that timeout hardening and a regression guard.

### G2 — Physical camera contract

Acceptance:
- camera start/stop/restart works repeatedly;
- permission denial, missing camera, tab backgrounding, device rotation, track-ended, and visibility restoration have explicit states;
- no stale `running` state survives a dead MediaStream or dead frame clock.

### G3 — Streaming matcher/output path

Acceptance:
- no five-second capture barrier;
- camera frames feed MediaPipe directly;
- pose-local shard loading and candidate ranking are incremental;
- output changes while movement continues and stabilizes while the face is still.

Use `/live/fast` as the implementation donor, but promote only behavior that passes the acceptance gate.

### G4 — Backpressure and latency budget

Acceptance:
- analysis, search, decode, and display each have measured budgets;
- slow devices shed analysis/search work instead of queueing stale frames;
- image and pack caches have bounded memory;
- target: visible response starts within 250 ms of meaningful motion after warmup, with a sustainable display cadence rather than a claimed FPS counter.

### G5 — Real-browser realtime E2E

Acceptance:
- Chromium desktop camera fixture or virtual-camera path exercises camera start -> movement -> output -> stop -> restart;
- mobile viewport runs without horizontal overflow;
- runtime heartbeat proves real progress;
- screenshot/video artifact and JSON receipt are produced for human inspection.

### G6 — Promotion and rollback

Acceptance:
- one canonical realtime route;
- fixed-video review retained as deterministic fallback/diagnostic route;
- obsolete mutation workflows no longer run on ordinary pushes;
- release commit has green CI and a documented rollback SHA;
- only then promote from the draft branch toward `main`.

## What the user can verify first

The nearest useful review target is not `main`. It is this hardening line plus `/live/fast` as the realtime experiment. The first user-visible checkpoint is reached when G1 is green and a browser preview of `/live/fast` can be opened with explicit camera-state telemetry. After that, G2 and G3 are the critical path; G4-G6 turn it from a demo into a reliable realtime route.
