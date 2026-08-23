#!/usr/bin/env python3
"""Run the Clean Core v3 curator with synthetic-only exposure handling.

Synthetic Humans FACS uses deliberately clipped studio backgrounds. The prior
curator rejected every one of the 4,055 controlled single-AU frames before
MediaPipe could inspect them. For this controlled CC BY 4.0 source only, keep
sharpness/contrast/colorfulness checks but ignore global-image brightness and
background clipping. Face detection, MediaPipe features, target-assisted FACS
verification, cross-family leakage rejection and duplicate checks remain intact.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET = HERE / "curate-clean-core-v3.py"
spec = importlib.util.spec_from_file_location("many_faces_curate_clean_core_v3_facs", TARGET)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load {TARGET}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

_base_quality = module.image_quality


def synthetic_quality(image):
    metrics = dict(_base_quality(image))
    # Synthetic FACS has white/black render backgrounds; these two whole-frame
    # statistics do not describe face quality. Keep all other quality metrics.
    metrics["brightness"] = min(220.0, max(34.0, float(metrics["brightness"])))
    metrics["clippedFraction"] = min(0.41, float(metrics["clippedFraction"]))
    return metrics


module.image_quality = synthetic_quality
raise SystemExit(module.main())
