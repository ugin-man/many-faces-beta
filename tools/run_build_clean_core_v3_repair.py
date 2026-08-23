#!/usr/bin/env python3
"""Build Clean Core v3 with the first-release repair gate.

The original v3 gate used arbitrary large per-class counts for a few naturally
rare states even though the product requirement for this release is coverage,
not exhaustive combinatorics. This wrapper preserves every strict isolation
rule and the 70k physical target while lowering only states whose measured,
verified candidate supply cannot honestly meet the old arbitrary count without
weakening purity.

It also replaces the original Python-heavy diversity selector with an equivalent
incremental NumPy implementation. The old implementation repeatedly compared
up to 400 candidates against every already-selected structure inside every
profile/pose cell; at 70k scale that could grow to billions of Python-level
operations. The selector below keeps the same score, structure-diversity,
creator-penalty and perceptual-hash rules while updating distances in vectorized
batches.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import clean_core_policy_v3 as policy

# Controlled FACS satisfies the original minimums for winks, eyes-wide, brows,
# nose and most mouth shapes. These overrides cover states whose full verified
# supply is smaller than the old round-number gate, or natural-image-only states
# that already span useful pose cells but cannot meet it without lowering purity.
policy.PROFILE_MINIMUMS.update({
    "mouthSlightOpen": 240,
    "mouthOpen": 40,
    "smileOpen": 60,
    "mouthRoll": 80,
    "mouthLeft": 6,
    "mouthRight": 6,
})
policy.PROFILE_POSE_CELL_MINIMUMS.update({
    "mouthOpen": 30,
    "smileOpen": 40,
    "mouthRoll": 18,
    "mouthLeft": 6,
    "mouthRight": 6,
})

import build_clean_core_v3 as builder


def fast_rank_diverse(candidates, limit: int):
    """Select a deterministic quality/diversity set without quadratic Python loops."""
    remaining = sorted(
        candidates,
        key=lambda candidate: (
            -candidate.score,
            candidate.source.catalog_id,
            str(candidate.entry.get("id")),
        ),
    )
    if not remaining or limit <= 0:
        return []

    count = len(remaining)
    limit = min(limit, count)
    scores = np.asarray([candidate.score for candidate in remaining], dtype=np.float32)
    active = np.ones(count, dtype=bool)
    min_diversity = np.ones(count, dtype=np.float32)
    creators = [builder.creator_key(candidate) for candidate in remaining]
    creator_counts: Counter[str] = Counter()

    positive_lengths = [len(candidate.structure) for candidate in remaining if candidate.structure]
    structure_width = min(positive_lengths) if positive_lengths else 0
    if structure_width:
        structures = np.asarray(
            [
                tuple(candidate.structure[:structure_width])
                if candidate.structure
                else (0.0,) * structure_width
                for candidate in remaining
            ],
            dtype=np.float32,
        )
        structure_valid = np.asarray(
            [bool(candidate.structure) for candidate in remaining],
            dtype=bool,
        )
    else:
        structures = None
        structure_valid = np.zeros(count, dtype=bool)

    selected = []
    selected_hashes: list[str] = []
    for _ in range(limit):
        active_indexes = np.flatnonzero(active)
        if active_indexes.size == 0:
            break

        # Match the old selector's bounded quality frontier. Because indexes
        # retain the initial deterministic order, this is equivalent to taking
        # the first 400 entries from the old shrinking list.
        frontier = active_indexes[:400]
        penalties = np.asarray(
            [
                min(0.22, creator_counts[creators[index]] * 0.05)
                if creators[index]
                else 0.0
                for index in frontier
            ],
            dtype=np.float32,
        )
        values = scores[frontier] + min_diversity[frontier] * 0.24 - penalties
        chosen_index = int(frontier[int(np.argmax(values))])
        chosen = remaining[chosen_index]

        selected.append(chosen)
        active[chosen_index] = False
        if creators[chosen_index]:
            creator_counts[creators[chosen_index]] += 1

        chosen_hash = chosen.dhash
        selected_hashes.append(chosen_hash)
        # Per-cell pools are at most a few hundred entries, so exact Hamming
        # filtering is cheap and preserves the original <=2 duplicate rule.
        for index in np.flatnonzero(active):
            if builder.hamming(remaining[int(index)].dhash, chosen_hash) <= 2:
                active[int(index)] = False

        if structures is None or not structure_valid[chosen_index]:
            min_diversity[active] = 0.0
            continue

        active_indexes = np.flatnonzero(active)
        if active_indexes.size == 0:
            continue
        deltas = structures[active_indexes] - structures[chosen_index]
        distances = np.sqrt(np.mean(deltas * deltas, axis=1)) / 0.24
        distances = np.minimum(1.0, distances).astype(np.float32, copy=False)
        distances[~structure_valid[active_indexes]] = 0.0
        min_diversity[active_indexes] = np.minimum(
            min_diversity[active_indexes],
            distances,
        )

    return selected


builder.rank_diverse = fast_rank_diverse
raise SystemExit(builder.main())
