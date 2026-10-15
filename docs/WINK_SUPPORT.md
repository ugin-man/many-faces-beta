# Recorded-video wink support — 2026-10-05 JST

## Scope and deployment boundary

Repository: `ugin-man/many-faces-beta`. Canonical development branch: `astra/realtime-hardening`, draft PR #3 against `work/coverage-driven-200k`. The experiment was developed and tested on `astra/wink-coverage` before integration. No base/main merge or hosted Work Site rebuild was performed.

Verified application commit: **`149200d521f04ab96300ad0f9902dc721dfe46c0`**. Application build: **`9902e78e96670c77`**. Subsequent documentation-only commits do not change that application build. The older `camera-arrival-v3` version label alone does not identify this change.

This pass reinforces recorded-video wink matching. Camera inference, arrival/lifecycle handling, video frame acquisition, the CPU model, source resolution, sample density, shared error formulas, sequence optimizer and reference assets are unchanged. The only shared UI change is a video-only credit link inside the existing image-information/diagnostics sheet. No new mode, tab, concept copy or lightweight product was added.

**This is a deliberate matching-policy change, not an identical-output speed optimization. Correct eye state can come at the expense of mouth or pose similarity. Physical-camera wink recovery and general perceptual improvement are not established.**

## Why adding images alone was insufficient

The initial strong blink-score screen found only nine left and three right candidates inside the frontal original search window. Those counts use a different threshold from the later geometry-corroborated screen; they must not be presented as a direct before/after comparison with the new index.

The original single-factor catalog policy rejects sufficiently strong combined wink/mouth activity, including wink plus smile/open mouth, rather than covering every expression combination. The original builder and its accepted assets are retained here. The new supplementary screen does not impose that single-factor mouth exclusion.

Six real-photo additions alone changed none of six source-photo-held-out winners in the initial pilot. Reanalysis also found differences between some stored descriptors and fresh estimates from the exact delivered image bytes. This does not prove every old descriptor is wrong: preprocessing, crop and inference differences can affect estimates. It means old values cannot be treated as independent visual truth.

The successful intervention is mainly recovering usable original photographs and admitting an explicitly eye-state-compatible pool when the source contains a corroborated wink, not inflating the image count.

## Assets: 70,000 originals plus six photographs, not 277 new images

The original catalog remains byte-for-byte unchanged, including its original descriptor files: Git subtree **`559f7f39e3a8eed452ef7eb6a3355a318235c307`**. The existing reference recording remains unchanged, SHA-256 **`d470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b`**.

All 70,000 stored records were screened. A combined action/eyelid screen selected **562** original photographs for fresh CPU-model inference on their actual encoded pixels. **271** again met the combined criterion. This is not a fresh inference run over all 70,000 images. The 271 fresh descriptor records are an overlay pointing at the same original image ranges; no original image or original descriptor file is overwritten.

A separately attributed pilot contributes **six** real photographs, three anatomical-left and three anatomical-right winks, totalling 239,604 encoded image bytes. The resulting index contains **277 records: 151 left, 126 right**, comprising 271 original-photo references plus six additions. The available photographic corpus therefore contains **70,006 photos**, not 70,277. Index JSON size is **2,055,320 bytes**.

The original-photo references and image bytes for all 277 index records were checked against stored SHA-256 values. Core image pack/offset/length references were checked against the unchanged original catalog. The six additions had no exact encoded-image hash duplicates in the original catalog in the pilot audit. This is not a guarantee against visually similar photos or repeated people.

New data are under `public/wink-support/v1/`. Per-image creators, source URLs, licenses, image hashes and changes are retained in `catalog.json` and `ATTRIBUTION.html`. Additions are actual photographs, face-cropped/resized/WebP-encoded, not mirrored, warped or expression-synthesized. Copyright licenses are not blanket personality/model-release consent. Only one original external source image was visually inspected during this pass; the added crops, full overlay corpus and generated browser screenshots were not visually inspected. These remain automatically screened assets, not independently human-labelled winks.

