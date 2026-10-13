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
