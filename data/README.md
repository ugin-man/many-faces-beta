# 70k face-geometry catalog

The catalog used by Many Faces Beta lives in `public/seed-catalog/` so the app
can serve it directly after a normal clone.

Verified Beta snapshot:

| Field | Value |
| --- | ---: |
| Source faces | 70,224 |
| Searchable meshes | 70,099 |
| Face-detection failures | 125 |
| Pose cells | 749 |
| Shards | 761 |
| Image packs | 254 |
| Search features | 55 |

`SHA256SUMS` contains integrity hashes for the manifest, all geometry shards and
all image packs. Every object is below GitHub's 100 MiB single-file limit; Git
LFS is not required.

```bash
npm run catalog:validate -- ./public/seed-catalog
sha256sum -c data/SHA256SUMS
```

Read [DATASET_CARD.md](DATASET_CARD.md) and [LICENSE.md](LICENSE.md) before use
or redistribution.
