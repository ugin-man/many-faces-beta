import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIGURATION_SEARCH_TERMS,
  isLikelyPhotoCandidate,
  searchQueriesForGap,
  selectDiverseGaps,
} from "../tools/stage-openverse-coverage.mjs";

const CONFIGURATIONS = [
  "neutral", "winkLeft", "winkRight", "blink", "eyesWide",
  "gazeUp", "gazeDown", "gazeLeft", "gazeRight", "browsUp", "browsDown",
  "smileClosed", "smileOpen", "smileAsymmetric", "frown", "mouthOpen",
  "mouthRound", "mouthWide", "pucker", "mouthLeft", "mouthRight",
  "mouthPress", "mouthRoll", "mouthShrug", "sneer", "jawLeft",
  "jawRight", "jawForward",
];

test("every coverage configuration has human-readable search terms", () => {
  for (const configuration of CONFIGURATIONS) {
    assert.ok(CONFIGURATION_SEARCH_TERMS[configuration]?.length, configuration);
    const queries = searchQueriesForGap({ configuration, yaw: 27, pitch: 18 });
    assert.ok(queries.length >= 3, configuration);
    assert.ok(
      queries.some((query) => query.includes(CONFIGURATION_SEARCH_TERMS[configuration][0])),
      `${configuration}: ${queries.join(" | ")}`,
    );
    if (/[A-Z]/.test(configuration)) {
      assert.ok(queries.every((query) => !query.includes(configuration)), `${configuration}: ${queries.join(" | ")}`);
    }
  }
});

test("smoke selection favors attainable allowed gaps", () => {
  const rows = [
    { configuration: "winkLeft", query: "x", recommendedAdditions: 50, yaw: 27, pitch: 18, poseCurrent: 3, pressure: 9 },
    { configuration: "smileOpen", query: "x", recommendedAdditions: 40, yaw: 27, pitch: 18, poseCurrent: 60, pressure: 5 },
    { configuration: "smileOpen", query: "x", recommendedAdditions: 30, yaw: 0, pitch: 0, poseCurrent: 500, pressure: 3 },
    { configuration: "neutral", query: "x", recommendedAdditions: 20, yaw: 0, pitch: 0, poseCurrent: 700, pressure: 2 },
  ];
  const selected = selectDiverseGaps(rows, 2, 27, 18, {
    configurations: new Set(["smileOpen", "neutral"]),
    minPoseCurrent: 40,
    selection: "smoke",
  });
  assert.deepEqual(selected.map((row) => row.configuration), ["smileOpen", "neutral"]);
  assert.equal(selected[0].yaw, 0);
});

test("obvious non-photographic objects are rejected before curation", () => {
  assert.equal(isLikelyPhotoCandidate("Bronze portrait bust"), false);
  assert.equal(isLikelyPhotoCandidate("Museum figurine head"), false);
  assert.equal(isLikelyPhotoCandidate("A smiling person outdoors"), true);
});
