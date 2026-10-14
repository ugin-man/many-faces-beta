# Many Faces — opposite-facing photograph investigation

Date: 2026-10-14 JST. Branch: `astra/realtime-hardening`.

## Automated audit results

- [Side-facing audit run 38429881411](https://github.com/ugin-man/many-faces-beta/actions/runs/38429881411): 4/4 partitions passed; **40,748** photographs with stored |yaw| ≥ 12° reanalyzed from their exact packed WebP bytes. **0** images met the strict opposite-sign discrepancy rule.
- [Near-frontal audit run 38431303716](https://github.com/ugin-man/many-faces-beta/actions/runs/38431303716): 4/4 partitions passed; **13,223** photographs with 6° ≤ stored |yaw| < 12° reanalyzed. **0** images met the opposite-sign rule.
- Total reanalyzed in these two audits: **53,971**. These tests compare stored pose against a new pass of the *same MediaPipe model*. Therefore zero discrepancies **does not establish that every photograph visually faces the correct direction**; a systematic model mistake can be reproduced by both passes, and |yaw| < 6° is not covered.

## Important unresolved user report

The user has personally observed a small number of photographs that appear to face opposite the expected direction when looking to the left side of the phone screen. **No offending image IDs have been identified, and no photographs have been replaced** as a result of this audit. Do not claim the dataset direction issue is fixed, and do not arbitrarily flip all yaw signs.

## Exact ID collection

The demo route now has a `誤画像を報告` control. At the offending video frame it downloads `many-faces-wrong-photo.json` with exact catalog image ID, stored yaw, frame yaw and video timestamp **without uploading the person's video**. On the original video review route, `画像情報・診断 → 診断データを保存` exports sequence IDs; combine with an offending time or screenshot.

Once the offending IDs are supplied, inspect their exact packed original photos, verify direction independently of the same pose classifier, exclude confirmed wrong-way originals *before catalog selection*, replenish with qualified alternatives to 70,000, run regression/independent holdout, and only then republish the existing Site.

## Flicker remediation

The demo composite now retains a fully protected previous frame across missing image, face-detection or video-decode frames. Initial gaps show a neutral slate. No gap path is allowed to draw uncovered video. The output remains an experimental privacy aid and must be visually reviewed for face leakage around the mask boundary.

## Additional all-catalog geometry and original-image review (2026-10-15 JST)

- [Run 38615464307](https://github.com/ugin-man/many-faces-beta/actions/runs/38615464307), commit `3e23994361c4a9693e384375da33da7ab07e3667`, measured roll-normalized 2D nose/eye/bridge offsets for **all 70,000** current originals, including frontal cells. These landmarks still share the original detector, so the offsets only prioritize review rather than independently certify pose.
- Exported 111 SHA-bound originals: 1 strong geometry contradiction, 60 side candidates, 30 near-frontal candidates, and 20 convention references. All six contact sheets were visually screened; D001 and D080 were additionally inspected as exact original images. The reference photos agree with negative yaw facing viewer-left and positive yaw facing viewer-right in unmirrored pixels.
- The single strong metric suspect, `clean-v5-f8bb7aac3818517bad080333eda0` (D001, yaw +13.88°, pitch +30.16°), is a tilted, near-frontal face. Its opposing nose measurements do **not** establish a clearly reversed-profile photograph. It is unresolved, not automatically excluded.
- **No confirmed opposite-facing original was identified or replaced.** The user-reported photo still needs an exact ID or identifiable offending-frame evidence. Site v59 and the 70k catalog are unchanged. Do not treat QA's automatic wrong-photo export as a user-reported defect.
- A separate, incidental quality defect was recorded for D080: an illustrated portrait in the photographic catalog. This does not identify the reported reverse-facing photo and has not been remediated in this direction investigation.
- Exact IDs, hashes, review scope, and the next required evidence are retained in `data/catalog-quality/facing-geometry-review-20261015.json`. The existing `誤画像を報告` export is the shortest way to bind a reported frame to its exact catalog entry.
