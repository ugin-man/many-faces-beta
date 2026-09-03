# Coverage-driven 200k catalog

The 200k expansion is not a random face-count increase. The catalog is treated
as a sparse space of visible face configurations:

- yaw and pitch
- stable face structure
- left/right eyelid state and gaze
- brow position
- mouth aperture, roundness, stretch and asymmetry
- jaw translation and smaller cheek/nose actions

One image may expose several configurations, but it is assigned to one currently
open gap per collection pass. Every accepted batch is followed by a fresh
coverage analysis instead of using one static shopping list for all 130k
additions.

## 1. Measure the current catalog

```bash
node tools/coverage-200k-plan.mjs \
  --manifest public/seed-catalog/manifest.json \
  --target 200000 \
  --output data/coverage-200k-plan.json
```

The report groups pose at 9-degree resolution and measures detailed actions in
each cell. Side-pose winks use stricter action and eyelid-aperture checks than
frontal winks so profile occlusion is not counted as a closed eye.

## 2. Stage a broad attributed face pool

Open Images V7 is the bulk photographic source. Its Human face bounding boxes
locate candidate faces, while its image-information CSV preserves the original
landing page, author and per-image license URL. The staging tool accepts only
records whose metadata explicitly reports CC BY 2.0 and contains attribution.

Start with the smaller validation split when testing the pipeline:

```bash
python tools/open_images_face_source.py work/open-images-stage \
  --split validation \
  --max-images 1000 \
  --candidate-limit 5000 \
  --min-box-area 0.006 \
  --allow-occluded
```

Use `--split train` for production batches after the validation smoke passes.
Only requested image IDs are downloaded from the public CVDF mirror. The full
561 GB image collection is never synchronized.

The Open Images box is only a crop hint. It does not decide pose or expression,
and no image enters the catalog at this stage.

## 3. Measure first, then route to a live gap

```bash
python -m venv .catalog-venv
.catalog-venv/bin/pip install -r tools/requirements-catalog.txt
.catalog-venv/bin/python tools/curate-coverage-candidates.py \
  work/open-images-stage \
  work/open-images-accepted \
  --coverage-plan data/coverage-200k-plan.json \
  --route-any-gap
```

The curation pass rejects corrupt images, missing or multiple detected faces,
tiny faces and visual duplicates. MediaPipe then measures yaw, pitch, eyes,
gaze, brows, mouth and jaw. `CoverageRouter` assigns each measured image to the
highest-pressure compatible gap whose quota is still open. Images that fill no
current gap are rejected even when they are otherwise valid portraits.

This replaces the old search-first strategy. Search words no longer need to
predict a rare combination such as a side-pose wink; the dataset is measured
and sorted after acquisition.

## 4. Build and validate a supplement

```bash
.catalog-venv/bin/python tools/build_face_catalog.py \
  work/open-images-accepted \
  work/open-images-catalog \
  --metadata work/open-images-accepted/metadata.csv \
  --yaw-min -45 --yaw-max 45 --pitch-min -36 --pitch-max 36

node tools/finalize-supplement-catalog.mjs \
  --catalog work/open-images-catalog \
  --catalog-id open-images-0001

node tools/validate_face_catalog.mjs work/open-images-catalog
```

Finalization fails if any entry lost its source page, creator, license or
license URL. A supplement is reviewable before it can be merged into the base.

## 5. Merge an accepted batch atomically

```bash
node tools/merge-face-catalog.mjs \
  --base public/seed-catalog \
  --supplement work/open-images-catalog \
  --batch-id open-images-0001
node tools/validate_face_catalog.mjs public/seed-catalog
```

Image packs and replacement shards are written before the manifest changes. An
interrupted merge therefore leaves the previous catalog visible. Re-run the
coverage report after every batch; the next collection queue shifts toward
whatever remains weak.

## Source roles

### Open Images V7: bulk source

Open Images provides a large, diverse pool with Human face boxes and per-image
attribution. It is used to supply broad batches that are measured locally. The
pipeline does not trust the box as proof of face quality and does not trust a
global dataset statement as proof of an individual image license; the exact
image metadata row is retained and validated.

### Openverse and Wikimedia Commons: rare-gap patches

Public search remains useful for a small number of stubborn gaps after bulk
routing, but it is not the 130k-image transport. API authentication, rate limits
and low portrait precision make it unsuitable for sustained bulk collection.
Every result still passes strict pose/configuration measurement.

### FDF256: optional source currently unavailable

FDF256 fits the technical requirements and includes per-image attribution, but
its official DLR download endpoints currently return upstream errors. The
repository keeps a checksum-verifying probe/downloader so the source can be
reconsidered if the official archives or an authenticated official mirror
return. It is not part of the active build path.

## Batch and checkpoint policy

Do not merge 130k images in one operation. Production runs use measured
supplements and checkpoints, for example:

```text
70,099 searchable
→ validation smoke supplement
→ 75k checkpoint
→ 80k checkpoint
→ 90k checkpoint
→ 100k checkpoint
→ repeated 10k checkpoints
→ 200k
```

Each checkpoint records source metadata, curation report, coverage delta,
manifest and checksums. Image packs are append-only; previous packs are not
rewritten into every Git commit.

## Fixed candidate budget

Catalog size and per-frame detailed work are separated by
`FixedCandidateSearchIndex`. Quantized structure, action and local-landmark hash
tables retrieve a bounded pool. The expensive V5 projection ranking still makes
the final decision, but it receives a fixed number of candidates.

```bash
node --experimental-strip-types tools/benchmark-fixed-candidate-search.mjs \
  --manifest public/seed-catalog/manifest.json \
  --analysis public/test-fixtures/reference-face-motion-analysis.json \
  --scales 1,3,6 \
  --budget 512 \
  --max-inspected 2048
```

The benchmark reports build time, average and p95 query/detail time, inspected
candidate count, strict top-8 recall, and 30/60 fps average gates for simulated
70k, 210k and 420k catalogs.
