#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-public/mediapipe}
MODEL_URL=${MEDIAPIPE_FACE_MODEL_URL:-https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task}
WASM_SOURCE=node_modules/@mediapipe/tasks-vision/wasm

if [[ ! -d "$WASM_SOURCE" ]]; then
  echo "MediaPipe npm wasm directory is missing: $WASM_SOURCE" >&2
  exit 1
fi

mkdir -p "$ROOT"
cp "$WASM_SOURCE"/vision_wasm_internal.js "$ROOT"/
cp "$WASM_SOURCE"/vision_wasm_internal.wasm "$ROOT"/
cp "$WASM_SOURCE"/vision_wasm_nosimd_internal.js "$ROOT"/
cp "$WASM_SOURCE"/vision_wasm_nosimd_internal.wasm "$ROOT"/
cp "$WASM_SOURCE"/vision_wasm_module_internal.js "$ROOT"/
cp "$WASM_SOURCE"/vision_wasm_module_internal.wasm "$ROOT"/

if [[ ! -s "$ROOT/face_landmarker.task" || $(stat -c%s "$ROOT/face_landmarker.task") -lt 1000000 ]]; then
  tmp="$ROOT/face_landmarker.task.tmp"
  rm -f "$tmp"
  curl --fail --location --retry 5 --retry-all-errors \
    --connect-timeout 20 --max-time 300 \
    "$MODEL_URL" -o "$tmp"
  test $(stat -c%s "$tmp") -ge 1000000
  mv "$tmp" "$ROOT/face_landmarker.task"
fi

python - "$ROOT" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
files = {}
for path in sorted(root.iterdir()):
    if not path.is_file() or path.name.endswith('.tmp'):
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    files[path.name] = {"bytes": path.stat().st_size, "sha256": digest}
receipt = {
    "schemaVersion": 1,
    "runtime": "@mediapipe/tasks-vision@1.0.1",
    "sameOrigin": True,
    "files": files,
}
(root / "runtime-manifest.json").write_text(
    json.dumps(receipt, indent=2) + "\n",
    encoding="utf-8",
)
print(json.dumps(receipt, indent=2))
PY