Historical `data/wink-pilot` and `data/wink-core-refresh/audit.json` are immutable staging receipts; their `notYetRuntimeEnabled` fields describe the stage when those files were generated. The current video worker consumes the public overlay.

## Runtime behavior

`wink-evidence.ts` requires agreement between asymmetric blink action values and asymmetric eyelid aperture, with finite geometry and a bounded source pose. Anatomical eye sides are used; viewer mirroring does not change the matching convention. Blendshape values are raw model outputs, not calibrated confidence probabilities. No raw values are edited to manufacture a stronger wink.

If the recording has no positive wink evidence, no supplemental index is requested. Positive recordings request the same-origin optional index once, with a 4 MiB body limit, a five-second idle limit and a ten-second overall limit. Real byte progress is reported. A missing/invalid index records a diagnostic and falls back to the existing original-catalog matcher rather than breaking video verification.

For a corroborated wink, `rankWinkSupport` admits fresh same-side photographs inside the existing pose bounds: prefer 12/15-degree yaw/pitch differences, otherwise allow the existing expanded 18/21-degree bounds. The unchanged detailed scorer ranks that pool. This explicitly prioritizes the closed-eye state and changes candidate admission. It does not merely append photographs to an otherwise unchanged all-face ranking.

Negative, bilateral-blink, ambiguous and unsupported frames call the original matcher. The sequence optimizer is unchanged, but changes to positive-frame candidate beams can affect neighboring final sequence choices; do not promise byte-identical final output on every non-wink frame of a mixed recording.

The worker reports requested/supported/fallback wink frames, indexed originals, added photos, index bytes and index errors in `performanceMetrics.wink`. Optional-index loading precedes the existing `candidateSearchMs` timer; phase timers are not an additive wall-time decomposition. No speed gain is claimed in this quality pass.

## Held-out still-photo evaluation

