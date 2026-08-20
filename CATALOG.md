# Large face catalog

The live app never runs Face Landmarker on candidate images. A desktop batch
builds aligned WebP images, pose shards, and compact shape vectors once; the
phone fetches numeric indexes first and only downloads the images selected for
the final sequence.

## Bundled seed catalog

The deployed app includes 15,000 FFHQ faces under `public/seed-catalog`. The
original 5,000-image set was retained and 10,000 different identities were
added with a least-populated-cell strategy across yaw -45° to +45° and pitch
-36° to +36° at 3° intervals. This deliberately spends more of the expansion
budget on scarce upward/downward poses instead of tripling the dense frontal
cells. Selection remains balanced across neutral, smiling, surprised, and
negative-expression groups. The source thumbnails were already aligned by FFHQ;
this build resized them to 256px WebP, combined them into 2 MB range-readable
packs, and retained the original Flickr author, source page, and per-image
license or dataset source record in each entry. Matching geometry lives in
chunked numeric indexes, while lighter pose shards support the realtime view.
Images that cannot be redetected remain in the packs but are excluded from
matching.

The Worker serves the bundled seed automatically. A larger R2 catalog may use
either chunked full indexes or geometry-bearing pose shards. The latter is the
70,000-face path: it avoids downloading a browser-wide index that would be
hundreds of megabytes and would expand to more than a gigabyte in phone memory.
An old or incomplete remote build cannot hide the 15,000-image seed.

## Offline video sequence workflow

The primary interface analyzes up to 30 seconds of a local video before
playback. It samples 24, 30, or 60 frames per second and extracts a normalized
468-point 3D Face Mesh for every detected frame. The catalog's 3° yaw/pitch
cells act as a coarse index; a wider pitch neighborhood compensates for the
greater noise in vertical pose estimates. Within those cells the search first
keeps faces inside a 12° yaw / 15° pitch window, widening to 18° / 21° only
when coverage is sparse. A cheap projected-shape, pose, and action pass reduces
that set to a bounded pool, while separately retaining the best mouth-shape
candidates. Only that pool receives the full 468-point local-feature
comparison. The best 64 matches per ranking mode are passed to the sequence
solver for each frame.

The descriptor is intentionally split in two. The full surface includes
expression deformation and determines the closest image for each frame. A
separate structure vector excludes the mouth and brows and is used to prevent
identity and skull-shape jumps without suppressing smiles or other small
expressions. A dynamic-programming pass chooses the path through the whole
video, and the selected crops are normalized to the median face box before
display.

The default V5 matcher also scores vowel shape explicitly: outer lip width,
inner aperture, roundness, corner height, jaw opening, funnel, pucker, and
horizontal stretch. This prevents a close contour match with the wrong mouth
from winning merely because both mouths are generically "open".

There is no general Web image search in this workflow. The source video and all
mesh data stay in browser memory. Catalog shards contain compact quantized
structure, 468-point projection, face layout, and all 52 MediaPipe facial
actions, so search completes before any candidate image bytes are fetched. Eye
direction, eye width, asymmetric blinks, cheek, nose, jaw, and smaller mouth
actions are no longer discarded.

## 70,000-face coverage build

The full build retains every FFHQ source face instead of spending the catalog
budget only on dense frontal cells. MediaPipe measures every image once, moves
it into its final 3° yaw/pitch shard, and writes a coverage report into the
manifest. The report separately counts both wink directions, blink, wide eyes,
eye look up/down, raised brows, both vertical pose extremes, smile, and open
mouth. A wink is counted only on a near-frontal face and when the actual eyelid
apertures agree with the action score; side-profile occlusion is not allowed to
masquerade as a wink.

The indexer is resumable. A face is reused only when it already has the current
55-value feature schema and all geometry vectors. Completed source packs and
shards survive an interrupted run, while the final manifest is published last.

## Expand directly in the site

On a desktop browser, open **REMOTE FACE CATALOG → カタログを拡張** and
choose 15,000 faces. The page downloads FFHQ candidates in
small batches, runs the same MediaPipe detector used by live tracking, aligns
the eyes, removes exact visual duplicates, quantizes yaw/pitch to 3° cells, and
uploads immutable image packs and JSON shards.

Keep the tab open until completion. The page requests a screen wake lock where
the browser supports it. Packs and shards use a unique generation ID and the
new manifest is uploaded last, so cancellation or a network error leaves the
previous catalog usable. This path needs no Python installation or Linux OpenGL
runtime.

## Build a catalog from a local image directory

Use Python 3.11 or 3.12 on a desktop machine.

```bash
python -m venv .catalog-venv
.catalog-venv/bin/pip install -r tools/requirements-catalog.txt
.catalog-venv/bin/python tools/build_face_catalog.py /path/to/source-images /path/to/face-catalog
```

On Windows, replace `.catalog-venv/bin/python` with
`.catalog-venv\\Scripts\\python.exe`.

On a headless Debian/Ubuntu machine, MediaPipe may also require the system
`libgles2` package. A normal Windows or macOS desktop does not need this Linux
package.

The output contains `manifest.json`, `shards/*.json`, and `packs/*.bin`.
WebP images are concatenated into roughly 6 MB immutable packs; the app reads
only each selected image's byte range. This keeps a 70,000-face catalog to a few
hundred upload requests instead of 70,000 individual requests.
Open the owner-only site on a desktop browser and choose the output directory
under **REMOTE FACE CATALOG**. The manifest is uploaded last so phones never see
a partially published catalog.

The local-directory tool accepts any extracted image directory, so it is also
the ingestion path for annotated research sets such as LS3D-W or frames from
300-VW. Their supplied landmarks do not need to match MediaPipe's topology: the
builder measures every accepted crop with the same detector used by the app.
Dataset licenses often allow research use but prohibit republishing the images;
keep those catalogs private unless the relevant terms explicitly allow
redistribution.

Each new shard entry contains base64-encoded, int16-quantized stable-structure,
detail, and 468-point projected vectors (`shapeVersion:
mediapipe-projection-468-v4`) plus a normalized face box. Search never decodes
candidate images. This keeps a
tens-of-thousands-image catalog practical while preserving detailed shape for
the final comparison.

## Optional licensing metadata

Pass `--metadata metadata.csv`. Supported columns are:

```text
relative_path,title,source_name,source_url,creator,license,license_url
```

Paths are relative to the input directory. Keep the original dataset and
per-image license records; the build does not infer redistribution rights.
