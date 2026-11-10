# Full video pipeline verification

This verification measures the ordinary `/live` upload and review workflow against the fixed baseline commit `00ef55256144c87e6dd642e1815a8f4071372c0e`. It is an implementation comparison, not evidence of superiority over other face trackers or of expression accuracy on unseen people.

## Fixed inputs and scope

The input is the existing, publicly shipped `public/demo/many-faces-sample-30fps.mp4`. Its SHA-256 is `78751af233f949f0559f315f2c6efd001cb5981a294e081c7530ccf68f3dac26`. It is a 1,061-frame, 30 fps, approximately 35.37-second protected composite. It contains no private source recording. The harness uploads the entire file and verifies the UI's default 30 fps and the planned sample count. It does not seek a more favorable input, shorten the video, reduce the analysis density or mock inference.

All baseline-tracked `public` assets must remain identical. The sole permitted addition is `public/licenses/mediabunny.txt`, the new decoder dependency's license notice; CI verifies that it is an addition and excludes only that exact path from the asset equality check. Both builds use the complete 70,000-entry seed catalog. The improved build generates its compact catalog through the normal build script and must retain 70,000 admitted entries. Removing unused fields is measured as part of the implementation change; equal network bytes are not an acceptance requirement.

## CI trigger and runtime

`.github/workflows/video-pipeline.yml` uses `pull_request`, with source-path filtering and an additional condition restricting both jobs to the same-repository branch `improve/video-pipeline-20261110`. Opening, reopening or updating that branch's PR against `main` starts the workflow. This allows the new workflow to be tested before it is merged into the default branch. It does not use `pull_request_target`. The optional manual trigger is restricted to the same branch; `workflow_dispatch` is available only after the workflow exists on the default branch.

The checkout uses the PR's head SHA rather than treating the synthetic merge commit as the tested source. Permissions are read-only. No deployment, repository write or secret is required. A newer run cancels the older run for the same PR.

The primary job uses one ordinary `ubuntu-24.04` hosted runner, Node 22.16.0 and an isolated `playwright@1.56.1` installation from `https://registry.npmjs.org`. It uses the runner's installed Chrome executable and records the actual browser version. The browser version can change between CI runs; before/after within a run use the same executable and flags. This workflow does not modify browser access controls or work around restrictions in another execution environment.

Each application installs its own lockfile. The baseline is a detached sparse worktree of the fixed commit; its original public entries link to the already verified, unchanged assets. This avoids another checkout copy of the large catalog. The new compact catalog is not linked into the baseline. Both applications run their unchanged production build commands sequentially and are served by `vinext start` on ports 4185 and 4183. Normal build output still includes its public assets. Unit and integration tests run after the build because some tests import the generated worker directly. CI verifies both runtime revisions before the browser trials and checks that verification did not rewrite application source.

The primary job has a 45-minute limit. The browser harness has an internal total budget of at most 24 minutes, reduced when setup took longer so that five minutes remain for final evidence. Each full-video trial also has an eight-minute limit. Exceeding a budget fails the run; it does not turn a partial video into a passing result.

## Ordered production trials

All production trials run sequentially on the same runner. Each cold trial starts a fresh Chromium process and context. The warm trial retains the immediately preceding page and worker. Server and operating-system caches are not reset, and the order is fixed.

| Order | Configuration | Purpose |
| --- | --- | --- |
| 1 | Baseline, ordinary `/live` | Record the original full pipeline |
| 2 | Improved, `mfDecoder=video-element&mfFaceMode=IMAGE&mfFaceDelegate=CPU&mfFaceExecution=main-thread` | Compare the legacy acquisition/inference policy with the improved matcher and catalog path |
| 3 | Improved, ordinary `/live` | Measure the shipped default pipeline and record any acquisition drift |
| 4 | Improved default, same page and file selected again | Exercise retained decoded catalog state and a real repeated run |
| 5 | Improved default, a separate context with an actual shard request held, then cancelled and retried | Verify cancellation and a complete subsequent run; exclude this from cold timing claims |

