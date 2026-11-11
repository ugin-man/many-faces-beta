// Independent scalar oracle: import the unchanged production implementation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {projectionError, ProjectionDescriptorCache} from '../../app/projection-matching.ts';
import {FACE_ACTION_KEYS} from '../../app/face-actions.ts';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: node strict-reference.mjs INPUT.json OUTPUT.json');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const candidate = record => ({id: record.id, feature: record.feature,
  geometry: {projection: record.projection, structure: [], surface: [], layout: [0, 0, 1, 1]}});
const candidates = input.candidates.map(candidate);
const cache = new ProjectionDescriptorCache();
const results = [];
for (const compensateRoll of [false, true]) {
  for (const record of input.queries) {
    const frame = {...candidate(record), time: 0, compensateRoll};
    const errors = candidates.map(item => projectionError(frame, item, cache));
    const rank = errors.map((error, index) => ({score: error.strictTotal, index}))
      .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.index);
    results.push({query: record.id, compensateRoll, errors, rank});
  }
}
const sourceHashes = Object.fromEntries(['../../app/projection-matching.ts', '../../app/face-actions.ts'].map(file =>
  [file, crypto.createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]));
fs.writeFileSync(outputPath, JSON.stringify({sourceHashes, actionKeys: FACE_ACTION_KEYS, results}));
