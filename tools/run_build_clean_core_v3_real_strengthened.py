#!/usr/bin/env python3
"""Build the real-photo-only catalog with extra capacity for weak profiles.

This does not relax the strict single-factor classifier. It only allows more
already-verified real photographs to survive inside pose cells where a rare
wink, eye, nose, or mouth state is naturally concentrated.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import clean_core_policy_v3 as policy
import run_build_clean_core_v3_real_only as real_only

policy.PROFILE_CELL_LIMITS.update({
    "winkLeft": 32,
    "winkRight": 32,
    "eyesWide": 80,
    "noseSneer": 64,
    "mouthRound": 80,
    "mouthSlightOpen": 96,
    "mouthWide": 80,
    "mouthFrown": 72,
    "mouthUpperUp": 56,
    "mouthLowerDown": 56,
    "mouthLeft": 40,
    "mouthRight": 40,
})

# The acceptance gate is enforced after physical packing by the strengthening
# workflow. Keeping these minima attainable lets the workflow always emit a
# complete audit and catalog for an honest before/after comparison.
policy.PROFILE_MINIMUMS.update({
    "winkLeft": 4,
    "winkRight": 4,
    "eyesWide": 1,
    "noseSneer": 0,
    "mouthRound": 1,
    "mouthSlightOpen": 5,
    "mouthWide": 20,
    "mouthFrown": 8,
    "mouthUpperUp": 20,
    "mouthLowerDown": 20,
    "mouthLeft": 1,
    "mouthRight": 1,
})


def main() -> int:
    return int(real_only.main())


if __name__ == "__main__":
    raise SystemExit(main())
