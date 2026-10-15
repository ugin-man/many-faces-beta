# Fixed-video facing mismatch — 2026-10-15

## Reproduction
The user clarified that both screenshots use the built-in 固定動画 button. The source is `public/test-fixtures/reference-face-motion.mp4` (512 × 910, 30 fps, 23.3 seconds). No private-video upload is needed. This supersedes the missing-source-video limitation in `SIDE_YAW_AUDIT_20261014.md`.

At about five seconds the source faces viewer-left. The two screenshot photos are correctly catalogued as viewer-right; replacing their direction labels would corrupt the catalog. The failure originates in intermittent source-face estimation near profile, before candidate selection.

Baseline GitHub browser QA run 38678782477, commit 6db7b96c9372e8a0cb2e016063b1d642efddabb0, artifact 11947562593 (SHA-256 `6e9f8bf646b3b81c2330d1b76825eba00ea7bba6fea2b06286d25de6a1c58e0c`) reproduced the issue with the production CPU landmarker and full-resolution capture helper. It detected 409 of 466 sampled frames. At 4.5 seconds yaw/roll were -54.46°/+10.17°; at 4.95 seconds the false mesh reported +6.12°/+60.27°; at 5.4 seconds the estimate recovered to -57.20°/+20.50°. The resulting composite at five seconds showed a mismatched near-frontal photograph. Existing stored analysis independently contains the stronger false right-facing island at 5.0–5.17 seconds, matching the kind of failure shown on the phone.

## Change
Before offline photo selection, check a short uncertain profile interval against both neighbouring detections. Reject an isolated opposite-facing profile, or a collapsed profile with a large roll jump, when matching strong profiles bracket it within 1.25 seconds without an observed frontal transition. Thresholds: anchor yaw at least 30°, opposite entry 30° / continuation 20°, or collapse below 20° with roll changing by at least 30°. A normal turn through frontal detections remains intact. This is a bounded temporal consistency check, not a guarantee against every possible detector error.

Reject the entire unreliable mesh rather than editing only its yaw. Prepare the preceding trustworthy **complete composite** and use it through the interval, including a direct seek from elsewhere and video export. Do not draw the raw current video during this hold. Existing protection before the first valid composite and during ordinary missing detections remains in place. Clear held frames when changing input videos.

Catalog photos, their direction labels, the 70,000-photo count, 3° grid, and realtime camera engine remain unchanged.

## Verification
- Regression fixtures cover both the actual 20 fps browser output and the older 30 fps fixed-video analysis.
- In the current 409-frame detected sequence, only the false 4.95-second mesh is rejected; the complete protected 4.5-second composite covers 4.55–5.4 seconds.
- Tests preserve legitimate frontal transitions, both facing directions, sustained turns and source meshes.
- Browser QA additionally checks the selected photo faces left, the held pixels exactly equal the protected neighbour, and seeking from another time does not change them. It also exercises image/video saving, phone controls and the existing black-flash export check.
- Whole-repository TypeScript checking already contains unrelated errors; targeted tests and production build remain the applicable checks. Physical iPhone Safari testing is not available in this environment.

Final fix commit: `4fe1749c7028cfb1076bf3a954e7062c2ff70803`.
- Dedicated browser QA run **38679834762 passed** on the final commit, including the left-facing photo, exact protected-neighbour pixel match after direct seeks, image/video export, mobile controls, and black-flash rejection. Artifact 11947754361, SHA-256 `655f4c62f9ea844e833bc29606cf6266334cf2ad2733e1c5d0a62c5f08883297`.
- Main CI run **38679847387 passed**: 310 Node tests passed / one skipped / zero failed; ESLint zero errors (existing warnings); 238 Python tests passed.
- The earlier fix QA run 38679634047 also passed. Its five-second image was inspected visually: the selected photograph faces viewer-left (stored yaw -56.68°), matching the trusted 4.5-second source frame (-54.46°). The held composite is pixel-identical to that trustworthy neighbour.
- The separate legacy Fullscreen UI workflow is still blocked at setup by its obsolete pinned catalog tree `559f7f39e3a8eed452ef7eb6a3355a318235c307`; its browser tests did not run. This gate was not weakened or changed.
- Existing public Site published successfully as **version 60**, source commit `1dbdf17da06e39cfaa04a6135010310f46f4b620`, deployment `appgdep_6ad0528c349c8191a855e6daa4ff7f2c`.
- Production URL: https://many-faces-prototype.uginn-poppo.chatgpt.site
- Public audience, catalog identity/count and all existing camera paths were retained. No physical iPhone Safari claim is made.
