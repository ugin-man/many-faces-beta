# Video image reappearance experiment

Status: experimental and not connected to the video Worker. Initial quality
screening rejected all four declared weights; full-video fallback timing is
being completed before recording the final decision.

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

The follow-up `scripts/analyze-history-feasibility.mjs` is explicitly exploratory:
it filters each captured beam using the original per-frame error/local/pose
budgets, retains the baseline, and tests 14 combinations of weights and history
counts. It does not change the catalog, ranker or acceptance thresholds. Its
conclusions concern the captured ranked beams, not an exhaustive search of all
70,000 photos. Final timings and the adoption decision will be recorded below.
