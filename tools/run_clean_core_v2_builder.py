#!/usr/bin/env python3
"""Run the existing clean-core catalog builder under the v2 policy."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from clean_core_v2_overlay import patch_legacy_policy

patch_legacy_policy()
runpy.run_path(str(TOOLS / "build_clean_core.py"), run_name="__main__")
