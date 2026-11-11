"""Fused C++ implementation of the frozen float64 strict-score evaluator.

This module changes implementation, not the score or candidate admission rule.
Compile explicitly before benchmarking with ``build_native``; NativeKernel's
constructor only loads and verifies an existing library. ``bind`` holds zero-
copy references to the immutable arrays produced by strict_metric.prepare.
Candidate binding belongs to initialization. Binding a new query belongs to
query preparation and must be included in a query timer when performed there.

Full scans and arbitrary subsets use the identical C ABI routine. The native
loop follows an index vector without creating fancy-indexed candidate arrays.
It performs no ranking, threading, pruning, or unreported query memoization.
The calling engine uses the same canonical top-k implementation as its control.
"""

from __future__ import annotations

import argparse
import ctypes
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

import numpy as np

from strict_metric import GROUP_INDEXES, PreparedFaces, prepare, score_prepared, stable_topk


HERE = Path(__file__).resolve().parent
CPP_SOURCE = HERE / "native" / "strict_kernel.cpp"
REFERENCE_SOURCE = HERE / "strict_metric.py"
REFERENCE_SHA256 = "8d15329ea4848511b051bf3709647b097408e33c13bda20b55e50e35ad47346b"
ABI_VERSION = 1
BUILD_FLAGS = (
    "-O3", "-std=c++17", "-shared", "-fPIC", "-march=native",
    "-fno-fast-math", "-ffp-contract=off", "-Wall", "-Wextra", "-Werror",
)
COMPONENT_NAMES = (
    "strictTotal", "total", "contour", "mouth", "leftEye", "rightEye",
    "eyes", "brows", "nose", "mouthDescriptor", "mouthAction", "mouthShape",
    "eyeDescriptor", "browDescriptor", "blendshape", "wink", "blink",
    "shapeGate", "worstLocal", "poseDegrees", "yawDegrees", "pitchDegrees", "rollDegrees",
)
ARRAY_WIDTHS = {
    "features": 55, "contour": 72, "mouth": 62, "left_eye": 32,
    "right_eye": 32, "brows": 40, "nose": 36,
    "expression": 8, "mouth_shape": 8, "blinks": 2,
}
_DOUBLE_PTR = ctypes.POINTER(ctypes.c_double)
_INDEX_PTR = ctypes.POINTER(ctypes.c_int64)


class _CFaces(ctypes.Structure):
    _fields_ = [("count", ctypes.c_int64)] + [(name, _DOUBLE_PTR) for name in ARRAY_WIDTHS]


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _reference_gate() -> None:
    if _digest(REFERENCE_SOURCE) != REFERENCE_SHA256:
        raise ValueError("The frozen strict_metric.py changed; this native port needs a new explicit validation")
    widths = {key: 2 * len(indexes) for key, indexes in GROUP_INDEXES.items()}
    if any(ARRAY_WIDTHS[key] != width for key, width in widths.items()):
        raise ValueError("Prepared group layout differs from the native ABI")


def _cpu_identity() -> dict:
    fields = {"machine": platform.machine(), "model": None, "flags": None}
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.is_file():
        for line in cpuinfo.read_text().splitlines():
            if ":" not in line:
                continue
            key, value = (item.strip() for item in line.split(":", 1))
            if key == "model name" and fields["model"] is None:
                fields["model"] = value
            elif key in ("flags", "Features") and fields["flags"] is None:
                fields["flags"] = value
    return fields


