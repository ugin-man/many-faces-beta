import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeSupplementCatalog } from "../tools/finalize-supplement-catalog.mjs";

async function makeCatalog(entry) {
  const root = await mkdtemp(path.join(tmpdir(), "many-faces-finalize-test-"));
  await mkdir(path.join(root, "shards"), { recursive: true });
  await writeFile(path.join(root, "shards", "cell.json"), JSON.stringify({
    cell: "0:0",
    items: [entry],
  }));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 3,
    totalFaces: 1,
    featureLength: 55,
    shardsContainGeometry: true,
    cells: { "0:0": { count: 1, shards: ["cell.json"] } },
  }));
  return root;
}

const licensedEntry = {
  id: "face-1",
  sourceName: "Openverse",
  sourceUrl: "https://example.com/source",
  creator: "Example creator",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};

test("finalizer records searchable totals only after provenance passes", async () => {
  const root = await makeCatalog(licensedEntry);
  const result = await finalizeSupplementCatalog(root, "coverage-smoke-001");
  assert.equal(result.provenanceComplete, true);
  assert.equal(result.searchableFaces, 1);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.catalogId, "coverage-smoke-001");
  assert.equal(manifest.totalFaces, 1);
  assert.equal(manifest.sourceFaces, 1);
  assert.equal(manifest.searchableFaces, 1);
  assert.deepEqual(manifest.indexFiles, []);
  assert.equal(manifest.stats.provenance.licensedEntries, 1);
});

test("finalizer rejects a batch whose source license was lost", async () => {
  const root = await makeCatalog({ ...licensedEntry, license: "Unspecified" });
  await assert.rejects(
    finalizeSupplementCatalog(root, "coverage-smoke-bad"),
    /missing license/,
  );
});
