#!/usr/bin/env python3
"""Run Synthetic Humans FACS staging with the v3 mouth-state mapping."""

from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET = HERE / "stage_synthetic_facs.py"
spec = importlib.util.spec_from_file_location("many_faces_stage_synthetic_facs_v3", TARGET)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load {TARGET}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# AU17 (Chin Raiser) is represented by MediaPipe's lower-lip/chin shrug family.
# Keeping it as a dedicated single-AU mouth shape is more useful than silently
# discarding the 241 controlled renders.
module.AU_TARGETS[17] = "mouthShrug"

raise SystemExit(module.main())