def build_native(build_dir: str | Path, *, compiler: str = "g++") -> Path:
    """Build or validate a content-addressed library, outside query timing.

    The manifest records the compiler, flags, frozen reference, C++ source,
    target CPU and library hash. Existing mismatched artifacts are rejected,
    rather than silently reused or overwritten.
    """
    _reference_gate()
    executable = shutil.which(compiler)
    if executable is None:
        raise FileNotFoundError(f"C++ compiler not found: {compiler}")
    executable = str(Path(executable).resolve())
    version = subprocess.run([executable, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    specification = {
        "abi_version": ABI_VERSION,
        "compiler": executable,
        "compiler_version": version,
        "flags": list(BUILD_FLAGS),
        "cpp_source_sha256": _digest(CPP_SOURCE),
        "reference_source_sha256": _digest(REFERENCE_SOURCE),
        "cpu": _cpu_identity(),
        "platform": platform.platform(),
    }
    fingerprint = hashlib.sha256(json.dumps(specification, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    directory = Path(build_dir).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    library = directory / f"strict_kernel_{fingerprint[:24]}.so"
    manifest_path = library.with_suffix(".json")
    if library.exists() or manifest_path.exists():
        if not library.is_file() or not manifest_path.is_file():
            raise ValueError("Incomplete existing native build; use a new build directory")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("specification") != specification or manifest.get("fingerprint") != fingerprint:
            raise ValueError("Existing native build provenance differs")
        if manifest.get("library_sha256") != _digest(library):
            raise ValueError("Existing native library hash differs")
        return library

    with tempfile.TemporaryDirectory(prefix=".native-build-", dir=directory) as temporary:
        destination = Path(temporary) / library.name
        command = [executable, *BUILD_FLAGS, str(CPP_SOURCE), "-o", str(destination)]
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
        manifest = {
            "specification": specification,
            "fingerprint": fingerprint,
            "library_sha256": _digest(destination),
            "library_bytes": destination.stat().st_size,
            "built_at_utc": datetime.now(timezone.utc).isoformat(),
            "compiler_stdout": completed.stdout,
            "compiler_stderr": completed.stderr,
            "arithmetic": "float64; no fast-math; floating-point contraction off",
            "query_timing_includes_compilation": False,
        }
        temporary_manifest = Path(temporary) / manifest_path.name
        temporary_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        # Build processes must be serialized by the experiment launcher.
        if library.exists() or manifest_path.exists():
            raise FileExistsError("Another builder published this library concurrently")
        os.replace(destination, library)
        os.replace(temporary_manifest, manifest_path)
    return library


@dataclass(frozen=True)
class NativeFaces:
    """Zero-copy descriptor binding; keeps the owning PreparedFaces alive."""

    source: PreparedFaces
    _c_faces: _CFaces

    def __len__(self) -> int:
        return len(self.source)

    @property
    def features(self):
        return self.source.features

    @property
    def groups(self):
        return self.source.groups

    @property
    def expression(self):
        return self.source.expression

    @property
    def mouth_shape(self):
        return self.source.mouth_shape

    @property
    def blinks(self):
        return self.source.blinks

    @property
    def nbytes(self) -> int:
        """Referenced descriptor payload, not additional native allocation."""
        return self.source.nbytes

    @property
    def copied_descriptor_bytes(self) -> int:
        return 0


class NativeKernel:
    """Load an already built library; never compile during construction/search."""

    def __init__(self, library_path: str | Path):
        _reference_gate()
        self.library_path = Path(library_path).resolve()
        manifest_path = self.library_path.with_suffix(".json")
        self.metadata = json.loads(manifest_path.read_text())
        specification = self.metadata["specification"]
        if specification["abi_version"] != ABI_VERSION:
            raise ValueError("Native manifest ABI differs")
        if specification["cpp_source_sha256"] != _digest(CPP_SOURCE):
            raise ValueError("Native C++ source changed after compilation")
        if specification["reference_source_sha256"] != _digest(REFERENCE_SOURCE):
            raise ValueError("Native build used another score reference")
        if specification["flags"] != list(BUILD_FLAGS):
            raise ValueError("Native compiler flags differ")
        if specification["cpu"] != _cpu_identity():
            raise ValueError("Native library was built for a different CPU")
        if self.metadata["library_sha256"] != _digest(self.library_path):
            raise ValueError("Native shared-library hash differs")
        self._library = ctypes.CDLL(str(self.library_path))
        version = self._library.mf_strict_abi_version
        version.argtypes = []
        version.restype = ctypes.c_int
        if version() != ABI_VERSION:
            raise ValueError("Loaded native ABI differs")
        self._score = self._library.mf_strict_score
        self._score.argtypes = [
            ctypes.POINTER(_CFaces), ctypes.c_int64,
            ctypes.POINTER(_CFaces), _INDEX_PTR, ctypes.c_int64,
            ctypes.c_int, _DOUBLE_PTR, _DOUBLE_PTR,
        ]
        self._score.restype = ctypes.c_int

    def bind(self, prepared: PreparedFaces) -> NativeFaces:
        """Validate descriptors once and expose their existing storage to C++."""
        if not isinstance(prepared, PreparedFaces):
            raise TypeError("bind expects the frozen strict_metric.PreparedFaces")
        arrays = {"features": prepared.features, **prepared.groups,
                  "expression": prepared.expression, "mouth_shape": prepared.mouth_shape,
                  "blinks": prepared.blinks}
        if set(arrays) != set(ARRAY_WIDTHS):
            raise ValueError("Descriptor names differ from the native contract")
        pointers = []
        for name, width in ARRAY_WIDTHS.items():
            array = arrays[name]
            if not isinstance(array, np.ndarray) or array.dtype != np.dtype(np.float64):
                raise TypeError(f"{name} must be a native float64 NumPy array")
            if array.shape != (len(prepared), width):
                raise ValueError(f"Unexpected descriptor shape for {name}")
            if not array.flags.c_contiguous or not array.flags.aligned:
                raise ValueError(f"{name} must be contiguous and aligned; bind does not copy it")
            if array.flags.writeable:
                raise ValueError(f"{name} must be immutable; use strict_metric.prepare")
            if not np.isfinite(array).all():
                raise ValueError(f"Nonfinite prepared descriptor: {name}")
            pointers.append(array.ctypes.data_as(_DOUBLE_PTR))
        if (prepared.blinks < 0).any() or (prepared.blinks > 1).any():
            raise ValueError("Prepared blink descriptors must have been clipped to [0, 1]")
        return NativeFaces(prepared, _CFaces(len(prepared), *pointers))

    def score_prepared(
        self,
        query: NativeFaces,
        query_index: int,
        candidates: NativeFaces,
        indices: np.ndarray | None = None,
        *,
        compensate_roll: bool = True,
        return_components: bool = False,
    ) -> np.ndarray | dict[str, np.ndarray]:
        """Return all scores or supplied-subset scores in the original order."""
        if not isinstance(query, NativeFaces) or not isinstance(candidates, NativeFaces):
            raise TypeError("Call bind before native scoring; descriptor preparation is explicit")
        if not isinstance(query_index, (int, np.integer)) or not 0 <= query_index < len(query):
            raise IndexError("Invalid query index")
        if not isinstance(compensate_roll, (bool, np.bool_)):
            raise ValueError("compensate_roll must be boolean")
        index_pointer = _INDEX_PTR()
        index_array = None
        count = len(candidates)
        if indices is not None:
            supplied = np.asarray(indices)
            if supplied.ndim != 1 or not np.issubdtype(supplied.dtype, np.integer):
                raise ValueError("indices must be a one-dimensional integer array")
            if len(supplied) and (supplied.min() < 0 or supplied.max() >= len(candidates)):
                raise IndexError("Candidate index out of bounds")
            index_array = np.ascontiguousarray(supplied, dtype=np.int64)
            index_pointer = index_array.ctypes.data_as(_INDEX_PTR)
            count = len(index_array)
        scores = np.empty(count, dtype=np.float64)
        component_array = np.empty((len(COMPONENT_NAMES), count), dtype=np.float64) if return_components else None
        component_pointer = _DOUBLE_PTR() if component_array is None else component_array.ctypes.data_as(_DOUBLE_PTR)
        status = self._score(
            ctypes.byref(query._c_faces), int(query_index),
            ctypes.byref(candidates._c_faces), index_pointer, count,
            int(compensate_roll), scores.ctypes.data_as(_DOUBLE_PTR), component_pointer,
        )
        if status == 1:
            raise ValueError("Native score ABI rejected its input contract")
        if status == 2:
            raise IndexError("Native candidate index out of bounds")
        if status == 3:
            raise FloatingPointError("Nonfinite strict score from native evaluator")
        if status != 0:
            raise RuntimeError(f"Unknown native score status {status}")
        if component_array is not None:
            return {name: component_array[i] for i, name in enumerate(COMPONENT_NAMES)}
        return scores


def self_test(kernel: NativeKernel) -> dict:
    """Finite numerical/canonical-ranking checks, never a speed benchmark."""
    rng = np.random.default_rng(20261112)
    features = rng.uniform(0, 1, (128, 55))
    features[:, :3] = rng.uniform(-.6, .6, (128, 3))
    points = rng.normal(0, .3, (128, 936))
    variants = []
    for left, right in ((0, 0), (.139999999, 0), (.14, 0), (.140000001, 0),
                        (.559999999, 0), (.56, 0), (.560000001, 0), (1, 0),
                        (0, 1), (-1, 2), (2, -1)):
        f = features[0].copy()
        f[13:15] = [left, right]
        variants.append((f, points[0].copy()))
    variants.append((np.zeros(55), np.zeros(936)))
    f = features[0].copy()
    f[:3] = [1.5, -1.5, 1.5]
    p = points[0].reshape(468, 2).copy()
    for left, right in ((61, 291), (78, 308), (33, 133), (362, 263)):
        p[right] = p[left]
    variants.append((f, p.reshape(936)))
    # Duplicated complete descriptors exercise canonical-ID ties.
    variants.extend([(features[2].copy(), points[2].copy())] * 3)
    all_features = np.vstack((features, [x[0] for x in variants]))
    all_points = np.vstack((points, [x[1] for x in variants]))
    candidates = prepare(all_features, all_points)
    query_rows = np.r_[np.arange(16), np.arange(128, len(candidates))]
    queries = prepare(all_features[query_rows], all_points[query_rows])
    native_candidates, native_queries = kernel.bind(candidates), kernel.bind(queries)
    maxima = {name: 0.0 for name in COMPONENT_NAMES}
    pair_checks = ranking_checks = subset_checks = 0
    for roll in (False, True):
        for qi in range(len(queries)):
            expected = score_prepared(queries, qi, candidates, compensate_roll=roll, return_components=True)
            actual = kernel.score_prepared(native_queries, qi, native_candidates, compensate_roll=roll, return_components=True)
            if tuple(expected) != COMPONENT_NAMES or tuple(actual) != COMPONENT_NAMES:
                raise AssertionError("Component contract changed")
            for name in COMPONENT_NAMES:
                np.testing.assert_allclose(actual[name], expected[name], atol=2e-12, rtol=0, err_msg=name)
                maxima[name] = max(maxima[name], float(np.max(np.abs(actual[name] - expected[name]))))
            for k in (1, 8, 64, len(candidates)):
                np.testing.assert_array_equal(stable_topk(actual["strictTotal"], k), stable_topk(expected["strictTotal"], k))
                ranking_checks += 1
            pair_checks += len(candidates)
            for subset in (np.array([len(candidates) - 1, 0, 2, 2, 63]),
                           np.arange(len(candidates) - 1, -1, -3), np.empty(0, dtype=np.int64)):
                scores = kernel.score_prepared(native_queries, qi, native_candidates, subset, compensate_roll=roll)
                # Subset/full calls run identical arithmetic in the native loop.
                np.testing.assert_array_equal(scores, actual["strictTotal"][subset])
                np.testing.assert_allclose(scores, score_prepared(queries, qi, candidates, subset, compensate_roll=roll), atol=2e-12, rtol=0)
                subset_checks += 1
    for bad in (np.array([-1]), np.array([len(candidates)]), np.array([1.0]), np.array([[1]])):
        try:
            kernel.score_prepared(native_queries, 0, native_candidates, bad)
        except (ValueError, IndexError):
            pass
        else:
            raise AssertionError("Invalid native subset passed validation")
    return {
        "status": "pass", "purpose": "native-synthetic-component-and-ranking-validation",
        "candidate_count": len(candidates), "query_count": len(queries), "seed": 20261112,
        "pair_scores_checked": pair_checks, "component_scalars_checked": pair_checks * len(COMPONENT_NAMES),
        "ranking_checks": ranking_checks, "subset_checks": subset_checks,
        "canonical_ranking_mismatches": 0, "absolute_tolerance": 2e-12, "relative_tolerance": 0,
        "maximum_absolute_error_by_component": maxima,
        "native_build": kernel.metadata,
        "limitation": "Finite synthetic numerical validation, not a throughput result or a guarantee for all float64 inputs. The full real-corpus experiment must independently check top-k equality.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=HERE.parents[1] / "work/face-search-native")
    parser.add_argument("--compiler", default="g++")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    library = build_native(args.build_dir, compiler=args.compiler)
    kernel = NativeKernel(library)
    report = self_test(kernel) if args.self_test else {"library_path": str(library), "build": kernel.metadata}
    if args.report is not None:
        if args.report.exists():
            raise FileExistsError("Refuse to overwrite an existing native validation report")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
