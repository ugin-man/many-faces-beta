# Dataset license and attribution

The MIT License in this repository applies to software only. It does not apply
to catalog images, image packs, derived face geometry, annotations or source
attribution metadata.

## FFHQ base catalog

The primary 70k source is the [Flickr-Faces-HQ Dataset (FFHQ)](https://github.com/NVlabs/ffhq-dataset),
which is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
The default combined catalog therefore remains non-commercial, requires
attribution, and must be shared under the applicable same-license terms.
Individual FFHQ images retain the source-specific license and author information
recorded in their metadata.

## Open Images supplements

Coverage-driven supplements may contain crops from Open Images V7. Open Images
annotations are published under CC BY 4.0, while the project lists its images as
CC BY 2.0 and warns users to verify the license of each image. The ingestion
pipeline therefore accepts an Open Images image only when its own image-
information row contains:

- an explicit CC BY 2.0 license URL
- an original landing-page URL
- an author name

Those values, the Open Images image ID, the face bounding box and the annotation
license are preserved in supplement metadata. Redistributors must provide the
recorded attribution, link the applicable license, and indicate the Many Faces
crop, alignment, compression and feature-extraction changes. Combining an Open
Images supplement with the FFHQ base does not remove the base catalog's more
restrictive non-commercial and share-alike obligations.

## Processing changes

Changes made for Many Faces include cropping and resizing source images to
compact WebP previews, packing previews into range-readable binary objects,
extracting MediaPipe geometry, deriving normalized 55-feature search vectors,
pose sharding, and coverage-driven selection. These changes are indicated in
the catalog and source metadata.

The FFHQ authors state that FFHQ was not intended for development or improvement
of facial-recognition technologies. Many Faces follows that restriction in
purpose: it searches visible geometry, pose and expression for a creative video
effect and must not be used for identification, biometric profiling or facial
recognition.

Redistributors are responsible for preserving attribution and source-license
fields, using the data only where every applicable license permits, and honoring
privacy, personality, takedown and removal rights. See the dataset card and the
per-entry metadata for catalog contents and limitations.
