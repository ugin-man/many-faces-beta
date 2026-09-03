# Clean Core v2

Clean Core v2 replaces the abandoned fixed-200k milestone with a quality gate
that matches the product requirement.

## Completion means all of the following

- at least 70,000 physically packed and searchable images;
- at least 700 of the 775 three-degree pose cells represented;
- neutral, mouth, eye, gaze and brow profiles all present above explicit
  minimums;
- left and right winks contain a closed, non-smiling mouth and neutral brows;
- mouth profiles contain neutral eyes and neutral brows;
- brow profiles contain neutral eyes and a neutral mouth;
- mixed or unsupported strong states are rejected rather than silently folded
  into a class;
- every source image retains creator, landing page, license and modification
  provenance;
- the final schema-v3 catalog passes the normal catalog validator.

The exact counts are written to `completion-receipt.json` and committed to
`data/clean-core-v2-build.json` only after the complete gate passes.  A workflow
that produces fewer than 70,000 images, zero right winks, or a missing brow
class is a failed experiment, not a reviewable release.

## Profile families

### Neutral

No strong eye, gaze, brow or mouth movement.

### Eye-only

Left wink, right wink, blink, eyes wide, and four gaze directions.  The mouth
must remain closed and non-smiling, and brows must remain neutral.

### Brow-only

Brows up and brows down.  Eyes and mouth must remain neutral.

### Mouth-only

Slight opening, open mouth, closed/open smile, round mouth, pucker, wide mouth,
pressed lips, rolled lips, left/right pull and frown.  Eyes and brows must remain
neutral.  Related mouth blendshapes are resolved hierarchically into one visible
mouth profile instead of being treated as an unwanted cross-family mixture.

## Dataset size

70,000 is a minimum review milestone based on the observed quality jump of the
existing catalog, not a claim that 70,000 is theoretically optimal.  Later work
may produce a smaller or larger catalog, but it must beat this version under
held-out video matching and coverage tests before replacing it.
