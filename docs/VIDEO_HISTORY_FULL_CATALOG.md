# Full-catalog history-repair follow-up

**Decision: not adopted.** The bounded local repair was implemented and tested,
but it cannot reduce reappearances while preserving the existing quality gates
on the fixed recording. The current application Worker remains unchanged and
does not import either history experiment. Existing Site v56 was not republished.

This follow-up was evaluated on **2026-10-10 JST (2026-10-09 UTC)**. It extends
the [earlier history experiment](VIDEO_HISTORY_SELECTION.md) by checking all
70,000 catalog descriptors, rather than only the saved ranked candidates.
The experiment source is retained on `astra/video-history-full-catalog`.
The current `astra/realtime-hardening` branch receives documentation/evidence only.

## Fixed inputs and unchanged behavior

| Input | Pinned value |
| --- | --- |
| Application baseline | `04a41b80469980454758feba9a31ac48b92c11fd` |
| Current upstream before this follow-up | `f8a1e0e004b00b7a44bfbc107ff0c2ec6b4f13b1` |
| Prior experimental source | `f5e74d74861c4de9d3c7f93d79b32b0209ebf202` |
| Catalog | `many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1` |
| Catalog size | Exactly 70,000 records, unique IDs and unique image addresses |
| Pose grid | 3 degrees; 775 cells and 775 shards |
| Catalog Git tree | `afcb8f68a8db87424fe5169896be0fd0a57dbf65` |
| Manifest SHA-256 | `fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a` |
| Recording | Full 23.3-second `public/test-fixtures/reference-face-motion.mp4` |
| Video SHA-256 | `d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b` |
| Captured samples | 20 Hz; 466 planned samples, 410 detected-face frames |
| Original compressed snapshot SHA-256 | `8f48df320c4360cd9f107a2ed8790878b4072af5c4ce292c081c9ed98c8c4ab9` |
| Original chosen-sequence SHA-256 | `fb7d00b6531f0cff7a54ce56ea68f8fbd41044bafa8108b461b6f2970731b46f` |

