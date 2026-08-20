# Dataset card

## Summary

Many Faces Beta 70k is a precomputed retrieval catalog for a creative video
effect: each input frame selects a different face with closely matching visible
geometry, head pose and expression. The snapshot identifier is
`seed-ffhq-70224-actions-v4`.

The primary image source is Flickr-Faces-HQ (FFHQ). The catalog also contains a
small targeted expression supplement and mirrored augmentation entries. Source,
license and modification fields are retained with searchable entries.

## Processing

- aligned source images were resized to 256-pixel WebP previews;
- previews were concatenated into independently range-readable binary packs;
- MediaPipe extracted a 468-point face mesh;
- geometry was normalized around stable facial anchors;
- 55 search features cover pose, scale, outline, gaze, eyelids, brows and mouth;
- faces were partitioned into 749 coarse pose cells and 761 JSON shards;
- 125 source faces with failed geometry extraction remain counted but are not
  searchable.

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
attribute. Expression coverage is uneven even though the Beta coverage targets
are met. Mirrored entries can further distort asymmetrical details and text.

The previews may depict identifiable people. Users must consider privacy,
personality rights and local law in addition to copyright licenses. Do not use
this catalog in high-stakes contexts.

## Integrity

`SHA256SUMS` covers the manifest, all 761 shards and all 254 image packs. The
catalog validator checks schema version 3, 55-feature vectors, unique IDs, face
totals, shard ownership and packed-image byte ranges.

## Removal and corrections

Open an issue with the catalog entry ID and the reason for a removal,
attribution or license correction. Do not post additional personal information
in the issue. A corrected snapshot should change the catalog ID and regenerate
the integrity hashes.
