import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {baselineSha256, validatePresentationChange} from '../scripts/validate-review-presentation-change.mjs';

const candidate = readFileSync(new URL('../app/live/review-client-lite.tsx', import.meta.url), 'utf8');
// Reconstruct the old source in shallow CI checkouts without downloading Git
// history. The production guard pins every resulting byte to its known SHA-256;
// an unrelated source change cannot turn this into a different accepted baseline.
const baseline = candidate
  .replace('useEffect, useLayoutEffect, useMemo', 'useEffect, useMemo')
  .replace('  const drawReviewAtRef = useRef(drawReviewAt);\n'
    + '  // Processing spans renders that commit video metadata and display controls.\n'
    + '  // Its completion must use the latest committed draw, even before a seek.\n'
    + '  useLayoutEffect(() => { drawReviewAtRef.current = drawReviewAt; }, [drawReviewAt]);\n', '')
  .replace('checkCurrent(); drawReviewAtRef.current(0);', 'checkCurrent(); drawReviewAt(0);')
  .replace('[analysisFps, waitUntilPrepared]', '[analysisFps, drawReviewAt, waitUntilPrepared]');

test('exact approved initial-draw delta is accepted and binds both complete files', () => {
  const result = validatePresentationChange(baseline, candidate);
  assert.equal(result.passed, true); assert.equal(result.baselineSha256, baselineSha256);
  assert.equal(result.allOtherClientBytesUnchanged, true); assert.equal(result.reviewedHunks, 4);
  assert.match(result.candidateSha256, /^[0-9a-f]{64}$/);
});

const mutations = [
  ['rollback to the stale completion closure', source => source.replace('checkCurrent(); drawReviewAtRef.current(0);', 'checkCurrent(); drawReviewAt(0);')],
  ['passive rather than committed callback update', source => source.replace('useLayoutEffect(() => { drawReviewAtRef.current', 'useEffect(() => { drawReviewAtRef.current')],
  ['disabled face position tracking', source => source.replace('trackFace: faceTracking, faceOnly', 'trackFace: false, faceOnly')],
  ['changed video aspect calculation', source => source.replace('video.videoWidth / video.videoHeight : 1', '1')],
  ['changed frame acquisition', source => source.replace('captureVideoFrameAt(video, time,', 'captureVideoFrameAt(video, 0,')],
  ['removed cancellation check', source => source.replace('await nextPaint(); checkCurrent(); drawReviewAtRef', 'await nextPaint(); drawReviewAtRef')],
  ['any additional client bytes', source => source + '\n// unrelated client change\n'],
];
for (const [label, mutate] of mutations) test(`source gate rejects ${label}`, () => {
  const altered = mutate(candidate); assert.notEqual(altered, candidate, 'Mutation must exercise actual production text');
  assert.throws(() => validatePresentationChange(baseline, altered), /Unreviewed video client change/);
});

test('source gate rejects a changed baseline even when both sides share that change', () => {
  assert.throws(() => validatePresentationChange(baseline + '\n', candidate + '\n'), /baseline bytes differ/);
});

test('both browser workflows invoke the exact-delta gate and retain the independent drawing-math and camera diff', () => {
  for (const name of ['clean-core-v5-qa.yml', 'video-speed.yml']) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.match(workflow, /node scripts\/validate-review-presentation-change\.mjs "\$(?:VIDEO_)?BASELINE_COMMIT" "\$GITHUB_SHA"/);
    assert.match(workflow, /presentation-source-guard\.json/);
    for (const protectedPath of ['app/live/astra', 'app/live/media-input.ts', 'app/live/frame-arrival.ts', 'app/face-presentation.ts', 'app/offline-matching.ts', 'app/call-stage.tsx', 'app/live/review-timeline.ts']) {
      assert(workflow.includes(protectedPath), `${name} dropped protection for ${protectedPath}`);
    }
  }
});