The observer records the worker's actual sampled times, feature vectors, projection geometry, layout and roll compensation flag. Unused structure and surface arrays are excluded. It then compares every choice's ID, time, complete error object, emission, acceptance and expression-motion value. `-0` and non-finite values retain distinct representations. Legacy messages and `jobId`/`runId` protocols are supported.

The legacy-acquisition comparison must have exactly equal matcher inputs and complete decisions. A different decoded input under the default policy is reported separately: shared sample times, numeric difference counts and magnitudes, changed IDs and changed acceptance counts. It is not mislabeled as an exact matcher comparison. Whenever two trials do have equal inputs, unequal decisions fail the comparison.

Each completed trial also requires the application's verification gate, zero failed selected images, a visible output canvas, working playback/pause/frame-step and successful seeks to the end and back to the start. Canvas checks read rendered pixels independently of the application's own boolean. A held real catalog request must cancel to idle within five seconds, produce no late successful result, and allow a complete subsequent upload.

The full file is already a processed composite. Its results do not establish behavior on the user's private recording, physical phone, Safari or other video codecs. A single ordered run per configuration is diagnostic evidence. Do not present its timing ratios as a statistically established speedup or independent motion-quality validation. Input/output observation overhead is recorded and included in UI timings.

## Separate component job

A second job runs on a different hosted runner, so its model work does not compete with the production timing comparisons. It uses only the improved source with a Vite development server on port 4186. The component probe imports the actual TypeScript modules; it is not a production end-to-end timing benchmark.

It compares the full 1,061 CPU samples for IMAGE on the main thread, IMAGE in a worker and VIDEO in a worker. GPU variants are explicitly limited to the first 60 samples. It also generates small synthetic media fixtures with FFmpeg to check decoder timestamps and rotation. The component probe has a ten-minute internal deadline and its job has a fifteen-minute limit. Its report states the actual execution/delegate/fallback choices and distinguishes decoder pixel equality from the CPU main/worker equality acceptance criterion.

## Evidence and publication

The production harness writes detailed, local diagnostics under `work/video-pipeline`, including the complete arrays needed for exact comparison. **Do not upload that directory as a whole.** These arrays are not part of the public CI artifact.

CI uploads only `work/video-pipeline/publish/`:

- `summary.json`: aggregate counts, input/output hashes, timing phases, cache/search metrics, equality conclusions, controls and failure summaries.
- `input-metadata.json`: fixture/catalog/model hashes, fixed source revisions and compact catalog counts.
- `identity-4183.json` and `identity-4185.json`: actual production runtime identities.
- `receipt.json`: the exact step outcomes, including skipped/failed stages.
- Trial screenshots of the already public composite, after review or on failure where available.

The component job uploads only `work/video-pipeline-components/publish/`, which contains aggregate summaries, progress and its execution receipt. Raw landmark arrays, feature vectors, per-frame choices, private recordings, browser traces and arbitrary work files are not included. Artifact retention is seven days. A failed or incomplete run remains failed; any partial report is diagnostic evidence, not acceptance.

## Local invocation

With the two production servers already running and Playwright available to Node, run:

```sh
CHROME_PATH=/usr/bin/google-chrome node scripts/verify-video-pipeline.mjs
```

Supported options are `--mode all|exact|default|cancellation`, `--baseline`, `--improved`, `--out`, `--timeout-ms`, `--budget-ms` and `--skip-cancel`. The defaults are ports 4185/4183, a fifteen-minute per-trial limit and a thirty-minute total budget. The fixture and 30 fps density are deliberately not configurable. Local diagnostics are retained; use only the `publish` subdirectory when sharing an aggregate result.

The component job's equivalent invocation uses `COMPONENT_ORIGIN=http://127.0.0.1:4186`, `COMPONENT_FRAME_LIMIT=1061`, `COMPONENT_GPU_LIMIT=60` and `COMPONENT_TIMEOUT_MS=600000` with `node scripts/verify-video-components.mjs`.

## Workflow references

- [GitHub Actions pull_request and workflow_dispatch events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Playwright continuous integration guidance](https://playwright.dev/docs/ci)
