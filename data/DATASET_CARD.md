# Dataset card

## Summary

Many Faces Beta 70k is a precomputed retrieval catalog for a creative video
effect: each input frame selects a different face with closely matching visible
geometry, head pose and expression. The snapshot identifier is
`many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1`.

The primary image source is Flickr-Faces-HQ (FFHQ). The catalog also contains a
reviewed real-photo entries. A separate wink-support catalog provides targeted
expression coverage. Source, license and modification fields are retained with
searchable entries. The core catalog has 70,000 searchable, unique source images;
its real-photo-only policy excludes synthetic faces.

## Processing

- aligned source images were resized to 256-pixel WebP previews;
- previews were concatenated into independently range-readable binary packs;
- MediaPipe extracted a 468-point face mesh;
- geometry was normalized around stable facial anchors;
- 55 search features cover pose, scale, outline, gaze, eyelids, brows and mouth;
- faces are partitioned into 775 pose cells at 3-degree intervals and 775 JSON shards;
- all 70,000 core entries have searchable geometry.

No identity label or face embedding is supplied.

## Intended uses

- non-commercial creative coding and video-art experiments;
- research on geometry-based visual retrieval and temporal continuity;
- reproducible evaluation of the Many Faces matching pipeline.

## Out-of-scope uses

- identifying, authenticating or tracking a person;
- biometric profiling or inferring sensitive traits;
- training or improving facial-recognition technology;
- commercial use;
- harassment, impersonation or deceptive presentation of a real person.

## Limitations

FFHQ is not demographically balanced and contains the biases of Flickr imagery,
its collection process and face detection. A close geometric match is not a
claim that two people share an identity, ethnicity, age, gender or any other
attribute. Expression coverage is uneven. A pose-cell label is an index, not a guarantee
that every image matches the same physical angle. Any augmentation or mirroring
in auxiliary experiments must be documented separately.

The previews may depict identifiable people. Users must consider privacy,
personality rights and local law in addition to copyright licenses. Do not use
this catalog in high-stakes contexts.

## Integrity

`SHA256SUMS` covers the current manifest, all 775 shards and all 775 image packs. The
catalog validator checks schema version 3, 55-feature vectors, unique IDs, face
totals, shard ownership and packed-image byte ranges.

## Removal and corrections

Open an issue with the catalog entry ID and the reason for a removal,
attribution or license correction. Do not post additional personal information
in the issue. A corrected snapshot should change the catalog ID and regenerate
the integrity hashes.
