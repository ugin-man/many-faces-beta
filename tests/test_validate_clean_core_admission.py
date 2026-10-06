import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from validate_clean_core_admission import final_entries


class PhysicalPoseAssignmentTests(unittest.TestCase):
    def test_balanced_cross_cell_swap_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "shards").mkdir()
            manifest = {"cells": {"-15:0": {"count": 1, "shards": ["left.json"]}, "15:0": {"count": 1, "shards": ["right.json"]}}}
            for cell, filename, yaw in (("-15:0", "left.json", -15), ("15:0", "right.json", 15)):
                (root / "shards" / filename).write_text(json.dumps({"cell": cell, "items": [{"feature": [yaw / 90, 0, 0] + [0] * 52}]}))
            self.assertEqual(len(list(final_entries(root, manifest))), 2)
            # Headers and aggregate fresh pose counts still look correct after
            # this equal-size swap, but each photo is now in the opposite shard.
            for cell, filename, yaw in (("-15:0", "left.json", 15), ("15:0", "right.json", -15)):
                (root / "shards" / filename).write_text(json.dumps({"cell": cell, "items": [{"feature": [yaw / 90, 0, 0] + [0] * 52}]}))
            with self.assertRaisesRegex(ValueError, "wrong physical pose cell"):
                list(final_entries(root, manifest))


if __name__ == "__main__":
    unittest.main()
