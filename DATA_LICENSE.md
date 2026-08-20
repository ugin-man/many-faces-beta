# Dataset license and attribution

The MIT License in this repository applies to software only. It does not apply
to catalog images, image packs, derived face geometry, or source attribution
metadata.

The primary source is the [Flickr-Faces-HQ Dataset (FFHQ)](https://github.com/NVlabs/ffhq-dataset),
which is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
The catalog therefore remains non-commercial, requires attribution, and must be
shared under the same license. Individual FFHQ images retain the source-specific
license and author information recorded in their metadata.

Changes made for Many Faces include resizing aligned source images to compact
WebP previews, packing previews into range-readable binary objects, extracting
MediaPipe geometry, deriving normalized 55-feature search vectors, pose
sharding, and limited mirroring/targeted supplementation for expression
coverage. These changes are indicated in the catalog metadata.

The FFHQ authors state that FFHQ was not intended for development or improvement
of facial-recognition technologies. Many Faces follows that restriction in
purpose: it searches visible geometry, pose and expression for a creative video
effect and must not be used for identification, biometric profiling or facial
recognition.

Redistributors are responsible for preserving attribution and source-license
fields, using the data only where those licenses permit, and honoring applicable
privacy, personality and removal rights. See the data repository's dataset card
for the catalog contents and limitations.
