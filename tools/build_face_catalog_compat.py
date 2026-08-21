#!/usr/bin/env python3
"""Run build_face_catalog.py with Pillow affine-resampling compatibility.

Pillow only supports nearest, bilinear, and bicubic resampling for affine
Image.transform calls. The catalog builder historically requested LANCZOS,
which Pillow 12 rejects before any face can be packed. Keep the workaround
isolated here so collection can proceed while the builder itself remains
backward-compatible with older branches.
"""

from __future__ import annotations

import runpy
from pathlib import Path

from PIL import Image


_original_transform = Image.Image.transform


def _compatible_transform(self, size, method, data=None, resample=Image.Resampling.NEAREST, fill=1, fillcolor=None):
    if method == Image.Transform.AFFINE and resample == Image.Resampling.LANCZOS:
        resample = Image.Resampling.BICUBIC
    return _original_transform(
        self,
        size,
        method,
        data=data,
        resample=resample,
        fill=fill,
        fillcolor=fillcolor,
    )


Image.Image.transform = _compatible_transform
runpy.run_path(str(Path(__file__).with_name("build_face_catalog.py")), run_name="__main__")
