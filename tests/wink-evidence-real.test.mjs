import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {winkEvidence} from '../app/live/wink-evidence.ts';

test('live wink evidence agrees with the unchanged real-photo selection fixtures', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/real-wink-admission.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.records.length, 6);
  for (const row of fixtures.records) {
    const bytes = Buffer.from(row.projection, 'base64');
    const projection = Array.from({length: bytes.length / 2}, (_, index) => bytes.readInt16LE(index * 2) / 4096);
    const before = [...row.feature];
    assert.equal(winkEvidence(row.feature, projection)?.side, row.expectedSide, row.sourceId);
    assert.deepEqual(row.feature, before);
  }
});
