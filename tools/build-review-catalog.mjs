import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { liveCandidateFromEntry } from '../app/live-matching.ts';
import { REVIEW_CATALOG_SCHEMA } from '../app/live/review-catalog.ts';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Generate immutable video-only shards. Original assets remain unchanged.
 * Admission is performed by the original loader, not inferred from fields. */
export async function buildReviewCatalog(sourceDirectory, outputDirectory) {
  const manifestBytes = await fs.readFile(path.join(sourceDirectory, 'manifest.json'));
  const source = JSON.parse(manifestBytes), sourceManifestSha256 = sha256(manifestBytes);
  if (!source.cells || !source.catalogId) throw new Error('Review catalog requires a versioned pose manifest');
  const files = [...new Set(Object.values(source.cells).flatMap(cell => cell.shards?.length ? cell.shards : cell.shard ? [cell.shard] : []))];
  if (files.some(file => !/^[a-z0-9_.+-]+\.json$/i.test(file))) throw new Error('Invalid source shard path');
  const destination = path.join(outputDirectory, sourceManifestSha256);
  await fs.mkdir(path.join(destination, 'shards'), { recursive: true });
  const manifest = { schema: REVIEW_CATALOG_SCHEMA, sourceManifestSha256, catalogId: source.catalogId, records: 0, shards: {} };
  let sourceRecords = 0, sourceBytes = 0, compactBytes = 0;
  for (const file of files) {
    const bytes = await fs.readFile(path.join(sourceDirectory, 'shards', file));
    const original = JSON.parse(bytes);
    if (!Array.isArray(original.items)) throw new Error(`Invalid source shard: ${file}`);
    const items = [];
    for (const entry of original.items) {
      sourceRecords++;
      if (!liveCandidateFromEntry(entry, file)) continue;
      const compact = { ...entry }; delete compact.shape; delete compact.mesh;
      items.push(compact);
    }
    const sourceShardSha256 = sha256(bytes);
    const compact = Buffer.from(JSON.stringify({ schema: REVIEW_CATALOG_SCHEMA, sourceManifestSha256, sourceShardSha256, catalogId: source.catalogId, items }));
    const target = path.join(destination, 'shards', file);
    await fs.writeFile(target + '.tmp', compact); await fs.rename(target + '.tmp', target);
    manifest.shards[file] = { sha256: sourceShardSha256, records: items.length, bytes: compact.length };
    manifest.records += items.length; sourceBytes += bytes.length; compactBytes += compact.length;
  }
  const target = path.join(destination, 'manifest.json');
  await fs.writeFile(target + '.tmp', JSON.stringify(manifest)); await fs.rename(target + '.tmp', target);
  return { schema: REVIEW_CATALOG_SCHEMA, sourceManifestSha256, catalogId: source.catalogId, shards: files.length, sourceRecords, admittedRecords: manifest.records, sourceBytes, compactBytes, bytesSaved: sourceBytes - compactBytes, destination };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const source = path.resolve(positional[0] ?? 'public/seed-catalog');
  const destination = path.resolve(positional[1] ?? 'public/video-catalog/v1');
  try {
    await fs.access(path.join(source, 'manifest.json'));
  } catch (error) {
    if (process.argv.includes('--if-present') && error.code === 'ENOENT') {
      console.log(JSON.stringify({ skipped: true, reason: 'Source seed catalog is not installed', source }));
      process.exit(0);
    }
    throw error;
  }
  // Lightweight CI checkouts keep only the manifest. A missing shard directory
  // means the optional catalog is not installed; an existing but incomplete
  // directory must still fail below so a broken deployment is never hidden.
  if (process.argv.includes('--if-present')) {
    try {
      const directory = await fs.stat(path.join(source, 'shards'));
      if (!directory.isDirectory()) throw new Error('Source seed catalog shards path is not a directory');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(JSON.stringify({ skipped: true, reason: 'Source seed catalog shards are not installed', source }));
        process.exit(0);
      }
      throw error;
    }
  }
  console.log(JSON.stringify(await buildReviewCatalog(source, destination), null, 2));
}
