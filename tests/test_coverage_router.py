from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from coverage_router import CoverageRouter


class CoverageRouterTest(unittest.TestCase):
    def make_plan(self, queue: list[dict[str, object]]) -> Path:
        directory = Path(tempfile.mkdtemp(prefix="coverage-router-test-"))
        path = directory / "plan.json"
        path.write_text(
            json.dumps({"poseStep": 9, "collectionQueue": queue}),
            encoding="utf-8",
        )
        return path

    def test_assigns_measured_configuration_to_nearest_open_gap(self) -> None:
        plan = self.make_plan([
            {
                "yaw": 0,
                "pitch": 0,
                "configuration": "smileOpen",
                "recommendedAdditions": 2,
                "pressure": 4.0,
            },
            {
                "yaw": 9,
                "pitch": 0,
                "configuration": "smileOpen",
                "recommendedAdditions": 2,
                "pressure": 4.0,
            },
        ])
        router = CoverageRouter(plan, yaw_tolerance=9, pitch_tolerance=9)
        assignment = router.assign(7.5, 0.2, {"smileOpen", "mouthOpen"})
        self.assertIsNotNone(assignment)
        self.assertEqual(assignment.pose, "9:0")
        self.assertEqual(assignment.configuration, "smileOpen")

    def test_respects_quota_and_reports_assignment(self) -> None:
        plan = self.make_plan([
            {
                "yaw": -18,
                "pitch": 9,
                "configuration": "winkLeft",
                "recommendedAdditions": 1,
                "pressure": 8.0,
            }
        ])
        router = CoverageRouter(plan)
        first = router.assign(-17.0, 8.0, {"winkLeft"})
        second = router.assign(-17.0, 8.0, {"winkLeft"})
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        report = router.report()
        self.assertEqual(report["assigned"], 1)
        self.assertEqual(report["remaining"], 0)
        self.assertEqual(report["assignedByGap"]["-18:9|winkLeft"], 1)

    def test_spreads_tied_faces_across_open_quotas(self) -> None:
        plan = self.make_plan([
            {
                "yaw": 0,
                "pitch": 0,
                "configuration": "neutral",
                "recommendedAdditions": 2,
                "pressure": 3.0,
            },
            {
                "yaw": 9,
                "pitch": 0,
                "configuration": "neutral",
                "recommendedAdditions": 2,
                "pressure": 3.0,
            },
        ])
        router = CoverageRouter(plan, yaw_tolerance=9, pitch_tolerance=9)
        first = router.assign(4.5, 0.0, {"neutral"})
        second = router.assign(4.5, 0.0, {"neutral"})
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertNotEqual(first.pose, second.pose)

    def test_rejects_faces_that_fill_no_remaining_gap(self) -> None:
        plan = self.make_plan([
            {
                "yaw": 0,
                "pitch": 0,
                "configuration": "neutral",
                "recommendedAdditions": 3,
                "pressure": 1.0,
            }
        ])
        router = CoverageRouter(plan)
        self.assertIsNone(router.assign(30.0, 0.0, {"neutral"}))
        self.assertIsNone(router.assign(0.0, 0.0, {"smileOpen"}))


if __name__ == "__main__":
    unittest.main()