The browser capture comes from the earlier full-video comparison
[run 37881350146](https://github.com/ugin-man/many-faces-beta/actions/runs/37881350146).
This follow-up replays those exact captured frames and verifies all original
IDs, timestamps, error objects, emissions, acceptance flags and stored expression
motion. It does not perform fresh video inference or a new browser speed run.

No catalog records, images, video samples, dependencies, visible controls,
face-position/size presentation, camera paths, realtime logic or Worker wiring
were changed. The older experimental projection module differs from the current
runtime only by exporting five existing mathematical helpers; their bodies and
the original optimizer remain identical.

## What was implemented

`app/live/review-history-repair.ts` starts with the original selected sequence.
It records continuous runs of one photo and looks for a return less than two
seconds after departure. Continuing to display the same image is never counted
as a return or penalized. There is no randomness or reward for novelty.

For each recent return it considers three local edits: holding the returning
photo through the intervening gap, replacing its returning run, or replacing
its previous run. A replacement must be supplied at every sample of its complete
interval and satisfy every original per-frame fidelity limit. It does not
rerun an unconstrained global search or change unrelated image selections.

Proposals are ordered by the original objective, including both boundary
transitions, with deterministic ID/interval ties. A proposal is retained only
if it passes the unchanged complete sequence comparison against the **original**
baseline and further reduces the current recent-return count. Comparing against
the original baseline prevents cumulative quality-budget drift. Outgoing stored
expression-motion metadata is refreshed when its predecessor changes.

The implementation limits frames, event count, interval length, inspected
candidates, scored proposals, gate comparisons and accepted patches. Invalid
explored input rolls back to the original array; a work cap retains only fully
verified repairs and reports incomplete exploration. Neither cap exhaustion nor
invalid input occurred on this recording. Supplied candidates and matching
errors are expected to come from a validated catalog/ranker; this experiment's
catalog audit verifies descriptor/layout provenance and image addresses.

The standalone audit and benchmark scripts are:

- `scripts/analyze-history-full-catalog.mjs`: exact full-catalog admissibility,
  input identity, descriptor checks and exhaustive sequence-count bounds.
- `scripts/benchmark-history-repair.mjs`: exact replay, deterministic output,
  immutable fallback, complete selector timings and repair-only timings.

## Quality criteria

The established engineering budgets were **not relaxed**. Each frame allows
at most +0.003 strict error, +0.003 in each of nine local expression errors,
and +0.5 degrees of absolute error on each yaw/pitch/roll axis. The local errors
cover mouth, mouth shape, both individual eyes, aggregate eyes, brows, wink,
blink and worst-local error.

The existing aggregate fidelity, objective and input-relative motion guards,
accepted-frame counts, switch counts and short-run guards remain in force.
Recent returns must strictly decrease; total returns must not increase.
See the earlier report for every numerical aggregate and speed budget.
These budgets are conservative engineering choices, not calibrated perceptual
thresholds or a guarantee that the existing baseline is visually ideal.

## Comparison on the identical captured video

Consecutive identical IDs form one run: A-A-A has no reappearance; A-B-A has one.
Recent returns use input-video time and a window of less than two seconds from
departure. The terminal single-sample run is covered separately from completed
run duration. Lower numerical errors/residuals are better.

| Metric | Current selection | Local repair, current ranked beams | Local repair, full-catalog admissible beams |
| --- | ---: | ---: | ---: |
| Detected-face/output frames | 410 | 410 | 410 |
| Unique images | 134 | 134 | 134 |
| Total reappearances | 19 | 19 | 19 |
| Recent reappearances, under 2 seconds | 14 | 14 | 14 |
| Image switches | 152 | 152 | 152 |
| Mean strict face-matching error | 0.142778864 | 0.142778864 | 0.142778864 |
| Strict error p95 | 0.433582698 | 0.433582698 | 0.433582698 |
| Mean coarse motion residual | 0.058742927 | 0.058742927 | 0.058742927 |
| Mean expression motion residual | 0.029329655 | 0.029329655 | 0.029329655 |
| Mean pose motion residual, degrees | 4.089751830 | 4.089751830 | 4.089751830 |
| Changed image decisions | — | 0 | 0 |

Both trial paths return the exact original array and the original sequence hash.
All fidelity and continuity metrics therefore remain identical. Both reject
adoption for `recent-reappearances`: no measured reduction exists. The current
beams require 2,535 inspected records, with 1,670 fidelity rejections; the full
admissible beams require 42 inspected records. All 14 recent events are examined.
No interval survives the original per-frame constraints, so no proposed patch
reaches the final sequence gate. This is a completed negative experiment, not
a malformed-input or work-cap fallback.

## Full 70,000-photo feasibility result

The audit reads all 775 shards one at a time and decodes descriptors with the
existing `liveCandidateFromEntry`. All 70,000 entries, IDs and image addresses
are distinct; decoding failures, invalid records and duplicate IDs/addresses
are zero. Image pixels are not decoded for a perceptual duplicate-image audit.

The saved snapshot has 5,025 candidate **records** representing 5,023 image IDs.
Two IDs occur as both ordinary catalog and wink-support references; their
numerical descriptors are identical. All 5,023 saved unique descriptors, including
feature vectors, geometry and layout, match the original catalog with maximum
difference zero. Recomputed baseline scores also match in every component.

The scan covers all **28,700,000 frame/candidate pairs**. An exact early test of
the same three pose-axis limits excludes 28,590,114 pairs; the remaining 109,886
pairs are evaluated with the original `projectionError`. No pose-window search,
approximate index, top-K limit or history pruning is used in this audit.

Only 424 frame/candidate pairs pass the original per-frame limits: the 410
baseline choices plus 14 alternatives across 12 frames. No admissible candidate
is added outside the original ranked beams. Every frame's admissible ID set is
identical to the earlier restricted search. The saved admissible snapshot has
140 unique candidate IDs.

Ten frames have two choices and two have three. The full Cartesian product has
`2^10 * 3^2 = 9,216` sequences, all of which were enumerated. Aggregate and motion
limits were deliberately omitted, so this is a **larger** set than the set of
sequences that could pass the complete quality gate.

| Count | Current sequence | Minimum across all 9,216 sequences |
| --- | ---: | ---: |
| Recent reappearances | 14 | 14 |
| Total reappearances | 19 | 19 |
| Switches | 152 | 152 |

Consequently, for these fixed 410 detected-frame descriptors, the original
70,000-descriptor catalog, the existing error formulas and the unchanged
per-frame caps, **no alternative image-selection sequence can reduce the measured
return counts**. This does not establish impossibility for other recordings,
different descriptors/rendering transforms or different quality criteria.

## Processing-speed comparison and limits

Measurements use Node 24.19.0 on one Linux x64 environment, after equal warmups.
There are six interleaved samples per mode; parsing, hashing and assertions are
outside timed calls. The complete candidate selector includes the original
optimizer plus repair, validation, proposal work, comparisons and fallback.

| Timed path | Current selector median | Current selector + repair median | Repair alone median |
| --- | ---: | ---: | ---: |
| Existing ranked beams | 2375.491 ms | 2262.514 ms | 19.907 ms |
| Offline full-catalog admissible beams | 2420.043 ms | 2378.321 ms | 17.354 ms |

These are **sequence-selection times after video capture and candidate ranking**,
not complete video processing times. The second row additionally excludes the
offline full-catalog decoding and admissibility scan; those prepared candidates
must not be treated as a free runtime input. The first row needs no additional
candidate preparation because it uses the original ranked beams.

The lower sampled complete medians do not establish a speed improvement: the
original optimizer is unchanged, sample ranges overlap, and repair performs
measurable additional work. Runtime/JIT/GC and host variation remain visible.
The approximately 20 ms repair cost does not buy a quality improvement on this
recording, so neither timing row justifies adding it to production.

No fresh end-to-end video timing, changed-output visual review, physical-camera
test or hosted-Site verification was performed in this follow-up. The previous
ABBA browser result belongs to the earlier beam-history experiment and is not
relabelled as a result of this repair. A future passing proposal still requires
complete browser timing and inspection around its changed runs before adoption.

## Reproduction and evidence

On the experiment branch, use the exact prior snapshot and its sibling
`baseline-capture.json` from the prior comparison artifacts. If those artifacts
are unavailable, the existing `scripts/verify-video-history.mjs` and its workflow
describe how to capture the fixed recording again; verify the new capture's
identities and decisions before treating it as equivalent evidence.

```sh
node --experimental-strip-types scripts/analyze-history-full-catalog.mjs \
  /absolute/path/same-video-ranking-snapshot.json.gz /absolute/path/full-audit
node --experimental-strip-types scripts/benchmark-history-repair.mjs \
  /absolute/path/same-video-ranking-snapshot.json.gz /absolute/path/comparison.json \
  /absolute/path/full-audit/admissible-beams.json.gz
```

The full audit emits shard inventory/hashes, admissible beams, new-candidate
evidence and exhaustive counts. The comparison records every timing sample,
all summary metrics, changed decisions and sequence hashes, source file hashes,
input hashes and rejection reasons.

## Final validation

`npm run build` completed successfully, including the Sites artifact validation.
All 62 unit-test files completed with **325 passed, zero failed, cancelled or
skipped**, including 11 new local-repair tests. The complete TAP plan and summary
were verified, using Node 24.19.0 and `--test-concurrency=4`. Two earlier runs
with the default concurrency returned zero but lacked the terminal TAP summary;
they were not accepted as complete test evidence. No source changes were needed
for the complete bounded-concurrency run.

The new tests cover continuous holding and history expiry, all three repair
types, component fidelity limits, sequence rejection, outgoing transition
metadata, immutable fallback, cumulative budgets, deterministic ties, invalid
input and bounded work. These tests exercise successful synthetic repairs even
though the fixed recording has no admissible repair.

An additional standalone strict TypeScript check is **not clean**: both the
original history module and the new repair module report the same existing
`TS7053` diagnostic at `app/face-actions.ts:73`. That file is byte-identical to
the current upstream. The build passes; no full strict-type-check success is
claimed, and no unrelated matching code was changed to hide this diagnostic.

Nineteen protected source/input files were verified byte-for-byte against
`f8a1e0e004b00b7a44bfbc107ff0c2ec6b4f13b1`, including both review clients, their
Worker, face presentation, realtime components, dependencies and the fixture.
The catalog tree is unchanged, projection mathematics differs only by the prior
five exports, and no production entrypoint imports the history experiments.

Durable evidence:

- [Full-catalog audit](evidence/video-history-full-catalog-2026-10-10.json)
- [All-shard inventory and hashes](evidence/video-history-full-catalog-inventory-2026-10-10.json)
- [Quality and timing comparison](evidence/video-history-repair-comparison-2026-10-10.json)
- [Build, tests and protected-source checks](evidence/video-history-repair-verification-2026-10-10.json)
