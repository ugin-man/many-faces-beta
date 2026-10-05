# Dataset v4 admission and release boundary

The user requested that opaque eyewear, masks and wrongly labelled facing directions must not be present in the delivered dataset. A runtime exclusion overlay is not the final solution.

## Physical construction

`catalog_v4_candidates.py` starts with the exact image bytes intended for output. It reuses qualifying original photographs without replacing their pixels and encodes new source crops before measurement. Mask/sunglasses checks, single-face checks, required visible-region coordinates, pose consistency, image detail, provenance and numeric encoding checks all happen before an image is written to an admitted candidate pack. Uncertain visibility is rejected, not counted as a clean slot. Eye closure and transparent eyeglasses are not rejection criteria. There is no face-paint title exclusion and no ban on wink-plus-smile combinations.

An image reflection is used only as a pose-consistency test. Reflected images are never written as additional dataset images. No generated expression, face-part compositing or reflected-image quota filling is used.

`catalog_v4_assemble.py` chooses from admitted candidates and creates new physical packs with only the chosen bytes. It fails if there are fewer than 70,000 distinct admitted candidates. Missing pose cells and acceptance work are reported rather than silently filled with rejected images.

`finalize_catalog_v4.py` verifies contiguous referenced image ranges and their admission hashes, removes stale v3 expression labels, and hashes the descriptor data into the catalog revision. Changing geometry without changing pixels must invalidate old cached shards. The legacy claim of uniformly sized 256-pixel images is removed because original images are retained and new images are at most 384 pixels.

## Wink linkage

The replacement wink index is built from rows in the new physical dataset. It contains no outside photographs or alternate descriptors for the same image ID. Its catalog ID must agree with the manifest. Legacy wink indexes must not be paired with replacement packs.

## What automatic admission establishes

A passed admission check is not a human visual label, a calibrated probability of correctness, an identity deduplication certificate, or proof that every possible obstruction is detected. A reflection test checks internal pose consistency, not independently annotated ground truth. Attribute confidence values are model outputs, not a measured dataset error rate.

A physically built candidate remains separate from the working application until pack integrity, coverage, wink linkage and browser acceptance have been checked. Visual review sheets are evidence to inspect, not proof of inspection merely because they were generated. No hosted Site has been deployed by these construction workflows.
