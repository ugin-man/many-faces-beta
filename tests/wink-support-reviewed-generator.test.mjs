import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {admittedCoreWink, readWinkExpressionReview} from '../scripts/rebuild-clean-wink-support.mjs';
import {FACE_ACTION_FEATURE_INDEX as I} from '../app/face-actions.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(await readFile(new URL('./fixtures/reviewed-wink-admission.json', import.meta.url)));
const document = fixture.reviewDocument;

function binding(value = document) {
  const raw = Buffer.from(JSON.stringify(value)), reviewSha256 = digest(raw);
  const confirmed = value.reviews.filter(row => row.decision === 'confirmed');
  const stamp = {
    schemaVersion: 1, documentKind: 'clean-core-wink-expression-review', mode: 'confirmed-side-only',
    reviewPath: 'wink-expression-review.json', reviewSha256,
    candidateAuditSha256: value.candidateAuditSha256, recordsSha256: value.recordsSha256,
    reviewedEncodedImages: value.reviews.length, confirmedEncodedImages: confirmed.length,
    confirmedSides: {left: confirmed.filter(row => row.side === 'left').length, right: confirmed.filter(row => row.side === 'right').length},
    reviewer: value.reviewer, humanVerified: value.humanVerified, reviewedOn: value.reviewedOn,
  };
  return {raw, manifest: {
    qualityAdmission: {receiptSha256: document.candidateAuditSha256, recordsSha256: document.recordsSha256},
    selectionIdentity: {winkExpressionReviewSha256: reviewSha256}, winkExpressionReview: stamp,
  }};
}

test('generator reads only exact same-audit assistant confirmations, leaving disputed examples unlabeled', () => {
  const {raw, manifest} = binding(), result = readWinkExpressionReview(raw, manifest);
  assert.equal(result.sha256, digest(raw));
  assert.deepEqual(result.stamp, manifest.winkExpressionReview);
  assert.deepEqual([...result.sides], document.reviews.filter(row => row.decision === 'confirmed').map(row => [row.encodedSha256, row.side]));
  assert.equal(result.sides.size, 2);
  for (const row of document.reviews.filter(row => row.decision !== 'confirmed')) assert.equal(result.sides.has(row.encodedSha256), false);
});

test('review bytes, counts and selection identity are all bound independently', () => {
  const {raw, manifest} = binding();
  assert.throws(() => readWinkExpressionReview(Buffer.concat([raw, Buffer.from('\n')]), manifest), /exact file/);
  for (const patch of [{reviewedEncodedImages: 70000}, {confirmedEncodedImages: 70000}, {reviewPath: '../other.json'}, {reviewSha256: 'f'.repeat(64)}]) {
    assert.throws(() => readWinkExpressionReview(raw, {...manifest, winkExpressionReview: {...manifest.winkExpressionReview, ...patch}}), /exact file/);
  }
  assert.throws(() => readWinkExpressionReview(raw, {...manifest, selectionIdentity: {winkExpressionReviewSha256: 'f'.repeat(64)}}), /Selection identity/);
});

test('another audit, automatic-only declarations and invalid visual evidence fail closed', () => {
  for (const patch of [{candidateAuditSha256: 'f'.repeat(64)}, {recordsSha256: 'f'.repeat(64)},
    {mode: 'automatic-only'}, {humanVerified: true}, {reviewer: 'human'}, {reviewedOn: '2026-02-30'}]) {
    const value = {...document, ...patch}, {raw, manifest} = binding(value);
    assert.throws(() => readWinkExpressionReview(raw, manifest));
  }
  for (const patch of [{decision: 'allow'}, {decision: 'uncertain', side: 'left'}, {reason: ''},
    {encodedSha256: 'not-a-digest'}, {evidence: {imageSha256: 'f'.repeat(64)}}, {evidence: {pixelChangesApplied: true}}]) {
    const value = structuredClone(document); value.reviews[0] = {...value.reviews[0], ...patch};
    const {raw, manifest} = binding(value);
    assert.throws(() => readWinkExpressionReview(raw, manifest));
  }
  const repeated = structuredClone(document); repeated.reviews.push(repeated.reviews[0]);
  const {raw, manifest} = binding(repeated);
  assert.throws(() => readWinkExpressionReview(raw, manifest), /repeated/);
});

// A retained historical pixel fixture exercises the conditional index contract.
// This does not admit it into a final catalog or override separate image denials.
const pilot = JSON.parse(await readFile(new URL('../data/wink-pilot/catalog.json', import.meta.url)));
const original = pilot.items.find(row => row.side === 'left');
const bytes = await readFile(new URL('../data/wink-pilot/images/' + original.image, import.meta.url));
const encodedSha256 = digest(bytes), policySha256 = 'a'.repeat(64), reviewSha256 = 'b'.repeat(64);
const entry = {...original, id: 'clean-v5-' + encodedSha256.slice(0, 28), pack: 'final.bin', offset: 0, length: bytes.length,
  admissionSha256: encodedSha256, admissionPolicySha256: policySha256,
  cleanProfile: 'winkLeft', cleanTier: 'observed',
  winkExpressionEvidence: {schemaVersion: 1, encodedSha256, side: 'left', reviewSha256}};
delete entry.image;
const winkReview = {sha256: reviewSha256, sides: new Map([[encodedSha256, 'left']]), stamp: {reviewSha256}};

test('an ordinary core photo with automatic asymmetry never re-enters the specialist index', () => {
  const background = {...entry, cleanProfile: 'backgroundEyes', cleanTier: 'background'};
  delete background.winkExpressionEvidence;
  assert.equal(admittedCoreWink(background, bytes, policySha256, winkReview), null);
  assert.equal(admittedCoreWink({...background, cleanProfile: 'mouthWide', cleanTier: 'observed'}, bytes, policySha256, winkReview), null);
});

test('both strict and observed selected winks require the exact reviewed image and side', () => {
  for (const cleanTier of ['strict', 'observed']) {
    const unchanged = JSON.stringify(entry), row = admittedCoreWink({...entry, cleanTier}, bytes, policySha256, winkReview);
    assert.equal(row.cleanTier, cleanTier);
    assert.deepEqual(row.winkExpressionEvidence, entry.winkExpressionEvidence);
    assert.deepEqual(row.feature, entry.feature);
    assert.equal(row.projection, entry.projection);
    assert.equal(JSON.stringify(entry), unchanged);
    for (const sides of [new Map(), new Map([[encodedSha256, 'right']]), new Map([['f'.repeat(64), 'left']])]) {
      assert.throws(() => admittedCoreWink({...entry, cleanTier}, bytes, policySha256, {...winkReview, sides}), /visual confirmation/);
    }
  }
  assert.throws(() => admittedCoreWink(entry, bytes, policySha256), /bound wink review/);
  assert.throws(() => admittedCoreWink({...entry, winkExpressionEvidence: {...entry.winkExpressionEvidence, reviewSha256: 'c'.repeat(64)}}, bytes, policySha256, winkReview), /review evidence/);
});

test('a review cannot override failed automatic corroboration or invent a supported tier', () => {
  const feature = [...entry.feature];
  feature[I.eyeBlinkLeft] = .01; feature[I.eyeBlinkRight] = .01;
  assert.throws(() => admittedCoreWink({...entry, feature}, bytes, policySha256, winkReview), /automatic corroboration/);
  assert.throws(() => admittedCoreWink({...entry, cleanTier: 'background'}, bytes, policySha256, winkReview), /evidence tier/);
});
