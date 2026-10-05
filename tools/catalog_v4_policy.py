"""Admission rules: never fill an output slot with an unverified candidate."""
from __future__ import annotations
import math

VERSION = 'visible-exact-pixels-v4.1'
VISIBILITY_PASS = 0.20

def visibility_reason(values):
    if len(values) != 5 or not all(math.isfinite(float(x)) and 0 <= float(x) <= 1 for x in values):
        raise ValueError('Invalid independent FaceAttribNet probabilities')
    # Eye openness and clear eyeglasses are NOT exclusion criteria.
    mask, sunglasses = float(values[3]), float(values[4])
    if sunglasses >= 0.5: return 'sunglasses'
    if mask >= 0.5: return 'face_mask'
    if max(mask, sunglasses) >= VISIBILITY_PASS: return 'visibility_uncertain'
    return None

def pose_cell(feature):
    if len(feature) != 55 or not all(math.isfinite(float(x)) for x in feature):
        raise ValueError('Invalid face feature')
    yaw = math.floor(feature[0] * 90 / 3 + 0.5) * 3
    pitch = math.floor(feature[1] * 90 / 3 + 0.5) * 3
    if not (-45 <= yaw <= 45 and -36 <= pitch <= 36): return None
    return f'{yaw}:{pitch}'

def opposite_pose(stored_yaw, measured_yaw):
    return abs(stored_yaw) >= 12 and abs(measured_yaw) >= 8 and stored_yaw * measured_yaw < 0 and abs(stored_yaw - measured_yaw) >= 20

def mirror_consistent(yaw, mirrored_yaw):
    return math.isfinite(mirrored_yaw) and yaw * mirrored_yaw < 0 and abs(yaw + mirrored_yaw) <= 12

def expression_tag(feature):
    left, right = feature[13], feature[14]
    eyes = 'left-wink' if left >= .5 and right <= .3 else 'right-wink' if right >= .5 and left <= .3 else 'blink' if min(left,right) >= .5 else 'open-eyes'
    mouth = 'open-mouth' if feature[3] >= .25 else 'smile' if max(feature[7:9]) >= .35 else 'pucker' if max(feature[5:7]) >= .3 else 'quiet-mouth'
    return eyes + '+' + mouth
