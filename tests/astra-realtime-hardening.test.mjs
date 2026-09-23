import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source=await readFile(new URL('../app/live/review-client-lite.tsx',import.meta.url),'utf8');
const frames=await readFile(new URL('../app/live/video-frame.ts',import.meta.url),'utf8');

test('fixed-video uses an atomic capture rather than a post-seek future-notification barrier',()=>{
  assert.match(source,/import \{ captureVideoFrameAt \}/);
  assert.doesNotMatch(source,/await waitForDecodedVideoFrame/);
  assert.match(frames,/VIDEO_FRAME_TIMEOUT/);
  assert.match(frames,/signal\.aborted \|\| !positioned\(\)/);
});

test('fixed-video reads only the acquired snapshot and releases it before inference',()=>{
  const acquire=source.indexOf('const captured = await captureVideoFrameAt(');
  const draw=source.indexOf('context.drawImage(captured.bitmap,');
  const close=source.indexOf('captured.bitmap.close();');
  const detect=source.indexOf('const result = landmarker.detect(canvas);');
  assert.ok(acquire>=0&&draw>acquire&&close>draw&&detect>close);
  assert.match(source,/catalogPoseFromWebMatrix\(result\.facialTransformationMatrixes/);
});
