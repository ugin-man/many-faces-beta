#!/usr/bin/env node
/** Convert the fixed native extraction with unchanged production JS formulas.
 * Usage after prepare-queries-native.py: node research/face-search/prepare-queries-native.mjs [--out DIR]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {catalogFeatureFromResult} from '../../app/catalog-feature.ts';
import {faceGeometryFromLandmarks} from '../../app/offline-matching.ts';
import {filterVideoProfileIslands} from '../../app/live/video-pose-continuity.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PIN='ec97e233003e272cc203580953a180377945228d';
const args=process.argv.slice(2);
if(args.length && (args.length!==2||args[0]!=='--out'))throw new Error('Usage: --out DIR');
const out=args.length?path.resolve(args[1]):path.join(root,'work/face-search');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(os.endianness(),'LE');
const startedAt=new Date().toISOString();
const sourceHashes={};
for(const file of ['app/catalog-feature.ts','app/catalog-pose.ts','app/face-actions.ts','app/offline-matching.ts','app/live/video-pose-continuity.ts']) {
  const bytes=await fs.readFile(path.join(root,file));
  const pinned=execFileSync('git',['show',`${PIN}:${file}`],{cwd:root,maxBuffer:4*1024*1024});
  assert.deepEqual(bytes,pinned,`Feature conversion drift: ${file}`);sourceHashes[file]=sha(bytes);
}
const assetHashes={};
for(const file of ['public/demo/many-faces-sample-30fps.mp4','public/mediapipe/face_landmarker.task']) {
  const bytes=await fs.readFile(path.join(root,file));
  const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob,execFileSync('git',['rev-parse',`${PIN}:${file}`],{cwd:root,encoding:'utf8'}).trim());
  assetHashes[file]={bytes:bytes.length,sha256:sha(bytes),gitBlobSha1:blob};
}
const native=JSON.parse(await fs.readFile(path.join(out,'queries.native-extraction.json'),'utf8'));
assert.equal(native.decodedFrames,1061);assert.equal(native.analyzer.mode,'IMAGE');assert.equal(native.analyzer.delegate,'CPU');
assert.equal(native.sourceAssets.video.sha256,assetHashes['public/demo/many-faces-sample-30fps.mp4'].sha256,'Native extraction used another video');
assert.equal(native.sourceAssets.model.sha256,assetHashes['public/mediapipe/face_landmarker.task'].sha256,'Native extraction used another model');
const rawBytes=await fs.readFile(path.join(out,'queries.native-landmarks.jsonl'));
assert.equal(sha(rawBytes),native.rawLandmarkStreamSha256,'Raw landmark stream changed after extraction');
const raw=rawBytes.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
assert.equal(raw.length,1061);
const frames=[], evidence=[];
for(let i=0;i<raw.length;i++) {
  const row=raw[i];assert.equal(row.sourceFrameIndex,i);assert.equal(row.time,i/30);
  assert.equal(row.width,768);assert.equal(row.height,768);
  let frame=null,reason='no-face-landmarks';
  if(row.landmarks.length && row.categories.length) {
    const geometry=faceGeometryFromLandmarks(row.landmarks,row.width/row.height);
    reason='invalid-geometry';
    if(geometry) {
      const feature=catalogFeatureFromResult({faceBlendshapes:[{categories:row.categories}],
        facialTransformationMatrixes:row.matrixColumnMajor.length?[{data:row.matrixColumnMajor}]:[]});
      assert.equal(feature.length,55);assert.equal(geometry.projection.length,936);
      assert.ok(feature.every(Number.isFinite));assert.ok(geometry.projection.every(Number.isFinite));
      frame={sourceFrameIndex:i,time:row.time,feature,geometry,compensateRoll:true};frames.push(frame);reason=null;
    }
  } else if(row.landmarks.length)reason='no-blendshapes';
  evidence.push({...native.evidence[i],valid:!!frame,reason});
}
const filtered=filterVideoProfileIslands(frames,30), admitted=new Set(filtered.frames.map(x=>x.sourceFrameIndex));
const features=new Float64Array(frames.length*55),projections=new Float64Array(frames.length*936),metadata=[];
for(let i=0;i<frames.length;i++) {
  const frame=frames[i];features.set(frame.feature,i*55);projections.set(frame.geometry.projection,i*936);
  metadata.push({sourceFrameIndex:frame.sourceFrameIndex,time:frame.time,compensateRoll:true,appAdmitted:admitted.has(frame.sourceFrameIndex)});
}
for(const row of evidence)row.appAdmitted=admitted.has(row.sourceFrameIndex);
const files={};
for(const [name,array,shape] of [['queries.features.f64',features,[frames.length,55]],['queries.projections.f64',projections,[frames.length,936]]]) {
  const bytes=Buffer.from(array.buffer);await fs.writeFile(path.join(out,name),bytes);files[name]={shape,dtype:'<f8',bytes:bytes.length,sha256:sha(bytes)};
}
const metaBytes=Buffer.from(JSON.stringify(metadata,null,2)+'\n');
await fs.writeFile(path.join(out,'queries.json'),metaBytes);files['queries.json']={bytes:metaBytes.length,sha256:sha(metaBytes)};
const {evidence:ignored,...nativeMetadata}=native;
const manifest={schema:'many-faces-video-queries-v1',sourceCommit:PIN,startedAt,finishedAt:new Date().toISOString(),node:process.version,
  fixture:'public/demo/many-faces-sample-30fps.mp4',sourceHashes,assetHashes,
  queryCount:frames.length,appAdmittedCount:filtered.frames.length,files,...nativeMetadata,
  rawLandmarkStreamSha256:sha(rawBytes),appProfileIntervals:filtered.intervals,evidence,
  preparation:'Native MediaPipe CPU/IMAGE on sequential OpenCV-decoded source frames. Native row-major matrix repacked as Web column-major, then unmodified pinned production JS catalogFeatureFromResult and faceGeometryFromLandmarks. No geometry quantization or scaling.',
  primarySelection:'Every finite, geometrically valid detected frame, before the application profile-island filter. No interval, frame, or expression selected using search results.',
  appAdmittedPolicy:'Diagnostic flag only. The application profile-island filter inspects future frames; neither this flag nor future queries are passed to online search.',
  fallbackReason:'System Chromium cannot create its process-singleton socket in this executor (Operation not permitted); Playwright headless-shell download returned invalid archives. Browser preparation script remains available for unrestricted executors.',
  limitations:['One pre-existing, already-composited public sample; not an independent raw-video test corpus.','CPU/IMAGE native extraction is not numerically asserted equal to the browser workflow.','Feature extraction is prepared once and excluded from search timing.'],errors:[]};
await fs.writeFile(path.join(out,'queries.manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('QUERY_COMPLETE '+JSON.stringify({queryCount:frames.length,plannedFrames:1061,appAdmittedCount:filtered.frames.length,out,querySha256:files['queries.features.f64'].sha256}));
