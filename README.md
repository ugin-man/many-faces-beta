# Many Faces Beta

Many Faces turns a source video into a rapid sequence of different people whose
face geometry, pose and expression follow the original performance. It searches
precomputed MediaPipe face-mesh geometry instead of generating or swapping a
single identity.

This is an experimental, non-commercial Beta. The current catalog contains
70,224 source faces, 70,099 searchable meshes, 761 pose shards and 55 matching
features covering head pose, face outline, eyes, brows and mouth actions.

## Repository layout

- `app/`, `worker/`, `tools/`: application, matching pipeline and catalog tools
- `public/seed-catalog/`: the complete precomputed 70k catalog and packed previews
- `data/`: dataset card, attribution, integrity hashes and data license

The software and data share one repository but remain separately licensed. The
FFHQ-derived catalog is governed by CC BY-NC-SA 4.0 and source-specific image
licenses. It is public and source-available for non-commercial research and
creative experiments, but it is not distributed under the MIT software license.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

The full catalog is already stored in `public/seed-catalog/`, so a normal clone
is immediately usable. To refresh it from a compatible deployment:

```bash
npm run catalog:export -- \
  --site https://many-faces-prototype.uginn-poppo.chatgpt.site \
  --output ./public/seed-catalog
npm run catalog:validate -- ./public/seed-catalog
```

## How matching works

1. MediaPipe extracts a 468-point face mesh from each source frame.
2. The mesh is normalized around stable facial anchors, not the image canvas.
3. A coarse pose cell narrows the 70k catalog to relevant shards.
4. A weighted 55-feature score compares outline, scale, eyes, brows, mouth,
   gaze and head pose.
5. Temporal penalties and candidate cycling preserve motion while avoiding a
   single frozen match.
6. The chosen face is aligned and shown beside the source video for evaluation.

The catalog stores feature vectors and geometry beside each image, so playback
does not rerun face detection across all 70,000 images.

## Development

```bash
npm test
npm run lint
```

Useful tools live in `tools/`. Normal CI uses a sparse checkout that omits the
large catalog; the complete data can still be cloned or validated when needed.

## Licenses and responsible use

Software in this repository is licensed under the [MIT License](LICENSE).
Dataset files are covered separately by [data/LICENSE.md](data/LICENSE.md).

Do not use this project to identify people, build biometric profiles, or improve
facial-recognition systems. Respect the source-image licenses, privacy and
removal requests. This project is about matching visible performance geometry,
not establishing identity.
