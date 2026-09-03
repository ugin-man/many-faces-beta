#!/usr/bin/env python3
"""Cache per-vector descriptors reused across thousands of candidate comparisons."""

from pathlib import Path

PATH = Path("app/projection-matching.ts")
text = PATH.read_text(encoding="utf-8")

if "EXPRESSION_DESCRIPTOR_CACHE" in text:
    print("Projection descriptor cache already applied.")
    raise SystemExit(0)

old_expression = '''function expressionDescriptor(vector: NumericVector) {
  const mouthWidth = Math.max(0.05, landmarkDistance(vector, 61, 291));
  const leftEyeWidth = Math.max(0.05, landmarkDistance(vector, 33, 133));
  const rightEyeWidth = Math.max(0.05, landmarkDistance(vector, 362, 263));
  const mouthCenterY = (yAt(vector, 13) + yAt(vector, 14)) / 2;
  const mouthCornerY = (yAt(vector, 61) + yAt(vector, 291)) / 2;
  return [
    landmarkDistance(vector, 13, 14) / mouthWidth,
    landmarkDistance(vector, 82, 87) / mouthWidth,
    mouthWidth,
    (mouthCenterY - mouthCornerY) / mouthWidth,
    landmarkDistance(vector, 159, 145) / leftEyeWidth,
    landmarkDistance(vector, 386, 374) / rightEyeWidth,
    landmarkDistance(vector, 105, 159) / leftEyeWidth,
    landmarkDistance(vector, 334, 386) / rightEyeWidth,
  ];
}
'''
new_expression = '''const EXPRESSION_DESCRIPTOR_CACHE = new WeakMap<object, number[]>();
const MOUTH_SHAPE_DESCRIPTOR_CACHE = new WeakMap<object, number[]>();

function vectorObject(vector: NumericVector) {
  return vector as unknown as object;
}

function expressionDescriptor(vector: NumericVector) {
  const key = vectorObject(vector);
  const cached = EXPRESSION_DESCRIPTOR_CACHE.get(key);
  if (cached) return cached;
  const mouthWidth = Math.max(0.05, landmarkDistance(vector, 61, 291));
  const leftEyeWidth = Math.max(0.05, landmarkDistance(vector, 33, 133));
  const rightEyeWidth = Math.max(0.05, landmarkDistance(vector, 362, 263));
  const mouthCenterY = (yAt(vector, 13) + yAt(vector, 14)) / 2;
  const mouthCornerY = (yAt(vector, 61) + yAt(vector, 291)) / 2;
  const descriptor = [
    landmarkDistance(vector, 13, 14) / mouthWidth,
    landmarkDistance(vector, 82, 87) / mouthWidth,
    mouthWidth,
    (mouthCenterY - mouthCornerY) / mouthWidth,
    landmarkDistance(vector, 159, 145) / leftEyeWidth,
    landmarkDistance(vector, 386, 374) / rightEyeWidth,
    landmarkDistance(vector, 105, 159) / leftEyeWidth,
    landmarkDistance(vector, 334, 386) / rightEyeWidth,
  ];
  EXPRESSION_DESCRIPTOR_CACHE.set(key, descriptor);
  return descriptor;
}
'''
if old_expression not in text:
    raise SystemExit("expressionDescriptor marker not found")
text = text.replace(old_expression, new_expression, 1)

old_mouth = '''export function mouthShapeDescriptor(vector: NumericVector) {
  const outerWidth = Math.max(0.04, landmarkDistance(vector, 61, 291));
  const innerWidth = Math.max(0.025, landmarkDistance(vector, 78, 308));
  const outerHeight = landmarkDistance(vector, 0, 17);
  const innerHeight = landmarkDistance(vector, 13, 14);
  const leftInnerHeight = landmarkDistance(vector, 82, 87);
  const rightInnerHeight = landmarkDistance(vector, 312, 317);
  const mouthCenterY = (yAt(vector, 13) + yAt(vector, 14)) / 2;
  const mouthCornerY = (yAt(vector, 61) + yAt(vector, 291)) / 2;
  return [
    outerWidth,
    outerHeight / outerWidth,
    innerHeight / outerWidth,
    innerWidth / outerWidth,
    innerHeight / innerWidth,
    (mouthCenterY - mouthCornerY) / outerWidth,
    leftInnerHeight / outerWidth,
    rightInnerHeight / outerWidth,
  ];
}
'''
new_mouth = '''export function mouthShapeDescriptor(vector: NumericVector) {
  const key = vectorObject(vector);
  const cached = MOUTH_SHAPE_DESCRIPTOR_CACHE.get(key);
  if (cached) return cached;
  const outerWidth = Math.max(0.04, landmarkDistance(vector, 61, 291));
  const innerWidth = Math.max(0.025, landmarkDistance(vector, 78, 308));
  const outerHeight = landmarkDistance(vector, 0, 17);
  const innerHeight = landmarkDistance(vector, 13, 14);
  const leftInnerHeight = landmarkDistance(vector, 82, 87);
  const rightInnerHeight = landmarkDistance(vector, 312, 317);
  const mouthCenterY = (yAt(vector, 13) + yAt(vector, 14)) / 2;
  const mouthCornerY = (yAt(vector, 61) + yAt(vector, 291)) / 2;
  const descriptor = [
    outerWidth,
    outerHeight / outerWidth,
    innerHeight / outerWidth,
    innerWidth / outerWidth,
    innerHeight / innerWidth,
    (mouthCenterY - mouthCornerY) / outerWidth,
    leftInnerHeight / outerWidth,
    rightInnerHeight / outerWidth,
  ];
  MOUTH_SHAPE_DESCRIPTOR_CACHE.set(key, descriptor);
  return descriptor;
}
'''
if old_mouth not in text:
    raise SystemExit("mouthShapeDescriptor marker not found")
text = text.replace(old_mouth, new_mouth, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied projection descriptor memoization.")
