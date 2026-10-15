import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from clean_core_policy_v3 import (
    FEATURE_INDEX, FEATURE_LENGTH, PROFILE_EVIDENCE_TIERS, classify_assignment,
    classify_observed_mouth_profile, classify_strict_profile, quantized_pose_cell,
)
from clean_core_selection_review import SelectionReview

FIXTURES = json.loads((Path(__file__).parent / "fixtures/real-mouth-admission.json").read_text())
WINKS = json.loads((Path(__file__).parent / "fixtures/real-wink-admission.json").read_text())
PROJECTION = FIXTURES["records"][0]["projection"]


def feature_for(profile, strength):
    feature = [0.0] * FEATURE_LENGTH
    action = "mouthStretch" if profile == "mouthWide" else "mouthFrown"
    for side in ("Left", "Right"):
        feature[FEATURE_INDEX[action + side]] = strength
    feature[FEATURE_INDEX["browInnerUp"]] = .7
    return feature


def set_actions(feature, actions):
    for action, value in actions.items():
        feature[FEATURE_INDEX[action]] = value
    return feature


class ObservedMouthPolicyTests(unittest.TestCase):
    def test_real_mouth_shapes_with_eye_and_brow_coexpression_retain_all_raw_values(self):
        examples = [row for row in FIXTURES["records"] if not row["reviewedSelectionDeny"]]
        self.assertEqual(len(examples), 7)
        for row in examples:
            with self.subTest(sample=row["sampleId"]):
                feature, projection = copy.deepcopy(row["feature"]), row["projection"]
                self.assertEqual(row["originalAdmissionDecision"], "pass")
                self.assertIsNone(classify_strict_profile(feature, projection))
                profile, tier = classify_assignment(feature, projection)
                self.assertEqual((profile.name, tier), (row["expectedObservedProfile"], "observed"))
                self.assertEqual(profile.purity, 0.0)
                self.assertEqual(feature, row["feature"])
                self.assertEqual(projection, row["projection"])

    def test_observed_expression_cannot_override_exact_original_pixel_denials(self):
        document = FIXTURES["selectionReviewDocument"]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "review.json"
            path.write_text(json.dumps(document))
            review = SelectionReview(path, document["candidateAuditSha256"], document["recordsSha256"])
            denied = [row for row in FIXTURES["records"] if row["reviewedSelectionDeny"]]
            self.assertEqual(len(denied), 4)
            for row in denied:
                with self.subTest(sample=row["sampleId"]):
                    self.assertEqual(row["originalAdmissionDecision"], "pass")
                    observed = classify_observed_mouth_profile(row["feature"], row["projection"])
                    self.assertEqual(observed.name, row["expectedObservedProfile"])
                    self.assertTrue(review.excludes(row["encodedSha256"]))

    def test_wide_keeps_existing_direct_mouth_cutoffs(self):
        feature = feature_for("mouthWide", .23)
        self.assertEqual(classify_observed_mouth_profile(feature, PROJECTION).name, "mouthWide")
        variants = (
            {"mouthStretchLeft": .2299, "mouthStretchRight": .2299},
            {"mouthSmileLeft": .2701, "mouthSmileRight": .2701},
            {"mouthFunnel": .2301}, {"mouthPucker": .2301},
            {"mouthFrownLeft": .1901, "mouthFrownRight": .1901},
        )
        for changes in variants:
            with self.subTest(changes=changes):
                self.assertIsNone(classify_observed_mouth_profile(set_actions(feature.copy(), changes), PROJECTION))

    def test_frown_keeps_effective_strength_floor_and_direct_mouth_cutoffs(self):
        feature = feature_for("mouthFrown", .20)
        self.assertEqual(classify_observed_mouth_profile(feature, PROJECTION).name, "mouthFrown")
        variants = (
            {"mouthFrownLeft": .1999, "mouthFrownRight": .1999},
            {"jawOpen": .2401}, {"mouthSmileLeft": .2101, "mouthSmileRight": .2101},
            {"mouthPucker": .2301}, {"mouthStretchLeft": .2301, "mouthStretchRight": .2301},
        )
        for changes in variants:
            with self.subTest(changes=changes):
                self.assertIsNone(classify_observed_mouth_profile(set_actions(feature.copy(), changes), PROJECTION))

    def test_only_eye_and_brow_coexpression_is_newly_supported(self):
        for target, strength in (("mouthWide", .4), ("mouthFrown", .4)):
            feature = feature_for(target, strength)
            set_actions(feature, {"browDownLeft": .8, "browDownRight": .8,
                                  "eyeLookUpLeft": .7, "eyeLookUpRight": .7,
                                  "eyeSquintLeft": .7, "eyeSquintRight": .7})
            self.assertEqual(classify_observed_mouth_profile(feature, PROJECTION).name, target)
            for changes in ({"noseSneerLeft": .1501, "noseSneerRight": .1501},
                            {"jawLeft": .1801}, {"jawRight": .1801}, {"jawForward": .1401}):
                with self.subTest(target=target, changes=changes):
                    self.assertIsNone(classify_observed_mouth_profile(set_actions(feature.copy(), changes), PROJECTION))

    def test_isolated_and_observed_wink_assignments_keep_priority(self):
        for name in ("mouthWide", "mouthFrown"):
            feature = feature_for(name, .4)
            feature[FEATURE_INDEX["browInnerUp"]] = 0
            profile, tier = classify_assignment(feature, PROJECTION)
            self.assertEqual((profile.name, tier), (name, "strict"))
        row = WINKS["records"][0]
        feature = row["feature"].copy()
        set_actions(feature, {"mouthStretchLeft": .4, "mouthStretchRight": .4,
                              "mouthSmileLeft": 0, "mouthSmileRight": 0,
                              "mouthFrownLeft": 0, "mouthFrownRight": 0,
                              "mouthFunnel": 0, "mouthPucker": 0,
                              "noseSneerLeft": 0, "noseSneerRight": 0,
                              "jawLeft": 0, "jawRight": 0, "jawForward": 0,
                              "browInnerUp": .7})
        self.assertEqual(classify_observed_mouth_profile(feature, row["projection"]).name, "mouthWide")
        profile, tier = classify_assignment(feature, row["projection"], allow_observed_wink=row["expectedSide"])
        self.assertEqual((profile.name, tier), ("wink" + row["expectedSide"].title(), "observed"))
        # Without a same-side visual confirmation, a useful coexpression can
        # still enter its independently supported mouth profile.
        profile, tier = classify_assignment(feature, row["projection"])
        self.assertEqual((profile.name, tier), ("mouthWide", "observed"))

    def test_missing_nonfinite_measurements_cannot_become_observed_coverage(self):
        feature = feature_for("mouthWide", .4)
        self.assertIsNone(classify_observed_mouth_profile(feature[:54], PROJECTION))
        self.assertIsNone(classify_observed_mouth_profile(feature, None))
        self.assertIsNone(classify_observed_mouth_profile(feature, [0] * 935))
        feature[FEATURE_INDEX["mouthStretchLeft"]] = float("nan")
        self.assertIsNone(classify_observed_mouth_profile(feature, PROJECTION))

    def test_existing_pose_clamping_remains_and_never_reverses_sign(self):
        feature = feature_for("mouthWide", .4)
        feature[:2] = [.60, -.50]
        profile = classify_observed_mouth_profile(feature, PROJECTION)
        self.assertEqual((profile.yaw, profile.pitch), (54, -45))
        self.assertEqual(quantized_pose_cell(feature, 3), ("45:-36", 45, -36))
        self.assertEqual(PROFILE_EVIDENCE_TIERS["mouthWide"], ("strict", "observed"))
        self.assertEqual(PROFILE_EVIDENCE_TIERS["mouthFrown"], ("strict", "observed"))


if __name__ == "__main__":
    unittest.main()
