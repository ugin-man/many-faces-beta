#!/usr/bin/env node
/** Rebuild the specialist index AFTER final catalog packing; never copies images.
 * node --experimental-strip-types scripts/rebuild-clean-wink-support.mjs <accepted-catalog> <output-directory>
 * Write to a staging directory, then publish catalog.json and ATTRIBUTION.html
 * together with the exact seed manifest whose bytes are bound into the index.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {liveCandidateFromEntry} from '../app/live-matching.ts';
import {winkEvidence} from '../app/live/wink-evidence.ts';
import {parseWinkSupport, WINK_SUPPORT_MAX_BYTES, WINK_SUPPORT_MAX_ITEMS} from '../app/live/wink-support.ts';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeName = value => {
  assert(typeof value === 'string' && /^[a-z0-9_.+-]+$/i.test(value) && value !== '.' && value !== '..', 'Invalid catalog filename');
  return value;
};

export function readWinkExpressionReview(rawBytes, manifest) {
  const document = JSON.parse(rawBytes);
  const reviewSha256 = sha256(rawBytes), admission = manifest.qualityAdmission;
  assert(document && document.schemaVersion === 1 && document.documentKind === 'clean-core-wink-expression-review' && document.mode === 'confirmed-side-only', 'Invalid wink expression review document');
  assert(validHash(admission?.receiptSha256) && document.candidateAuditSha256 === admission.receiptSha256 && validHash(admission?.recordsSha256) && document.recordsSha256 === admission.recordsSha256, 'Wink review belongs to another admission audit');
  assert(document.reviewer === 'assistant-visual-review' && document.humanVerified === false, 'Wink review must accurately identify assistant visual review');
  assert(typeof document.reviewedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(document.reviewedOn) && Number.isFinite(Date.parse(document.reviewedOn)) && new Date(document.reviewedOn).toISOString().slice(0, 10) === document.reviewedOn, 'Invalid wink review date');
  assert(Array.isArray(document.reviews), 'Wink review requires a reviews array');
  const seen = new Set(), sides = new Map();
  for (const row of document.reviews) {
    assert(row && validHash(row.encodedSha256) && !seen.has(row.encodedSha256), 'Invalid or repeated wink review image digest');
    assert(['confirmed', 'uncertain', 'does-not-match'].includes(row.decision), 'Invalid wink review decision');
    assert(row.decision === 'confirmed' ? ['left', 'right'].includes(row.side) : row.side == null, 'Only a confirmed wink may declare its side');
    assert(typeof row.reason === 'string' && row.reason.trim(), 'Wink review requires a reason');
    if (row.evidence?.imageSha256 !== undefined) assert.equal(row.evidence.imageSha256, row.encodedSha256, 'Wink evidence image bytes differ');
    if (row.evidence?.pixelChangesApplied !== undefined) assert.equal(row.evidence.pixelChangesApplied, false, 'Wink review must inspect unchanged original pixels');
    seen.add(row.encodedSha256);
    if (row.decision === 'confirmed') sides.set(row.encodedSha256, row.side);
  }
  const stamp = {
    schemaVersion: 1, documentKind: 'clean-core-wink-expression-review', mode: 'confirmed-side-only',
    reviewPath: 'wink-expression-review.json', reviewSha256,
    candidateAuditSha256: document.candidateAuditSha256, recordsSha256: document.recordsSha256,
    reviewedEncodedImages: document.reviews.length, confirmedEncodedImages: sides.size,
    confirmedSides: {left: [...sides.values()].filter(side => side === 'left').length, right: [...sides.values()].filter(side => side === 'right').length},
    reviewer: document.reviewer, humanVerified: document.humanVerified, reviewedOn: document.reviewedOn,
  };
  assert.deepEqual(manifest.winkExpressionReview, stamp, 'Manifest wink review stamp differs from its exact file');
  assert.equal(manifest.selectionIdentity?.winkExpressionReviewSha256, reviewSha256, 'Selection identity does not bind this wink review');
  return {sha256: reviewSha256, sides, stamp};
}

export function admittedCoreWink(entry, bytes, policySha256, winkReview) {
  assert(validHash(entry.admissionSha256) && entry.admissionPolicySha256 === policySha256, `Missing current admission evidence: ${entry.id}`);
  assert.equal(sha256(bytes), entry.admissionSha256, `Admitted photo bytes changed: ${entry.id}`);
  assert.equal(entry.id, 'clean-v5-' + entry.admissionSha256.slice(0, 28), 'Use the final content-addressed v5 core ID');
  assert(!Object.hasOwn(entry, 'image') && typeof entry.pack === 'string', 'Build the bound wink index from the final packed core');
  safeName(entry.pack);
  assert(validHash(winkReview?.sha256) && winkReview.sides instanceof Map && winkReview.stamp?.reviewSha256 === winkReview.sha256, 'An exact bound wink review is required');
  const side = entry.cleanProfile === 'winkLeft' ? 'left' : entry.cleanProfile === 'winkRight' ? 'right' : null;
  if (!side) return null;
  assert(['strict', 'observed'].includes(entry.cleanTier), 'Selected wink requires a declared expression evidence tier');
  assert.equal(winkReview.sides.get(entry.admissionSha256), side, 'Selected wink lacks same-side exact-image visual confirmation');
  assert.deepEqual(entry.winkExpressionEvidence, {schemaVersion: 1, encodedSha256: entry.admissionSha256, side, reviewSha256: winkReview.sha256}, 'Selected wink review evidence differs from its exact image and side');
  const candidate = liveCandidateFromEntry(entry, 'admitted-core-wink');
  assert(candidate, `Invalid admitted geometry: ${entry.id}`);
  const evidence = winkEvidence(candidate.feature, candidate.geometry.projection);
  assert(evidence?.side === side, 'Reviewed wink lacks unchanged same-side automatic corroboration');
  const fields = ['id', 'name', 'pack', 'offset', 'length', 'feature', 'shape', 'mesh', 'projection', 'layout', 'sourceName', 'sourceUrl', 'creator', 'license', 'licenseUrl', 'sourceCatalogId', 'changes', 'admissionSha256', 'admissionPolicySha256', 'cleanProfile', 'cleanTier', 'winkExpressionEvidence'];
  const row = Object.fromEntries(fields.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
  return {...row, supportKind: 'core-refresh', side, evidence, imageSha256: entry.admissionSha256, validation: 'Selected admitted core image; exact-image anatomical side confirmed by assistant visual review and corroborated by unchanged automatic features; not independently human-verified'};
}

export function boundedWinkIndex(items, header, byteLimit = WINK_SUPPORT_MAX_BYTES) {
  assert(Number.isSafeInteger(byteLimit) && byteLimit >= 2048 && byteLimit <= WINK_SUPPORT_MAX_BYTES);
  const groups = {left: new Map(), right: new Map()};
  for (const item of items) {
    const cell = [Math.round(item.feature[0] * 30), Math.round(item.feature[1] * 30)].join(':');
    assert(groups[item.side], `Invalid anatomical wink side: ${item.id}`);
    if (!groups[item.side].has(cell)) groups[item.side].set(cell, []);
    groups[item.side].get(cell).push(item);
  }
  const queues = Object.fromEntries(['left', 'right'].map(side => [side, [...groups[side]].sort(([a], [b]) => {
    const [ax, ay] = a.split(':').map(Number), [bx, by] = b.split(':').map(Number);
    return (ax * ax + ay * ay) - (bx * bx + by * by) || ax - bx || ay - by;
  }).map(([, rows]) => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))]));
  const selected = [];
  let estimatedBytes = Buffer.byteLength(JSON.stringify({...header, items: []})) + 1024;
  let remaining = true;
  // Alternate anatomical sides and pose cells before taking second examples.
  // This bounds only the optional index; every omitted photo stays in the 70k core.
  for (let depth = 0; remaining; depth++) {
    remaining = false;
    for (let cell = 0; cell < Math.max(queues.left.length, queues.right.length); cell++) {
      for (const side of ['left', 'right']) {
        const item = queues[side][cell]?.[depth];
        if (!item) continue;
        remaining = true;
        const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (selected.length >= WINK_SUPPORT_MAX_ITEMS || estimatedBytes + bytes > byteLimit) continue;
        selected.push(item); estimatedBytes += bytes;
      }
    }
  }
  const payload = {...header, eligibleCoreWinks: items.length, refreshedOriginals: selected.length, omittedFromSpecialistIndex: items.length - selected.length, items: selected};
  assert(Buffer.byteLength(JSON.stringify(payload)) <= byteLimit, 'Bound specialist index exceeds runtime byte limit');
  return payload;
}

export async function rebuildCleanWinkSupport(catalogRoot, outputRoot) {
  const root = path.resolve(catalogRoot), output = path.resolve(outputRoot);
  assert(root !== output && !output.startsWith(root + path.sep), 'Write the index outside the immutable accepted core');
  const manifestBytes = await fs.readFile(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.totalFaces, 70000); assert.equal(manifest.searchableFaces, 70000);
  const stamp = manifest.qualityAdmission;
  const winkReviewBytes = await fs.readFile(path.join(root, 'wink-expression-review.json'));
  const winkReview = readWinkExpressionReview(winkReviewBytes, manifest);
  const binding = {catalogId: manifest.catalogId, manifestSha256: sha256(manifestBytes), qualityAdmission: stamp, winkExpressionReview: winkReview.stamp};
  const header = {schemaVersion: 3, baseCatalogId: manifest.catalogId, baseCatalogManifestSha256: binding.manifestSha256, policySha256: stamp?.policySha256, winkExpressionReviewSha256: winkReview.sha256, originalFaces: 70000, addedPhotographs: 0, validationStatus: 'admitted-core-only; assistant visual confirmation plus same-side automatic corroboration; not independently human-verified'};
  parseWinkSupport({...header, items: []}, 'https://verification.invalid', binding);
  const ids = new Set(), shardHashes = [], entries = [];
  const handles = new Map();
  try {
    for (const [cellKey, cell] of Object.entries(manifest.cells)) {
      let count = 0;
      for (const file of cell.shards || [cell.shard]) {
        const raw = await fs.readFile(path.join(root, 'shards', safeName(file)));
        shardHashes.push({file, sha256: sha256(raw)});
        const shard = JSON.parse(raw);
        assert(Array.isArray(shard.items), `Invalid shard: ${file}`);
        for (const entry of shard.items) {
          assert(typeof entry.id === 'string' && !ids.has(entry.id), `Duplicate/missing core ID: ${entry.id}`);
          assert(validHash(entry.admissionSha256) && entry.admissionPolicySha256 === stamp.policySha256, `Core entry is not admitted: ${entry.id}`);
          ids.add(entry.id); count++;
          const candidate = liveCandidateFromEntry(entry, file);
          assert(candidate, `Invalid admitted candidate: ${entry.id}`);
          // Only a final reviewed wink assignment may enter the specialist index.
          // Automatic asymmetry in an ordinary core photo never creates one here.
          if (!['winkLeft', 'winkRight'].includes(entry.cleanProfile)) continue;
          assert(!Object.hasOwn(entry, 'image') && Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Number.isSafeInteger(entry.length) && entry.length > 0, `Invalid final image address: ${entry.id}`);
          const pack = safeName(entry.pack);
          if (!handles.has(pack)) {
            if (handles.size >= 16) {const oldest = handles.keys().next().value; await handles.get(oldest).close(); handles.delete(oldest);}
            handles.set(pack, await fs.open(path.join(root, 'packs', pack), 'r'));
          }
          const bytes = Buffer.alloc(entry.length), result = await handles.get(pack).read(bytes, 0, entry.length, entry.offset);
          assert.equal(result.bytesRead, entry.length, `Truncated admitted photo: ${entry.id}`);
          const row = admittedCoreWink(entry, bytes, stamp.policySha256, winkReview);
          if (row) entries.push(row);
        }
      }
      assert.equal(count, cell.count, `Core cell count differs: ${cellKey}`);
    }
  } finally {await Promise.all([...handles.values()].map(handle => handle.close()));}
  assert.equal(ids.size, 70000, 'Bound index requires the exact completed 70,000-image core');
  const payload = boundedWinkIndex(entries, header);
  const parsed = parseWinkSupport(payload, 'https://verification.invalid', binding);
  assert(parsed.every(candidate => ids.has(candidate.id) && candidate.supportKind === 'core-refresh'));
  assert.equal(sha256(await fs.readFile(path.join(root, 'manifest.json'))), binding.manifestSha256, 'Final manifest changed during index generation');
  assert.equal(sha256(await fs.readFile(path.join(root, 'wink-expression-review.json'))), winkReview.sha256, 'Bound wink review changed during index generation');
  for (const row of shardHashes) assert.equal(sha256(await fs.readFile(path.join(root, 'shards', row.file))), row.sha256, 'Final shards changed during index generation');
  const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const attribution = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Many Faces — 画像の出典</title><style>body{max-width:820px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui}article{padding:18px 0;border-bottom:1px solid #ccc;overflow-wrap:anywhere}</style><h1>画像の出典・利用条件</h1><p>この補助索引は、品質検査に合格して最終7万枚に採用された写真だけを参照しています。追加の画像データは使用していません。ウィンクの左右は、アシスタントによる元画像の目視確認と、同じ左右を示す自動解析結果の両方に基づきます。人間による独立した確認は未実施です。</p>' + payload.items.map(entry => `<article id="${escape(entry.id)}"><strong>${escape(entry.id)}</strong><p>${escape(entry.creator)} — <a href="${escape(entry.sourceUrl)}" rel="noopener noreferrer">元画像・出典</a></p><p><a href="${escape(entry.licenseUrl || entry.sourceUrl)}" rel="noopener noreferrer">${escape(entry.license)}</a></p><p>${escape(entry.changes || '採用済みの顔写真を使用。補助索引の生成では画像を変更していません。')}</p></article>`).join('') + '</html>';
  const audit = {schemaVersion: 1, catalogRoot: root, baseCatalogId: manifest.catalogId, baseCatalogManifestSha256: binding.manifestSha256, policySha256: stamp.policySha256, winkExpressionReviewSha256: winkReview.sha256, confirmedReviewSides: winkReview.stamp.confirmedSides, allIndexedWinksHaveReviewedEvidence: true, physicalCoreCount: ids.size, eligibleCoreWinks: entries.length, indexedCoreWinks: payload.items.length, omittedFromSpecialistIndex: payload.omittedFromSpecialistIndex, left: parsed.filter(entry => entry.supportSide === 'left').length, right: parsed.filter(entry => entry.supportSide === 'right').length, outputIndexBytes: Buffer.byteLength(JSON.stringify(payload)), separatePhotoAssets: 0, coreImagesRemoved: 0, independentHumanLabels: false, indexSha256: sha256(JSON.stringify(payload) + '\n')};
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'catalog.json'), JSON.stringify(payload) + '\n');
  await fs.writeFile(path.join(output, 'ATTRIBUTION.html'), attribution + '\n');
  await fs.writeFile(path.join(output, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
  return audit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: rebuild-clean-wink-support.mjs <accepted-catalog> <output-directory>');
  await rebuildCleanWinkSupport(process.argv[2], process.argv[3]).then(audit => console.log(JSON.stringify(audit, null, 2))).catch(error => {console.error(error); process.exitCode = 1;});
}
