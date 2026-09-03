"""Assign measured faces to remaining coverage-plan gaps."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass
class CoverageSlot:
    yaw: int
    pitch: int
    configuration: str
    remaining: int
    pressure: float
    initial: int

    @property
    def pose(self) -> str:
        return f"{self.yaw}:{self.pitch}"

    @property
    def key(self) -> str:
        return f"{self.pose}|{self.configuration}"


class CoverageRouter:
    def __init__(
        self,
        plan_path: Path,
        *,
        yaw_tolerance: float = 9.0,
        pitch_tolerance: float = 9.0,
    ) -> None:
        payload = json.loads(plan_path.read_text(encoding="utf-8"))
        self.pose_step = max(1, int(payload.get("poseStep", 9)))
        self.yaw_tolerance = max(float(yaw_tolerance), self.pose_step / 2)
        self.pitch_tolerance = max(float(pitch_tolerance), self.pose_step / 2)
        self.slots: list[CoverageSlot] = []
        for item in payload.get("collectionQueue", []):
            remaining = int(item.get("recommendedAdditions", 0) or 0)
            if remaining <= 0:
                continue
            self.slots.append(
                CoverageSlot(
                    yaw=int(item["yaw"]),
                    pitch=int(item["pitch"]),
                    configuration=str(item["configuration"]),
                    remaining=remaining,
                    pressure=float(item.get("pressure", 0.0) or 0.0),
                    initial=remaining,
                )
            )
        self.by_configuration: dict[str, list[CoverageSlot]] = {}
        for slot in self.slots:
            self.by_configuration.setdefault(slot.configuration, []).append(slot)
        for slots in self.by_configuration.values():
            slots.sort(key=lambda slot: (-slot.pressure, slot.yaw, slot.pitch))
        self.assigned: dict[str, int] = {}

    def assign(
        self,
        yaw: float,
        pitch: float,
        configurations: Iterable[str],
    ) -> CoverageSlot | None:
        candidates: list[tuple[float, CoverageSlot]] = []
        for configuration in configurations:
            for slot in self.by_configuration.get(configuration, []):
                if slot.remaining <= 0:
                    continue
                yaw_distance = abs(float(yaw) - slot.yaw)
                pitch_distance = abs(float(pitch) - slot.pitch)
                if yaw_distance > self.yaw_tolerance or pitch_distance > self.pitch_tolerance:
                    continue
                normalized_distance = math.hypot(
                    yaw_distance / max(1.0, self.yaw_tolerance),
                    pitch_distance / max(1.0, self.pitch_tolerance),
                )
                quota_headroom = slot.remaining / max(1, slot.initial)
                score = slot.pressure - normalized_distance * 0.55 + quota_headroom * 0.08
                candidates.append((score, slot))
        if not candidates:
            return None
        _, selected = max(
            candidates,
            key=lambda item: (item[0], item[1].pressure, item[1].remaining, item[1].key),
        )
        selected.remaining -= 1
        self.assigned[selected.key] = self.assigned.get(selected.key, 0) + 1
        return selected

    def report(self) -> dict[str, object]:
        return {
            "assigned": sum(self.assigned.values()),
            "assignedByGap": dict(
                sorted(self.assigned.items(), key=lambda item: (-item[1], item[0]))
            ),
            "remaining": sum(slot.remaining for slot in self.slots),
            "openGaps": sum(1 for slot in self.slots if slot.remaining > 0),
        }
