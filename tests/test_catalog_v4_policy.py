import ast, math, sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from catalog_v4_policy import visibility_reason, pose_cell, opposite_pose, mirror_consistent, expression_tag

class CatalogV4PolicyTests(unittest.TestCase):
    def test_occlusions_are_rejected_before_admission(self):
        self.assertEqual(visibility_reason([1,1,0,0,.99]),'sunglasses')
        self.assertEqual(visibility_reason([1,1,0,.99,0]),'face_mask')
        self.assertEqual(visibility_reason([1,1,0,.25,0]),'visibility_uncertain')
    def test_clear_glasses_and_closed_eyes_are_not_rejected(self):
        self.assertIsNone(visibility_reason([0,1,.99,0,0]))
        self.assertIsNone(visibility_reason([0,0,0,.01,.01]))
    def test_bad_model_output_never_means_pass(self):
        for x in ([0]*4,[0,0,0,math.nan,0],[0,0,0,2,0]):
            with self.assertRaises(ValueError): visibility_reason(x)
    def test_pose_is_not_clamped_into_a_false_bin(self):
        f=[0.]*55; f[0]=60/90; self.assertIsNone(pose_cell(f))
        f[0]=24/90; self.assertEqual(pose_cell(f),'24:0')
    def test_opposite_and_unstable_poses(self):
        self.assertTrue(opposite_pose(25,-20)); self.assertFalse(opposite_pose(3,-2))
        self.assertTrue(mirror_consistent(25,-23)); self.assertFalse(mirror_consistent(25,23))
    def test_wink_plus_smile_is_preserved(self):
        f=[0.]*55; f[13]=.8; f[7]=.7
        self.assertEqual(expression_tag(f),'left-wink+smile')
    def test_complete_builder_is_parseable(self):
        p=Path(__file__).resolve().parents[1]/'tools/build_clean_core_v3.py'
        tree=ast.parse(p.read_text()); self.assertTrue(any(isinstance(n,ast.FunctionDef) and n.name=='main' for n in tree.body))

if __name__=='__main__': unittest.main()
