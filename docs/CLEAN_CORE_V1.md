# Clean Core v1

Clean Core v1 rebuilds the Many Faces catalog around **isolated, single-factor face states** instead of increasing the old 70k catalog by raw image count.

The old FFHQ-derived catalog remains an input candidate warehouse. It is not treated as automatically correct or automatically retained. Open Images supplies additional licensed candidates, but candidates from either source must pass the same clean-state policy before selection.

## Scope

The first review milestone intentionally supports one anatomical action group at a time:

- neutral face;
- isolated left wink, right wink, or bilateral blink while the mouth is closed and neutral;
- isolated mouth states while eyes, brows, nose and jaw translation remain neutral.

Mouth states receive finer coverage because mouth mismatch is a major source of visible error:

- slight opening;
- clear opening;
- closed-mouth smile;
- open-mouth smile;
- round mouth;
- puckered mouth;
- horizontally wide mouth;
- pressed lips;
- rolled lips;
- mouth pulled left or right;
- mouth-only frown.

Cross-anatomy combinations such as `wink + open mouth`, `wink + toothy smile`, or `pucker + raised brows` are explicitly rejected in v1. Those combinations belong to a later compositional atlas rather than this first clean replacement candidate.

## Pose and selection

- Catalog pose cells use 3-degree yaw and pitch bins.
- Selection is breadth-first: each available profile/pose cell receives one image before any cell receives a second.
- Per-cell limits are profile-specific. Neutral and common mouth states receive more identity alternatives than rare eye states.
- Final ranking combines policy purity, image quality, face placement, source reliability and stable face-structure diversity.
- Exact duplicates, perceptual duplicates and near-identical face structures inside the same profile/pose cell are suppressed.

The result size is an output of coverage and quality, not a fixed 20k, 70k or 200k quota.

## Source policy

- FFHQ candidates preserve their original attribution metadata and remain subject to the FFHQ dataset license and per-image Flickr terms.
- Open Images candidates are restricted to entries with attribution and an accepted Creative Commons source record, then locally re-measured with MediaPipe.
- The generated artifact is a review candidate. It must not be presented as a universally redistributable image pack until the source-license audit is complete.

## Review artifact

A successful workflow artifact contains:

- `catalog/` — uploadable schema-v3 catalog;
- `audit.json` — exact counts, source composition and rejection reasons;
- `coverage.csv` — profile-by-3-degree-cell coverage;
- `contact-sheets/` — visual samples for every selected profile;
- `review/index.html` — human-review entry point;
- `README.md` — artifact-local scope and loading instructions.

The review gate checks useful size, pose breadth, mouth coverage, neutral coverage and profile diversity. Passing the gate means the dataset is ready for side-by-side testing against the old 70k catalog. It does not mean the final combinatorial expression problem is solved.
