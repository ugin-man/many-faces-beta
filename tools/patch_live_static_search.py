#!/usr/bin/env python3
"""Apply the one-time static-search optimization to the realtime lab.

The patch is intentionally idempotent. It is executed by the realtime CI once,
then removed after the optimized source has been committed and verified.
"""

from __future__ import annotations

import re
from pathlib import Path

PATH = Path("app/live-responsive-lab.tsx")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} marker not found")
    return text.replace(old, new, 1)


def main() -> int:
    text = PATH.read_text(encoding="utf-8")
    if "shouldRunLiveSearch" in text and "lastSearchStatsRef" in text:
        print("Static-search optimization already applied.")
        return 0

    text = replace_once(
        text,
        '  selectReadyRankedCandidate,\n} from "./live-responsive-runtime";',
        '  selectReadyRankedCandidate,\n  shouldRunLiveSearch,\n} from "./live-responsive-runtime";',
        "responsive runtime import",
    )
    text = replace_once(
        text,
        "  const maxOutputRateRef = useRef(20);\n",
        "  const maxOutputRateRef = useRef(20);\n"
        "  const lastSearchStatsRef = useRef({\n"
        "    searchMs: 0,\n"
        "    inspected: 0,\n"
        "    bucketHits: 0,\n"
        "  });\n",
        "search stats ref",
    )
    text = replace_once(
        text,
        "    lastFeatureAtRef.current = 0;\n",
        "    lastFeatureAtRef.current = 0;\n"
        "    lastSearchStatsRef.current = { searchMs: 0, inspected: 0, bucketHits: 0 };\n",
        "tracking reset",
    )

    pattern = re.compile(
        r"\n\s+void loadCatalogNeighborhood\("
        r".*?"
        r"\n\s+updateTelemetry\(\s*"
        r"now,\s*searchMs,\s*ranked\.inspected,\s*ranked\.bucketHits,\s*"
        r"decision\.targetRate,\s*decision\.total,\s*\);",
        re.DOTALL,
    )
    replacement = """
      const decision = switchControllerRef.current.observe(
        now,
        smoothedFeature,
        maxOutputRateRef.current,
      );
      let { searchMs, inspected, bucketHits } = lastSearchStatsRef.current;

      if (shouldRunLiveSearch(currentRef.current?.id ?? null, decision)) {
        void loadCatalogNeighborhood(
          smoothedFeature[0] * 90,
          smoothedFeature[1] * 90,
          predicted.yaw,
          predicted.pitch,
        );

        const searchStarted = performance.now();
        const ranked = rankLiveCandidates(
          candidateIndexRef.current,
          { feature: smoothedFeature, geometry: smoothedGeometry },
          {
            mode: modeRef.current,
            budget: RANK_BUDGET,
            detailedLimit: DETAILED_LIMIT,
            currentId: currentRef.current?.id,
            recentIds: recentIdsRef.current,
            holdBias: 0.001,
            diversityPenalty: 0.004,
            hysteresis: 0.001,
          },
        );
        searchMs = performance.now() - searchStarted;
        inspected = ranked.inspected;
        bucketHits = ranked.bucketHits;
        lastSearchStatsRef.current = { searchMs, inspected, bucketHits };

        const candidates = ranked.ranked.map((item) => item.candidate);
        const buffer = imageBufferRef.current;
        if (buffer && candidates.length) {
          void buffer.prime(candidates, {
            maxImages: 36,
            maxNewPacks: 2,
          });
        }

        const selected = buffer
          ? selectReadyRankedCandidate(
              ranked.ranked,
              (candidate) => buffer.isReady(candidate),
              currentRef.current?.id ?? null,
              recentIdsRef.current.slice(0, 4),
            )
          : null;

        if (!currentRef.current && ranked.ranked[0] && buffer) {
          const first = ranked.ranked[0].candidate;
          if (buffer.isReady(first)) {
            showReadyCandidate(first, now);
          } else {
            void buffer.ensure(first).then((url) => {
              if (url && trackingRef.current && !currentRef.current) {
                showReadyCandidate(first, performance.now());
              }
            });
          }
        } else if (
          decision.shouldSwitch &&
          selected &&
          selected.candidate.id !== currentRef.current?.id
        ) {
          showReadyCandidate(selected.candidate, now);
        }
      }

      updateTelemetry(
        now,
        searchMs,
        inspected,
        bucketHits,
        decision.targetRate,
        decision.total,
      );"""
    text, count = pattern.subn(replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"live ranking block marker matched {count} times")

    PATH.write_text(text, encoding="utf-8")
    print("Applied static-search optimization.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