[Index run 37226693520](https://github.com/ugin-man/many-faces-beta/actions/runs/37226693520), commit `33a783c9858cddd6b342668595bf5772e71ddc71`, completed the helper/data evaluation. Thirty source queries were used: the six external photos and twelve near-frontal original photos per anatomical side. Each query photograph and matching source URL were excluded from its candidate pool. This is source-photo holdout, not person-disjoint evaluation; the queries were selected with the same automated criterion used by the support path.

| Candidate policy | Same-eye-state top result / 30 | External queries / 6 |
| --- | ---: | ---: |
| Original matcher | 4 | 0 |
| Fresh/additive records, original unrestricted ranking | 6 | 1 |
| Eye-state pool using refreshed originals only | 30 | 6 |
| Eye-state pool using refreshed originals plus six additions | 30 | 6 |

Fresh inference on the actual selected photograph bytes also produced the expected same-side evidence in 4/30 old outputs and 30/30 final outputs. This is a consistency check with the same model/criterion, not independent perceptual ground truth. Forty ordinary-input helper cases were exact no-ops.

Tradeoffs in this selected cohort are material:

| Mean error; smaller is better under the existing scorer | Original | Final |
| --- | ---: | ---: |
| Absolute yaw difference | 3.62 degrees | 4.98 degrees |
| Absolute pitch difference | 3.59 degrees | 6.29 degrees |
| Mouth geometry error, normalized | 0.07268 | 0.10469 |
| Total existing matcher error | 0.09673 | 0.12907 |

Do not describe the result as improved overall facial similarity. The gain is preservation of the input eye state in this selected automatic test; broader quality/false-positive sensitivity requires new labelled motion data and visual comparison.

Evidence artifact: [11312108434](https://github.com/ugin-man/many-faces-beta/actions/runs/37226693520/artifacts/11312108434), GitHub-reported SHA-256 `c92c56aae177d045d6fbcaa1ca59010d9e4f7d05f50b6997b62d4ace6fe9f779`. Logs were read; no local archive-hash or screenshot inspection is claimed.

## Actual production-browser video acceptance

[Completed run 37227084067](https://github.com/ugin-man/many-faces-beta/actions/runs/37227084067), job 111508862936, tests the exact current application commit **149200d**. All steps passed: build, **180 tests with zero failures/skips**, lint, preserved-source checks, actual video UI, source-photo exclusion, missing-index recovery and cancellation. Lint success is not a claim of no pre-existing warnings.

The complete 23.3-second reference was processed before and after at unchanged 20 samples/second. Both acquired descriptor arrays match; each has 466 planned positions and 410 detected/sequence frames. The new result selected 144 photos rather than 141 and made 156 rather than 153 changes, with zero image-load failures and nonblank output. The source gate found 16 positive wink frames; fresh analysis of their actual selected output photographs preserved the same anatomical eye state in **16/16**, across four selected photos.

Full-reference mean yaw error changed 4.4572 to 4.5846 degrees, pitch 3.0502 to 3.2855 degrees, mouth error 0.11699 to 0.11857, eye geometry error 0.027245 to 0.026455 and total matcher error 0.14569 to 0.15069. Again, eye-state recovery is not whole-face-quality certification. Logical received JSON body bytes increased from 417,215,798 to 419,271,118, exactly the added 2,055,320-byte index. Original shard count (722) and decoded original count (67,131) remain the same in that recording.

A second test encodes the six external still photographs into an actual MP4 and runs the normal video UI, while withholding ALL six added photos from the served support index. All 120 positions were detected and returned. The source wink rule activated on **100/120** frames; all **100 activated frames** selected original-catalog photos whose fresh pixel analysis preserved the same eye side. The remaining 20 frames did not activate the wink gate and used the ordinary matcher. This does not establish a 100% wink detector and the stimulus is changing still photos, not a human performing a continuous wink.

A third test returns 404 for the optional index. All 21 sampled frames complete through the original matcher, with zero image failures, recorded index error, zero supported frames and 21 fallback frames. The output still does not reproduce the wink in this fallback test; only functional recovery is established.

Actual playback, pause, frame stepping, matching server/client/worker build IDs, and the visible source/license link passed. With four real original-catalog requests pending, Cancel returned to idle in **24 ms**, without a false successful report, late restart or uncaught page errors. Existing camera/input/watchdog code was not changed.

The before/after wall times in this run were 69.301 and 65.539 seconds, one trial per version on this runner. This is NOT an ABBA speed benchmark and must not be compared directly with earlier 93-second measurements from another run.

Runtime artifact: [11312610802](https://github.com/ugin-man/many-faces-beta/actions/runs/37227084067/artifacts/11312610802), 3,697,181 bytes, GitHub-reported SHA-256 **`709c23e4d42557778557d6b01c112381398f2c88a54567cd47f5a91c88bf3c72`**. Completed logs/artifact metadata were read; local archive verification and screenshot inspection were not possible and are not claimed.

## Work Site handoff and remaining gates

Use the existing Work Site and canonical development branch. Include **both code and `public/wink-support/v1/` data/credits/images**; updating only the worker omits its new asset dependency. Preserve host-specific configuration, the full 70k core, reference recording and two-mode interface. Rebuild client/server/workers together and check matching build identities. A source-identical build reports **9902e78e96670c77**; a legitimate host-specific source change may alter the fingerprint, but its components must still agree. Git updates do not rebuild the hosted Site automatically.

This reinforcement is video-only. The now-working physical-camera milestone remains untouched; it does not acquire this wink behavior through this patch. New continuous left/right wink recordings, independently labelled open/blink/squint/wink cases, visual whole-face similarity, temporal flicker/false activation, other poses, Safari and long sessions remain release gates. Correct eye state is a targeted improvement, not a claim that tracking is finished.
