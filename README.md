# Many Faces Beta

Many Faces matches the pose and expression in a source video to a sequence of
existing face photographs. It does not generate a replacement identity and is
not an identity-recognition system. This remains an experimental,
non-commercial project.

## Start here

The maintained review entry point is `/live`. Select a video and the first five
seconds are analyzed locally in your browser. Analysis can use 12, 20 or 30
samples per second. These settings describe sampling density, **not a claim of
real-time processing speed**. The original video and selected photographs are
then played on a shared timeline. The camera recorder remains experimental.

- `/live`: maintained five-second video review.
- `/`: older whole-video laboratory and catalog-authoring interface.
- `/live/fifo`, `/live/fast`, `/live/legacy`: separate experiments, not equivalent
  implementations of the maintained review path.

The current bundled catalog contains **70,000 entries**, each with a 55-value
feature vector and precomputed geometry. The September 2026 integrity scan
found 63,634 Open Images V7 entries, 6,362 FFHQ/Flickr entries and four Wikimedia
Commons entries in 775 image packs. Counts are checked against every shard;
these numbers replace older 70,224/70,099 figures from a different generation.
The integrity test does not certify image rights or visually inspect every face.

## Local development

Use Node.js 22.13 or newer and install exactly the committed dependency lockfile:

```sh
npm ci
npm run dev
```

The full catalog is bundled under `public/seed-catalog/`. Source video bytes stay
in the browser on `/live`; catalog images and model assets are fetched from the
same origin. Source URLs and licenses for the selected photograph are visible
under the output. Opening a source link contacts that external site.

To test the built Cloudflare Worker, rather than a different preview server:

```sh
npm run build
npx wrangler dev --config dist/server/wrangler.json --local --port 3000
```

`npm start` is the older Vinext preview. Passing its tests does not establish
that Worker routing, asset MIME types or storage bindings behave identically.
No deployment happens as part of these commands.

## Checks and evidence

```sh
npm run build
npm run typecheck
npm run test:unit
npm run lint
```

Build once before `test:unit`: Worker tests exercise `dist/server/index.js`.
`npm test` remains a convenience command that builds and runs the tests. Use
individual test paths while iterating on an isolated change. Normal CI checks
the committed source without applying repair scripts. It retains the catalog
needed by the catalog-integrity test, rather than silently testing a sparse,
incomplete dataset.

The manually selectable **Project audit** workflow adds Chromium tests against
local Workerd: video sampling modes, output pixel changes, clip-end playback,
mobile viewport layout, malformed input, late camera permission, cancellation
while loading images and same-file reselection. Browser tooling is installed
separately so it does not rewrite application dependencies. Its reports and
screenshots are Actions artifacts, stamped with the tested commit and fixture
hash. A mobile Chromium viewport is not an iPhone/Safari hardware test.

A runtime PASS means the pipeline completed and rendered images. It does not
mean that expressions are perceptually correct. The UI reports the number of
frames within the existing matching threshold separately. Thresholds and
matching weights were not loosened during the audit.

## Architecture

`app/projection-matching.ts` and `app/offline-matching.ts` implement geometry and
sequence selection. `/live` loads the catalog manifest first, analyzes source
poses, and then fetches relevant pose-local shards instead of eagerly expanding
all 70,000 records. It decodes only selected photographs for playback.

`app/runtime-io.ts` owns bounded reads, request-body deadlines and cancellation.
`app/live/video-frame.ts` owns the decoded-frame barrier.
`app/live/camera-capture.ts` owns camera and recorder lifetime.
`worker/index.ts` serves catalog objects and MediaPipe assets.
`app/public-image-policy.ts` constrains external image ingestion and redirects.

Catalog reads do not silently cross from a selected remote generation into the
bundled seed, or vice versa. Unversioned assets require cache revalidation.
Catalog writes are denied unless persistent storage and `CATALOG_UPLOAD_KEY`
are configured and the request supplies the matching `x-catalog-upload-key`.
A client-provided owner email is not authentication. The older browser catalog
builder does not currently supply this key and therefore cannot publish a
catalog through the hardened endpoint; use an authenticated administrative
workflow. Do not put the key in a URL, checked-in file or browser storage.

## Data and limitations

The code has the [MIT license](LICENSE); the photographs and derived catalog do
not. See [DATA_LICENSE.md](DATA_LICENSE.md) and [data/LICENSE.md](data/LICENSE.md)
for dataset and source-specific conditions. Missing license metadata is never
replaced with a claim that an image is public domain. External ingestion skips
unapproved hosts or unverifiable permission metadata instead of guessing.

Known work remaining includes perceptual pose/expression validation on an
independent test set, physical camera and Safari tests, a shared engine for the
older experimental pages, truly content-addressed catalog releases, and a
supported resolution of upstream dependency advisories. Do not treat a clean
build as a security or production-readiness certificate.

Do not use this project to identify people, build biometric profiles or improve
facial-recognition systems. Respect source-image licenses, privacy and removal
requests.
