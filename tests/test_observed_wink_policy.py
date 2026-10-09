import copy
import json
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from clean_core_admission import AdmissionPolicy, visibility_decision
from clean_core_policy_v3 import (
    FEATURE_INDEX, FEATURE_LENGTH, PROFILE_EVIDENCE_TIERS, classify_assignment,
    classify_strict_profile, observed_wink_evidence,
)

FIXTURES = json.loads((Path(__file__).parent / "fixtures/real-wink-admission.json").read_text())


def eye_fixture(left=.6, right=.1, left_opening=.08, right_opening=.25):
    feature = [0.0] * FEATURE_LENGTH
    feature[FEATURE_INDEX["eyeBlinkLeft"]] = left
    feature[FEATURE_INDEX["eyeBlinkRight"]] = right
    points = [0.0] * 936

    def point(index, x, y):
        points[index * 2:index * 2 + 2] = [x, y]

    point(362, 0, 0); point(263, 1, 0)
    point(386, .5, left_opening / 2); point(374, .5, -left_opening / 2)
    point(33, 2, 0); point(133, 3, 0)
    point(159, 2.5, right_opening / 2); point(145, 2.5, -right_opening / 2)
    return feature, points


class ObservedWinkPolicyTests(unittest.TestCase):
    def test_same_side_review_can_authorize_unchanged_observed_evidence(self):
        for row in FIXTURES["records"]:
            with self.subTest(source=row["sourceId"]):
                feature, projection = copy.deepcopy(row["feature"]), row["projection"]
                # The original isolated classifier keeps rejecting coexpression.
                self.assertIsNone(classify_strict_profile(feature, projection))
                evidence = observed_wink_evidence(feature, projection)
                self.assertEqual(evidence["side"], row["expectedSide"])
                # This tests the conditional expression rule only. Original
                # admission and separate exact-image denials still apply.
                profile, tier = classify_assignment(feature, projection, allow_observed_wink=row["expectedSide"])
                self.assertEqual(profile.name, "wink" + row["expectedSide"].title())
                self.assertEqual(tier, "observed")
                self.assertEqual(profile.purity, 0.0)
                self.assertEqual(feature, row["feature"])
                self.assertEqual(projection, row["projection"])

    def test_unreviewed_and_wrong_side_photos_cannot_supply_wink_coverage(self):
        for row in FIXTURES["records"]:
            for side in (None, "right" if row["expectedSide"] == "left" else "left"):
                with self.subTest(source=row["sourceId"], review=side):
                    assignment = classify_assignment(row["feature"], row["projection"], allow_observed_wink=side)
                    self.assertTrue(assignment is None or assignment[0].name not in ("winkLeft", "winkRight"))

    def test_strict_wink_also_needs_same_side_review_and_landmark_corroboration(self):
        feature, points = eye_fixture()
        self.assertEqual(classify_strict_profile(feature, points).name, "winkLeft")
        for side in (None, "right"):
            assignment = classify_assignment(feature, points, allow_observed_wink=side)
            self.assertTrue(assignment is None or assignment[0].name not in ("winkLeft", "winkRight"))
        profile, tier = classify_assignment(feature, points, allow_observed_wink="left")
        self.assertEqual((profile.name, tier), ("winkLeft", "strict"))
        # The historic score-only strict classifier still works for diagnostic
        # callers, but cannot establish physical wink coverage without geometry.
        self.assertEqual(classify_strict_profile(feature).name, "winkLeft")
        assignment = classify_assignment(feature, None, allow_observed_wink="left")
        self.assertTrue(assignment is None or assignment[0].name not in ("winkLeft", "winkRight"))

    def test_expression_evidence_never_overrides_the_hand_occlusion_denial(self):
        policy = AdmissionPolicy.from_document(FIXTURES["visibilityPolicy"])
        decisions = []
        for row in FIXTURES["records"]:
            decision, reason = visibility_decision(row["faceAttributes"], policy, row["visibilityReview"])
            decisions.append(decision)
            if row["visibilityReview"]["decision"] == "deny":
                self.assertEqual(row["encodedSha256"], "550ed2e191ac80d8f8fb620b81c212050b7c82b070b8c2b59103a8ce20a15d7c")
                self.assertEqual((decision, reason), ("reject", "reviewed_visibility_deny"))
        self.assertEqual(decisions.count("pass"), 5)
        self.assertEqual(decisions.count("reject"), 1)

    def test_neutral_blink_squint_and_disagreeing_geometry_are_not_observed_winks(self):
        for args in ((.1, .1, .25, .25), (.8, .8, .08, .08),
                     (.6, .2, .14, .15), (.6, .1, .25, .08)):
            with self.subTest(args=args):
                self.assertIsNone(observed_wink_evidence(*eye_fixture(*args)))

    def test_missing_nonfinite_or_pose_occluded_evidence_cannot_supply_coverage(self):
        feature, points = eye_fixture()
        self.assertIsNone(observed_wink_evidence(feature, None))
        self.assertIsNone(observed_wink_evidence(feature, points[:935]))
        self.assertIsNone(observed_wink_evidence(feature[:54], points))
        for pose_index in (0, 1):
            modified = feature.copy(); modified[pose_index] = 31 / 90
            self.assertIsNone(observed_wink_evidence(modified, points))
        modified = points.copy(); modified[386 * 2] = float("nan")
        self.assertIsNone(observed_wink_evidence(feature, modified))
        modified = feature.copy(); modified[FEATURE_INDEX["eyeBlinkLeft"]] = float("nan")
        self.assertIsNone(observed_wink_evidence(modified, points))

    def test_normalized_aperture_preserves_side_when_the_image_is_rolled(self):
        feature, points = eye_fixture()
        angle = math.radians(37)
        rolled = []
        for x, y in zip(points[::2], points[1::2]):
            rolled.extend((x * math.cos(angle) - y * math.sin(angle),
                           x * math.sin(angle) + y * math.cos(angle)))
        before = observed_wink_evidence(feature, points)
        after = observed_wink_evidence(feature, rolled)
        self.assertEqual(before["side"], after["side"])
        self.assertAlmostEqual(before["leftAperture"], after["leftAperture"])
        self.assertAlmostEqual(before["rightAperture"], after["rightAperture"])

    def test_only_declared_profiles_accept_observed_evidence(self):
        for name, tiers in PROFILE_EVIDENCE_TIERS.items():
            self.assertEqual("observed" in tiers, name in ("winkLeft", "winkRight", "mouthWide", "mouthFrown"))
        # Uncorroborated score-only mixed states remain excluded.
        feature, _ = eye_fixture()
        feature[FEATURE_INDEX["jawOpen"]] = .45
        self.assertIsNone(classify_assignment(feature))


if __name__ == "__main__":
    unittest.main()
