# Video image reappearance experiment

**Decision: not adopted.** Both complete video comparisons finished successfully,
but none of the four declared history weights passed the quality gates. The
trial remains disconnected from the video Worker. A successful CI run is not
an adoption decision; the final report records `adoptionAccepted: false`.

The trial implementation and reproducible scripts are on
[`astra/video-history-selection`](https://github.com/ugin-man/many-faces-beta/tree/astra/video-history-selection).
Only this report and evidence are recorded on the current
`astra/realtime-hardening` branch. The current runtime and published Site v56
keep their original selection code.

The [2026-10-10 JST full-catalog follow-up](VIDEO_HISTORY_FULL_CATALOG.md)
adds a bounded, baseline-preserving local-repair prototype and checks all 70,000
catalog descriptors. It is also **not adopted**: under the unchanged per-frame
quality limits, all 9,216 possible admissible sequences retain at least the
baseline's 14 recent and 19 total reappearances. The follow-up's implementation,
tests and reproducible scripts are on `astra/video-history-full-catalog`; the
current branch receives its report and evidence only.

## Fixed source and scope

The comparison baseline is `04a41b80469980454758feba9a31ac48b92c11fd` on
`astra/realtime-hardening`. Existing Site v56 source is
`09ae2f991245cf6a3c899e874750578eba0ebfa7`; its application matches this upstream
apart from Site navigation. The Site's compact catalog delivery remains intact.

- Full catalog: `many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1`.
- Exactly 70,000 searchable photos, 3-degree cells, 775 cells.
- Full upstream catalog tree: `afcb8f68a8db87424fe5169896be0fd0a57dbf65`.
- Manifest SHA-256: `fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a`.
- Full 23.3-second recording: `public/test-fixtures/reference-face-motion.mp4`.
- Video SHA-256: `d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b`.
- Sampling remains 20 Hz with the existing full-resolution CPU Face Landmarker,
  decoded-frame capture, pose-window ranking and optional wink support.

No catalog records, pictures, sampling, UI, face-position/size presentation,
camera input, realtime path, watchdogs or dependency versions are changed.
The original projection optimizer is unchanged: five existing mathematical
helpers are exported for reuse, avoiding a second implementation of its loss.

## Experiment declared before measuring the video

`allowRepeats: true` currently disables the identity cooldown altogether. The
trial separates continuous holding from returning to a recently departed image.
History applies only to an actual change into a previously used image. There
is no random selection, reward for novelty or penalty on continuous holding.

The departure time is when the next image first appears. History expires after
2 seconds of input-video time; its nonnegative cost halves every 0.75 seconds.
The fixed candidate weights are `0.001`, `0.003`, `0.01` and `0.03`. A new
optimization starts with empty history. Invalid/non-monotonic times or disabled
history use the unchanged baseline. Face-detection gaps advance media time;
playback seeks use the already chosen sequence and do not restart selection.

The finite beam retains 24 distinct current images and up to two different
histories per current image. It is approximate search. Equal transitions reuse
the same geometry calculation. Zero weight executes the original function
directly, including its ordering and floating-point operations.

The runtime wrapper first computes the baseline. It adopts a trial only if the
deterministic quality comparison passes; otherwise it returns the original
baseline choices. This additional baseline work is included in speed reporting.

## Metrics and gates

Consecutive IDs form one run: A-A-A has zero reappearances; A-B-A has one.
All-period reappearances equal runs minus unique images. Recent reappearances
require returning less than 2 seconds after departure. Unique counts are
descriptive and are not a reward in the objective.

The trial must reduce recent reappearances without increasing all-period
reappearances, switches, completed runs shorter than 0.1 seconds, single-sample
runs (including the final run), or failed acceptance flags. The terminal run's
duration is unknown to the selector, so duration-based short-run counts describe
completed runs only. Single-sample runs separately cover that boundary.

Explicit conservative budgets, fixed before examining results:

- Original strict error, worst local error, mouth/eyes/brows/wink/pose errors,
  and the original objective excluding the history cost: mean at most +0.25%,
  p95 and maximum at most +0.5%.
- Input-relative coarse/expression/pose motion: mean at most +0.5%, p95 and
  maximum at most +1%. These residuals prevent a frozen image from masquerading
  as smooth tracking.
- Each frame: strict error increase at most 0.003; each mouth, mouth-shape,
  left/right eye, aggregate eye, brow, wink, blink and worst-local error increase
  at most 0.003; absolute yaw/pitch/roll error increase at most 0.5 degrees.
- Guarded selection median (baseline + trial + comparison) at most 2.25 times
  baseline plus 25 ms; end-to-end full-video median at most +10%.

These are declared engineering budgets, not perceptual just-noticeable
thresholds or statistical confidence intervals. Exact absolute values and
paired changes are reported. One fixed development video cannot establish
general perceptual quality across people, expressions, devices or cameras.

## Reproducible procedure

`.github/workflows/video-history-selection.yml` builds the exact original and
trial source on one runner, verifies protected source/asset identities, runs
the regression tests, then executes `scripts/verify-video-history.mjs`.

A separate diagnostic browser trial acquires the original full video through
the normal UI. A probe bundle appends the ranked frames/beams to a duplicate
progress message; the original client ignores that sequence number. Selection
math, ranking, data loads and original choices are unchanged. The capture's
wall time is not a performance headline. Its compressed snapshot is saved for
same-input replay; Node's original optimizer must exactly reproduce all UI
decisions, and zero-weight history must match it exactly.

All four fixed weights use those identical detected frames and ranked beams.
Every option records warmed baseline, raw history and full guarded selection
times (three samples each), including options rejected by the quality gates.
Passing configurations are ordered by recent reappearance count, then original
unpenalized loss, then weight. A winner is timed including the fallback guard.
If none passes, the declared default is timed with its exact baseline fallback;
passing timings cannot turn a rejected quality result into adoption.
The harness also runs full-video before/after/after/before trials with fresh Chromium
processes/profiles. During an unadopted experiment only the test worker's
selection call is substituted; normal application code is not rewritten in CI.
Once integrated, the harness uses the actual native Worker bundles instead.
All input hashes, selected IDs, numerical errors, timestamps, work coverage and
candidate traffic must match their same-input replay. Playback, pause, stepping,
seeking and existing pending-network cancellation are exercised too.

The cloud preview's existing CPU inference path currently fails while creating
its WebGL graph (`activeTexture`); this is also a baseline failure. Physical
camera and Safari verification are not claimed. The established GitHub
Chromium runner is used for actual video inference and comparison.

## Results

Initial screening: [run 37880499744](https://github.com/ugin-man/many-faces-beta/actions/runs/37880499744),
commit `c9aa5b5f1c30f8d71e107cbe7c3ecb7cf625b6fa`. The actual current baseline
contains 410 face frames, 134 unique images, 152 switches, 19 total
reappearances and 14 recent reappearances. None of the four declared weights
improved recent reappearance counts while passing the unchanged quality gates.

| Raw selection | Unique images | All reappearances | Recent reappearances | Switches | Mean strict error | Mean coarse motion residual | Mean expression motion residual |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current baseline | 134 | 19 | 14 | 152 | 0.142778864 | 0.058742927 | 0.029329655 |
| History weight 0.001 | 137 | 20 | 15 | 156 | 0.144610473 | 0.058901521 | 0.029209727 |
| History weight 0.003 | 137 | 20 | 15 | 156 | 0.144610473 | 0.058901521 | 0.029209727 |
| History weight 0.01 | 134 | 19 | 14 | 152 | 0.142778864 | 0.058742927 | 0.029329655 |
| History weight 0.03 | 133 | 20 | 14 | 152 | 0.142733697 | 0.058640250 | 0.029355817 |

Lower error and residuals are better. Residuals compare changes in output
landmarks/pose with the input's motion; they are not a subjective visual score.
All five paths have strict-error p95 `0.433582698` and maximum `1.161479766`.
The detailed per-component distributions and paired limits are in
[the immutable screening receipt](evidence/video-history-screening-2026-10-09.json).

Weights 0.001 and 0.003 increased mean strict error by 1.283%, increased
short/single-sample runs, and produced frame-local increases as large as
0.171432454 and pose-component increases of 10.2012 degrees. Weight 0.01
reproduced the original path exactly. Weight 0.03 improved mean strict error
by 0.0316% but increased total reappearances and exceeded local/pose frame
limits (0.071574314 and 2.2258 degrees). These are rejected outcomes, not
changes to the deployed video result.

The first screening measured the entire 410-frame optimizer on the same
captured inputs, with three warmed samples per variant on one runner:

| Weight | Baseline median, ms | Raw history median, ms | Full guard median, ms |
| --- | ---: | ---: | ---: |
| 0.001 | 833.4 | 767.8 | 1604.7 |
| 0.003 | 843.2 | 952.3 | 1790.5 |
| 0.01 | 870.9 | 962.0 | 1823.6 |
| 0.03 | 849.1 | 962.2 | 1828.2 |

These are optimizer totals, not per-frame p95 or complete browser processing
times. The guard includes original selection, trial selection and quality
comparison, even when it rejects the trial. Runtime/JIT/GC variation is visible
between batches, so small timing differences should not be treated as a
general speed gain.

The follow-up `scripts/analyze-history-feasibility.mjs` is explicitly exploratory:
it filters each captured beam using the original per-frame error/local/pose
budgets, retains the baseline, and tests 14 combinations of weights and history
counts. It does not change the catalog, ranker or acceptance thresholds. Its
conclusions concern the captured ranked beams, not an exhaustive search of all
70,000 photos. Only 12 of 410 frames have an admissible alternative (1.034
candidates per frame on average); all 14 weight/history-count combinations
return the baseline sequence.

All 9,216 combinations within those unchanged per-frame limits were also
enumerated, omitting the additional aggregate and motion gates. Even this
larger set has minimum recent reappearances 14, total reappearances 19 and
switches 152. Further history-weight or beam-width tuning within this captured
candidate set cannot produce a passing path. A future search experiment would
need to investigate admissible candidates outside the captured beams.

## Final full-video timing and regression evidence

Final comparison: [run 37881350146](https://github.com/ugin-man/many-faces-beta/actions/runs/37881350146),
tested experiment commit
[`4941d5242477e59793d8aa28fec12b54a647dff4`](https://github.com/ugin-man/many-faces-beta/commit/4941d5242477e59793d8aa28fec12b54a647dff4).
The first and final runs reproduced the same detected-input hash, baseline
choices, all four trial choice hashes, and every quality metric.

With no passing quality configuration, the complete browser comparison used
the declared default weight 0.003 and its **baseline fallback**. It therefore
measures the cost of computing and rejecting the trial, while rendering the
original image sequence. The experiment did not connect the native app Worker;
the harness substituted its test bundle. Production adoption is not implied.

| Fresh browser trial | Mode | Full-video wall time, seconds |
| --- | --- | ---: |
| A1 | Current original selection | 85.928 |
| B1 | History trial + quality check + baseline fallback | 88.445 |
| B2 | History trial + quality check + baseline fallback | 87.912 |
| A2 | Current original selection | 86.081 |

| Timing measure | Original | Guarded trial, including fallback | Change |
| --- | ---: | ---: | ---: |
| Full-video wall time, median of two fresh-browser trials | 86.004 s | 88.179 s | +2.53% |
| Complete selector, median of three warmed Node samples | 1434.2 ms | 3198.3 ms | +123.0% |

The complete selector includes original selection, history selection and the
quality comparison. The additional cost is absent from the unchanged current
runtime. Both declared speed budgets passed, but quality rejection still makes
`recommended: null`, `uiEvaluationMode: baseline-fallback`, and
`adoptionAccepted: false` final. Timing varies by runner, so do not mix the
first screening's Node timings with the final runner's browser timings.

Checks completed on the exact experiment source:

- Production builds, lint and all **314 tests passed**.
- Original and zero-weight paths match exactly; repeated trials are deterministic.
- All four browser trials use identical input frames and candidate traffic
  (722 files, 68,163 decoded candidates, 497,852,679 received bytes).
- All four return identical image IDs, times, numerical errors and choice hashes,
  with 410 output frames and no image failures or page exceptions.
- Playback, pause, frame advance and end-of-video seek pass. Final-frame
  before/after screenshots were inspected; this is not a full-clip subjective
  visual-quality review of a changed path.
- Pending-network cancellation returns to idle in **35 ms**, without a false
  success or late restart.
- The entire protected `app`, `worker`, `public` and dependency source matches
  the baseline except for the explicit experiment allowance. Projection math
  matches the original byte-for-byte after adding five export keywords.
- Exact enumeration independently reproduces all **9,216** admissible paths
  and minimum recent/all/switch counts **14 / 19 / 152**.

Durable receipts:

- [Complete final comparison](evidence/video-history-comparison-2026-10-09.json).
- [Constrained replay and exhaustive feasibility](evidence/video-history-feasibility-2026-10-09.json).
- [Cancellation verification](evidence/video-history-cancellation-2026-10-09.json).
- [Initial screening](evidence/video-history-screening-2026-10-09.json).

The CI artifacts additionally retain the compressed same-input ranking
snapshot, full per-frame trial errors/choices, browser screenshots and logs for
the configured 14-day retention. The checked-in JSON receipts do not expire
with the artifacts. Use the experiment branch's workflow for a fresh complete
run; the baseline, recording and catalog identifiers above remain pinned.

## Runtime preservation

The current `astra/realtime-hardening` branch receives documentation and
evidence only. The experiment code is retained on its dedicated branch; the
Site remains public v56 with source `09ae2f991245cf6a3c899e874750578eba0ebfa7`.
No production selection overhead or UI change is introduced.

The existing draw path applies each frame's geometry even when the image ID is
unchanged, so continuous image holding does not disable face-position or size
tracking. Those functions, their callers, the realtime/camera path and all
catalog/image data remain unchanged. Actual physical-camera and Safari
verification are outside the completed Chromium fixed-video comparison.
