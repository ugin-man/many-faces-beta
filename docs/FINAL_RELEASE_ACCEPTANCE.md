# Many Faces — final release acceptance status (2026-10-08 JST)

## Scope and immutable release reference

Repository: `ugin-man/many-faces-beta`, branch `astra/realtime-hardening`.
Published Site v55: https://many-faces-prototype.uginn-poppo.chatgpt.site/
Published catalog ID: `many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1`.
Published manifest SHA-256: `fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a`.

Do not confuse the current branch HEAD (which includes QA-only changes) with the deployed Site source revision. The Site v55 record pins source commit `da44953c7b671d2826d3ff4b1645a508545b22d6`, build `8b57a414f760f03f` and the published catalog. Git commits do not automatically update an already deployed Site.

## Confirmed

- Promoted clean catalog contains 70,000 physically verified, distinct WebP photographs across 775 pose cells. It does not require the temporary runtime exclusion overlay.
- All known failed/uncertain photos from the earlier 360-photo visual holdout were absent from the promoted catalog; 59 final replacement originals were separately reviewed and passed.
- Face-position/size following, optional face-only mask, paired mirror, two-mode fullscreen UI, fixed reference video, virtual camera, and 70k access were preserved by native QA.
- Published Site v55 was exercised by native Chromium in GitHub Actions run [37533389396](https://github.com/ugin-man/many-faces-beta/actions/runs/37533389396): real 23.3-second recorded-video analysis completed with nonblank output and no image failures; virtual camera produced output and media tracks were released.
- Latest pre-holdout branch CI run [37535991781](https://github.com/ugin-man/many-faces-beta/actions/runs/37535991781) passed.

## New independent post-publication holdout (not yet reviewed)

- A deterministic **fresh 360-photo** sample was generated from exact published catalog image bytes, excluding 2,046 previously inspected encoded-image hashes. Sampling is challenge-stratified and **not** an unbiased prevalence estimate.
- GitHub Actions run [37755367013](https://github.com/ugin-man/many-faces-beta/actions/runs/37755367013) passed and produced artifact `final-clean70k-holdout-37755367013`: 12 contact sheets and 360 original WebP images, plus SHA-bound sample metadata.
- Strata: center 120, left 100, right 100, expression challenge 40.
- Earlier run [37755309424](https://github.com/ugin-man/many-faces-beta/actions/runs/37755309424) also produced a 360-image sample with a wink-focused challenge stratum. It is a separate sample, not evidence of a passing visual review.
- Both artifacts explicitly say `status: unreviewed`. **A successful sampling workflow does not mean all photos passed visual quality review.**

## Not complete / release gate

1. Independently inspect the new sample originals/contact sheets for dark eyewear, face masks, unreadable eyes/mouth, incorrect facing direction, and unacceptable photographic quality. Distinguish normal clear glasses and readable face paint from forbidden occlusion. Bind decisions to original image hashes.
2. If any defect is found, exclude the exact original image before catalog selection, refill the slot with an independently reviewed qualified photo, regenerate 70,000 and rerun native QA and Site checks. Do not patch over defects using a runtime overlay.
3. Repeat an independent holdout after any corrective promotion; do not recycle the same reviewed sample as a new holdout.
4. The published native browser run needed **303.7 seconds** to process the 23.3-second fixed recording at 12-fps analysis density. This is a serious performance limitation, not a failure of output correctness. Candidate search consumed about 259.3 seconds and 496.8 MB of decoded/received search traffic. A release quality goal should explicitly decide whether this delay is acceptable or whether a compact search index is required.
5. A separate cloud-browser environment failed WebGL initialization before analysis; native Chromium succeeded. Real iPhone/Windows camera hardware and Safari are not verified by the published CI.
6. Latest Site deployment has not been re-published by this QA-only change.

## Post-publication independent visual review update (2026-10-09 JST)

- The fresh 360-image contact-sheet sample from run 37755367013 was visually screened. **This holdout failed**; the Site must not be called fully quality-certified.
- 21 suspect originals were then examined in enlarged contact sheets. The original thumbnail screen produced false positives: 11 were cleared after inspecting enlarged original pixels (including clear glasses and visible mouths), **7 were denied**, and **3 remain uncertain/quarantined**. The other 339 have contact-sheet screening only, not individual original-photo approval.
- Exact selected image IDs and SHA-256 are pinned in `data/catalog-quality/final-holdout-remediation-20261009.json`; 10 distinct original photographs must be excluded **before** next candidate selection, then replaced by reviewed qualified originals to restore exactly 70,000 photos.
- Review provenance: `data/catalog-quality/final-holdout-contact-review-20261009.json`; original enlarged-image binding workflow run [37802667173](https://github.com/ugin-man/many-faces-beta/actions/runs/37802667173).
- **No replacement catalog has been built or published for these 10 new exclusions.** Site v55 remains the last verified functional deployment, but still contains the identified photographs. A further independent holdout is mandatory after any replacement.

## Release decision

**Functional release candidate: yes. Fully quality-certified final release: no.**
Do not report final quality acceptance until the independent visual review and any remediation are complete. Do not discard the working v55 deployment while reviewing the dataset.

Source of truth: `data/catalog-quality/site-publication-v55-37533389396.json`, `data/catalog-quality/clean-core-promotion-37525826052.json` and the exact workflow artifacts linked above.
