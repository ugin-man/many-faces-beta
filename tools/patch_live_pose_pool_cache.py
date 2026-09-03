#!/usr/bin/env python3
"""Reuse identical pose-window candidate arrays without changing ranking input."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

if "posePoolCacheRef" in text:
    print("Pose-window candidate cache already applied.")
    raise SystemExit(0)

replacements = [
    (
        '  const shardCacheRef = useRef(new Map<string, Promise<Candidate[]>>());\n'
        '  const outputImagesRef = useRef(new Map<string, HTMLImageElement>());\n',
        '  const shardCacheRef = useRef(new Map<string, Promise<Candidate[]>>());\n'
        '  const posePoolCacheRef = useRef(new Map<string, Promise<Candidate[]>>());\n'
        '  const outputImagesRef = useRef(new Map<string, HTMLImageElement>());\n',
        "pose pool ref",
    ),
    (
        '    shardCacheRef.current.clear();\n'
        '    outputImagesRef.current.clear();\n',
        '    shardCacheRef.current.clear();\n'
        '    posePoolCacheRef.current.clear();\n'
        '    outputImagesRef.current.clear();\n',
        "clear review cache",
    ),
    (
        '    shardCacheRef.current.clear();\n'
        '    outputImagesRef.current.clear();\n'
        '    sequenceRef.current = [];\n\n'
        '    try {\n',
        '    shardCacheRef.current.clear();\n'
        '    posePoolCacheRef.current.clear();\n'
        '    outputImagesRef.current.clear();\n'
        '    sequenceRef.current = [];\n\n'
        '    try {\n',
        "clear process cache",
    ),
]

for old, new, label in replacements:
    if old not in text:
        raise SystemExit(f"Patch marker not found: {label}")
    text = text.replace(old, new, 1)

old_function = '''  const loadFrameCandidates = useCallback(async (
    frame: SequenceFrame,
    token: number,
  ) => {
    const manifest = manifestRef.current;
    if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
    const innerKeys = poseWindowCellKeys(manifest, frame.feature, 12, 15);
    let candidates = await loadCells(innerKeys, token);
    if (shouldExpandPoseWindow(candidates.length, 384)) {
      const outerKeys = poseWindowCellKeys(manifest, frame.feature, 18, 21);
      candidates = await loadCells(outerKeys, token);
    }
    setPeakCandidates((current) => Math.max(current, candidates.length));
    return candidates;
  }, [loadCells]);
'''
new_function = '''  const loadFrameCandidates = useCallback(async (
    frame: SequenceFrame,
    token: number,
  ) => {
    const manifest = manifestRef.current;
    if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
    const loadWindow = (
      yawLimit: number,
      pitchLimit: number,
    ) => {
      const cellKeys = poseWindowCellKeys(
        manifest,
        frame.feature,
        yawLimit,
        pitchLimit,
      );
      const key = `${yawLimit}:${pitchLimit}:${cellKeys.join("|")}`;
      const cached = posePoolCacheRef.current.get(key);
      if (cached) return cached;
      const promise = loadCells(cellKeys, token).catch((caught) => {
        posePoolCacheRef.current.delete(key);
        throw caught;
      });
      posePoolCacheRef.current.set(key, promise);
      return promise;
    };

    let candidates = await loadWindow(12, 15);
    if (shouldExpandPoseWindow(candidates.length, 384)) {
      candidates = await loadWindow(18, 21);
    }
    setPeakCandidates((current) => Math.max(current, candidates.length));
    return candidates;
  }, [loadCells]);
'''
if old_function not in text:
    raise SystemExit("loadFrameCandidates marker not found")
text = text.replace(old_function, new_function, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied exact pose-window candidate pool reuse.")
