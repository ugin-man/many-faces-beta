# Coverage-driven 200k catalog

The 200k expansion is not a random face-count increase. The catalog is treated
as a sparse space of visible face configurations:

- yaw and pitch
- stable face structure
- left/right eyelid state and gaze
- brow position
- mouth aperture, roundness, stretch and asymmetry
- jaw translation and smaller cheek/nose actions

One image may fill several gaps. Every accepted batch is therefore followed by
a fresh coverage analysis instead of using one static shopping list for all
130k additions.

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

## 2. Stage targeted public candidates

Openverse and Wikimedia Commons are used for small, high-value gaps where a
specific visible configuration is needed. Search text never decides acceptance.
It only creates a licensed staging pool.

```bash
node tools/stage-openverse-coverage.mjs \
  --plan data/coverage-200k-plan.json \
  --output work/openverse-stage \
  --limit 2000
```

Each file keeps its source page, creator and license in `metadata.csv`.

## 3. Measure every staged image

```bash
python -m venv .catalog-venv
.catalog-venv/bin/pip install -r tools/requirements-catalog.txt
.catalog-venv/bin/python tools/curate-coverage-candidates.py \
  work/openverse-stage \
  work/openverse-accepted
```

The curation pass rejects corrupt images, multiple faces, tiny faces, visual
duplicates, wrong pose and wrong facial configuration. Accepted files can then
be converted into the normal packed catalog format:

```bash
.catalog-venv/bin/python tools/build_face_catalog.py \
  work/openverse-accepted/images \
  work/openverse-catalog \
  --metadata work/openverse-accepted/metadata.csv \
  --yaw-min -45 --yaw-max 45 --pitch-min -36 --pitch-max 36
```

## 4. Merge an accepted batch atomically

```bash
node tools/merge-face-catalog.mjs \
  --base public/seed-catalog \
  --supplement work/openverse-catalog \
  --batch-id openverse-0001
node tools/validate_face_catalog.mjs public/seed-catalog
```

Image packs and replacement shards are written before the manifest changes. An
interrupted merge therefore leaves the previous catalog visible. Re-run the
coverage report after every batch; the next collection queue will shift toward
whatever remains weak.

## Bulk source strategy

The 70k FFHQ source is already exhausted, so most of the remaining images need
a second bulk source. Flickr Diverse Faces is the primary real-image candidate:
it contains 1.5 million in-the-wild faces with per-image source licenses and
large pose diversity. It is suitable for bulk candidate supply, but its own
annotations are not detailed enough to decide expression coverage. Images from
it must still pass the same local MediaPipe curation and provenance checks.

Openverse/Commons remains the targeted source for rare combinations such as a
side-pose wink, rounded mouth while looking up, or asymmetric mouth motion.
Synthetic face datasets may be evaluated as an optional pack, but should not be
silently mixed into the default photographic catalog because they change the
visual character of the output.

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
