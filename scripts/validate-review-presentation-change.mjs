#!/usr/bin/env node
/** Permit only the reviewed initial-draw fix relative to the accepted baseline. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const acceptedBaseline = '7b6f7f0d42c18e770379bd56577e9608ba2e9f9e';
export const clientPath = 'app/live/review-client-lite.tsx';
export const baselineSha256 = '2639a28d55083e77a2b97af3791183f4543ce0619efda5a820d1489557d71984';
const hash = value => createHash('sha256').update(value).digest('hex');
const changes = [
  ['import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
    'import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";'],
  ['  }, [clipDuration, faceOnly, faceTracking, sourceAspectRatio]);\n',
    '  }, [clipDuration, faceOnly, faceTracking, sourceAspectRatio]);\n'
    + '  const drawReviewAtRef = useRef(drawReviewAt);\n'
    + '  // Processing spans renders that commit video metadata and display controls.\n'
    + '  // Its completion must use the latest committed draw, even before a seek.\n'
    + '  useLayoutEffect(() => { drawReviewAtRef.current = drawReviewAt; }, [drawReviewAt]);\n'],
  ['      await nextPaint(); checkCurrent(); drawReviewAt(0); await nextPaint(); checkCurrent();',
    '      await nextPaint(); checkCurrent(); drawReviewAtRef.current(0); await nextPaint(); checkCurrent();'],
  ['  }, [analysisFps, drawReviewAt, waitUntilPrepared]);',
    '  }, [analysisFps, waitUntilPrepared]);'],
];

export function validatePresentationChange(baseline, candidate) {
  assert.equal(typeof baseline, 'string'); assert.equal(typeof candidate, 'string');
  assert.equal(hash(baseline), baselineSha256, 'Presentation baseline bytes differ from the accepted 7b6 source');
  let expected = baseline;
  for (const [before, after] of changes) {
    assert.equal(expected.split(before).length, 2, 'An exact reviewed presentation hunk is missing or repeated');
    expected = expected.replace(before, after);
  }
  assert.equal(hash(candidate), hash(expected), 'Unreviewed video client change: only the committed-callback initial-draw fix is allowed');
  assert.equal(candidate, expected, 'Video client differs from the exact reviewed source');
  return {schemaVersion: 1, documentKind: 'review-initial-presentation-source-guard', passed: true,
    path: clientPath, baselineSha256, candidateSha256: hash(candidate), reviewedHunks: changes.length,
    permittedChange: 'Read the latest committed draw callback at async processing completion',
    allOtherClientBytesUnchanged: true};
}

export function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 2, 'Usage: node scripts/validate-review-presentation-change.mjs BASELINE_COMMIT CANDIDATE_COMMIT');
  const [baselineCommit, candidateCommit] = argv;
  assert.equal(baselineCommit, acceptedBaseline, 'The accepted baseline commit changed');
  assert(/^[0-9a-f]{40}$/.test(candidateCommit), 'Pin the full candidate commit SHA');
  const read = commit => execFileSync('git', ['show', `${commit}:${clientPath}`], {encoding: 'utf8', maxBuffer: 1024 * 1024});
  const receipt = {...validatePresentationChange(read(baselineCommit), read(candidateCommit)), baselineCommit, candidateCommit};
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
