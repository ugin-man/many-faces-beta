import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const origin = process.env.COMPONENT_ORIGIN || 'http://127.0.0.1:4183';
const out = 'work/video-pipeline-components';
const fixture = 'public/demo/many-faces-sample-30fps.mp4';
const frameLimit = Number(process.env.COMPONENT_FRAME_LIMIT || Number.MAX_SAFE_INTEGER);
const gpuLimit = Number(process.env.COMPONENT_GPU_LIMIT || Number.MAX_SAFE_INTEGER);
const timeoutMs = Number(process.env.COMPONENT_TIMEOUT_MS || 600000);
await fs.mkdir(out, {recursive: true});
const publish = path.join(out, 'publish');
await fs.mkdir(publish, {recursive: true});
const report = {
  purpose: 'Same-input decoder and face-analysis correctness comparison; not an end-to-end speed benchmark',
  fixture, fixtureSha256: createHash('sha256').update(await fs.readFile(fixture)).digest('hex'),
  origin, fps: 30, frameLimit, gpuLimit, timeoutMs, startedAt: new Date().toISOString(), errors: [], passed: false,
  passCriteria: 'Full requested decoder coverage and dimensions, exact IMAGE/CPU worker versus main arithmetic, and synthetic dimensions/coverage. Decoder pixel identity is reported separately; VIDEO/GPU changes are comparisons, not a quality certification.',
};
const run = promisify(execFile);
let browser, deadlineTimer;
let progressWrites = Promise.resolve();
try {
  const syntheticSource = path.join(out, 'vfr.mp4');
  const syntheticRotated = path.join(out, 'vfr-rotated.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=24:duration=1',
    '-vf', 'setpts=if(lt(N\\,12)\\,N/(12*TB)\\,(1+(N-12)/6)/TB)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-g', '12', '-video_track_timescale', '24000', syntheticSource], {timeout: 30000});
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', syntheticSource, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', syntheticRotated], {timeout: 30000});
  report.syntheticFixtures = await Promise.all([syntheticSource, syntheticRotated].map(async file => ({file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex')})));
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']});
  report.browser = browser.version();
  const page = await browser.newPage({viewport: {width: 1100, height: 900}});
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    const line = message.text();
    if (line.startsWith('COMPONENT_')) console.log(line);
    if (line.startsWith('COMPONENT_PROGRESS ')) {
      report.lastProgress = JSON.parse(line.slice('COMPONENT_PROGRESS '.length));
      const progress = JSON.stringify({fixtureSha256: report.fixtureSha256, frameLimit, gpuLimit, recordedAt: new Date().toISOString(), ...report.lastProgress}, null, 2);
      progressWrites = progressWrites.then(() => fs.writeFile(path.join(publish, 'progress.json'), progress));
    }
  });
  // Keep application catalog loading and inference out of this component probe.
  await page.route('**/__video_components__', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Video component comparison</title>'}));
  for (const name of ['vfr.mp4', 'vfr-rotated.mp4']) {
    await page.route(`**/__component_fixtures__/${name}`, async route => route.fulfill({contentType: 'video/mp4', body: await fs.readFile(path.join(out, name))}));
  }
  await page.goto(`${origin}/__video_components__`);
  const evaluation = page.evaluate(async ({frameLimit, gpuLimit}) => {
    const {decodeReviewFrames} = await import('/app/live/video-decoder.ts');
    const {createReviewFaceAnalyzer} = await import('/app/live/review-face-analyzer.ts');
    const result = {decoders: {}, analyses: {}, errors: []};
    const source = await (await fetch('/demo/many-faces-sample-30fps.mp4')).blob();
    const sourceUrl = URL.createObjectURL(source);
    const video = document.createElement('video');
    video.src = sourceUrl; video.muted = true; video.playsInline = true; video.preload = 'auto';
    document.body.append(video);
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, {once: true});
      video.addEventListener('error', () => reject(new Error(`fixture video error ${video.error?.code}`)), {once: true});
    });
    result.duration = video.duration;
    result.width = video.videoWidth; result.height = video.videoHeight;
    const fullCount = Math.max(2, Math.floor(video.duration * 30));
    const count = Math.min(fullCount, frameLimit);
    const times = Array.from({length: count}, (_, i) => Math.max(0, Math.min(video.duration - .001, i / 30)));
    result.plannedFrames = fullCount; result.comparedFrames = count;
    const graphics = document.createElement('canvas').getContext('webgl2');
    const debug = graphics?.getExtension('WEBGL_debug_renderer_info');
    result.renderer = debug ? graphics.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
    graphics?.getExtension('WEBGL_lose_context')?.loseContext();
    const variants = [
      ['imageCpuMain', 'IMAGE', 'CPU', 'main-thread'],
      ['imageCpuWorker', 'IMAGE', 'CPU', 'worker'],
      ['videoCpuWorker', 'VIDEO', 'CPU', 'worker'],
      ['imageGpuWorker', 'IMAGE', 'GPU', 'worker'],
      ['videoGpuWorker', 'VIDEO', 'GPU', 'worker'],
    ];
    const analyzers = new Map();
    const zeroDiff = () => ({compared: 0, exactFrames: 0, differentValues: 0, values: 0, maxAbsoluteError: 0, sumAbsoluteError: 0, shapeMismatches: 0, faceCountMismatches: 0, firstDifferences: []});
    for (const [name, mode, delegate, execution] of variants) {
      const started = performance.now();
      try {
        const analyzer = await createReviewFaceAnalyzer({mode, delegate, execution});
        analyzers.set(name, analyzer);
        result.analyses[name] = {info: analyzer.info, initializationMs: performance.now() - started, frames: 0, faceFrames: 0, totalFaces: 0,
          timingsMs: {copy: 0, inference: 0, total: 0}, againstImageCpuMain: zeroDiff(), groupsAgainstImageCpuMain: {
            landmarks: zeroDiff(), blendshapes: zeroDiff(), transformationMatrices: zeroDiff(),
          }, resultHashes: []};
        console.log('COMPONENT_READY ' + JSON.stringify({name, ...analyzer.info}));
      } catch (error) {
        result.analyses[name] = {initializationError: error.stack || String(error)};
        console.log('COMPONENT_INIT_ERROR ' + name + ' ' + String(error));
      }
    }
    const pixels = bitmap => {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      canvas.width = canvas.height = 1;
      return rgba;
    };
    const hash = async data => {
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    };
    const flatten = (value, numbers = [], shape = []) => {
      if (typeof value === 'number') numbers.push(value);
      else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        shape.push(`a${value.length}`); for (const item of value) flatten(item, numbers, shape);
      } else if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort(); shape.push(keys.join('|'));
        for (const key of keys) flatten(value[key], numbers, shape);
      } else shape.push(JSON.stringify(value));
      return {numbers, shape: shape.join(';')};
    };
    const compare = (reference, value, summary, index, referenceFaces, faces) => {
      summary.compared++;
      if (referenceFaces !== faces) summary.faceCountMismatches++;
      if (reference.shape !== value.shape || reference.numbers.length !== value.numbers.length) {
        summary.shapeMismatches++;
        if (summary.firstDifferences.length < 8) summary.firstDifferences.push({index, time: times[index], shapeMismatch: true, referenceFaces, faces});
        return;
      }
      let different = 0, maximum = 0;
      for (let i = 0; i < reference.numbers.length; i++) {
        const delta = Math.abs(reference.numbers[i] - value.numbers[i]);
        if (delta !== 0) different++;
        maximum = Math.max(maximum, delta); summary.sumAbsoluteError += delta;
      }
      summary.values += reference.numbers.length;
      summary.differentValues += different;
      summary.maxAbsoluteError = Math.max(summary.maxAbsoluteError, maximum);
      if (!different) summary.exactFrames++;
      else if (summary.firstDifferences.length < 8) summary.firstDifferences.push({index, time: times[index], differentValues: different, maxAbsoluteError: maximum});
    };
    const decoder = result.decoders = {frames: 0, exactRgbaFrames: 0, changedChannelValues: 0, channelValues: 0, sumAbsoluteError: 0, maxAbsoluteError: 0,
      dimensionMismatches: 0, knownTimestampComparisons: 0, mediaTimestampMismatches: 0, firstDifferences: [], framesEvidence: [], timingsMs: {webcodecs: 0, videoElement: 0}};
    const modern = decodeReviewFrames(video, source, times, {backend: 'webcodecs'})[Symbol.asyncIterator]();
    const legacy = decodeReviewFrames(video, source, times, {backend: 'video-element'})[Symbol.asyncIterator]();
    try {
      for (let index = 0; index < times.length; index++) {
        let m, l;
        try {
          const a = await modern.next(); m = a.value;
          const b = await legacy.next(); l = b.value;
          if (a.done || b.done) throw new Error(`missing decoder frame ${index}`);
          decoder.frames++;
          decoder.timingsMs.webcodecs += m.timingsMs.total;
          decoder.timingsMs.videoElement += l.timingsMs.total;
          if (m.bitmap.width !== l.bitmap.width || m.bitmap.height !== l.bitmap.height) decoder.dimensionMismatches++;
          if (l.mediaTime !== null) {
            decoder.knownTimestampComparisons++;
            if (Math.abs(l.mediaTime - m.mediaTime) > .00001) decoder.mediaTimestampMismatches++;
          }
          const mp = pixels(m.bitmap), lp = pixels(l.bitmap);
          let changed = 0, sum = 0, maximum = 0;
          if (mp.length !== lp.length) throw new Error(`decoder dimension mismatch ${index}`);
          for (let i = 0; i < mp.length; i++) {
            const delta = Math.abs(mp[i] - lp[i]);
            if (delta) changed++;
            sum += delta; maximum = Math.max(maximum, delta);
          }
          decoder.channelValues += mp.length; decoder.changedChannelValues += changed; decoder.sumAbsoluteError += sum;
          decoder.maxAbsoluteError = Math.max(decoder.maxAbsoluteError, maximum);
          if (changed === 0) decoder.exactRgbaFrames++;
          else if (decoder.firstDifferences.length < 12) decoder.firstDifferences.push({index, time: times[index], webcodecsTime: m.mediaTime, videoElementTime: l.mediaTime, changedChannelValues: changed, maxAbsoluteError: maximum, meanAbsoluteError: sum / mp.length});
          decoder.framesEvidence.push({index, time: times[index], webcodecsTime: m.mediaTime, videoElementTime: l.mediaTime, webcodecsHash: await hash(mp), videoElementHash: await hash(lp)});
          let reference = null, referenceResult = null, referenceFaces = 0;
          for (const [name, , delegate] of variants) {
            const analyzer = analyzers.get(name);
            if (!analyzer || (delegate === 'GPU' && index >= gpuLimit)) continue;
            const stats = result.analyses[name];
            try {
              // All graph comparisons use clones of the very same WebCodecs frame.
              const analyzed = await analyzer.analyze(await createImageBitmap(m.bitmap), times[index]);
              const faces = analyzed.result.faceLandmarks.length;
              const flat = flatten(analyzed.result);
              stats.frames++; stats.faceFrames += faces > 0 ? 1 : 0; stats.totalFaces += faces;
              for (const key of ['copy', 'inference', 'total']) stats.timingsMs[key] += analyzed.timingsMs[key];
              const serialized = JSON.stringify(analyzed.result);
              stats.resultHashes.push(await hash(new TextEncoder().encode(serialized)));
              if (name === 'imageCpuMain') { reference = flat; referenceResult = analyzed.result; referenceFaces = faces; }
              if (reference) {
                compare(reference, flat, stats.againstImageCpuMain, index, referenceFaces, faces);
                for (const [group, property] of [['landmarks', 'faceLandmarks'], ['blendshapes', 'faceBlendshapes'], ['transformationMatrices', 'facialTransformationMatrixes']]) {
                  compare(flatten(referenceResult[property]), flatten(analyzed.result[property]), stats.groupsAgainstImageCpuMain[group], index, referenceFaces, faces);
                }
              }
            } catch (error) {
              stats.error = {index, message: error.stack || String(error)};
              analyzer.close(); analyzers.delete(name);
              console.log('COMPONENT_FRAME_ERROR ' + name + ' ' + String(error));
            }
          }
          if (index === 0 || (index + 1) % 100 === 0 || index + 1 === times.length) {
            console.log('COMPONENT_PROGRESS ' + JSON.stringify({frame: index + 1, total: count, exactRgba: decoder.exactRgbaFrames,
              analyses: Object.fromEntries(Object.entries(result.analyses).map(([name, stats]) => [name, {frames: stats.frames, faceFrames: stats.faceFrames, meanInferenceMs: stats.timingsMs?.inference / stats.frames, exactAgainstMain: stats.againstImageCpuMain?.exactFrames}]))}));
          }
        } finally { m?.bitmap.close(); l?.bitmap.close(); }
      }
      if (!(await modern.next()).done || !(await legacy.next()).done) throw new Error('unexpected extra decoder frame');
    } catch (error) { result.errors.push(error.stack || String(error)); }
    finally {
      await modern.return(); await legacy.return();
      for (const analyzer of analyzers.values()) analyzer.close();
      video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(sourceUrl);
    }
    decoder.meanAbsoluteError = decoder.channelValues ? decoder.sumAbsoluteError / decoder.channelValues : null;
    for (const stats of Object.values(result.analyses)) {
      if (!stats.againstImageCpuMain) continue;
      for (const diff of [stats.againstImageCpuMain, ...Object.values(stats.groupsAgainstImageCpuMain)]) {
        diff.meanAbsoluteError = diff.values ? diff.sumAbsoluteError / diff.values : null;
      }
    }
    result.synthetic = [];
    for (const name of ['vfr.mp4', 'vfr-rotated.mp4']) {
      const blob = await (await fetch(`/__component_fixtures__/${name}`)).blob();
      const url = URL.createObjectURL(blob);
      const player = document.createElement('video'); player.src = url; player.muted = true; document.body.append(player);
      await new Promise((resolve, reject) => {
        player.addEventListener('loadeddata', resolve, {once: true});
        player.addEventListener('error', reject, {once: true});
      });
      const sampleTimes = [0, 0, .01, 1 / 24, 1 / 12 - .00001, 1 / 12, 1 / 12 + .00001, .5, .5, .9999, 1, 1.01, 1.1, 1.166667, 1.25, 2.7, 2.7, 2.8];
      const test = {name, duration: player.duration, expectedDimensions: name.includes('rotated') ? [64, 96] : [96, 64], frames: [], errors: []};
      const modernFrames = decodeReviewFrames(player, blob, sampleTimes, {backend: 'webcodecs'})[Symbol.asyncIterator]();
      const legacyFrames = decodeReviewFrames(player, blob, sampleTimes, {backend: 'video-element'})[Symbol.asyncIterator]();
      try {
        for (const time of sampleTimes) {
          let a, b;
          try {
            a = (await modernFrames.next()).value; b = (await legacyFrames.next()).value;
            if (!a || !b) throw new Error(`missing synthetic frame ${time}`);
            test.frames.push({time, webcodecsTime: a.mediaTime, videoElementTime: b.mediaTime, webcodecsDimensions: [a.bitmap.width, a.bitmap.height],
              videoElementDimensions: [b.bitmap.width, b.bitmap.height], webcodecsHash: await hash(pixels(a.bitmap)), videoElementHash: await hash(pixels(b.bitmap))});
          } finally { a?.bitmap.close(); b?.bitmap.close(); }
        }
      } catch (error) { test.errors.push(error.stack || String(error)); }
      finally { await modernFrames.return(); await legacyFrames.return(); player.removeAttribute('src'); player.load(); player.remove(); URL.revokeObjectURL(url); }
      result.synthetic.push(test);
    }
    result.referenceWorkerExact = result.analyses.imageCpuWorker.frames === count && result.analyses.imageCpuWorker.againstImageCpuMain?.exactFrames === count;
    result.decoderPixelExact = decoder.frames === count && decoder.exactRgbaFrames === count;
    return result;
  }, {frameLimit, gpuLimit});
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - Date.parse(report.startedAt)));
  report.observed = await Promise.race([evaluation, new Promise((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error(`COMPONENT_TIMEOUT: component probe exceeded ${timeoutMs} ms; last completed counts are in lastProgress`)), remainingMs);
  })]);
  report.passed = report.errors.length === 0 && report.observed.errors.length === 0 && report.observed.referenceWorkerExact
    && report.observed.decoders.frames === report.observed.comparedFrames && report.observed.decoders.dimensionMismatches === 0
    && report.observed.synthetic.every(test => test.errors.length === 0 && test.frames.length === 18 && test.frames.every(frame =>
      frame.webcodecsDimensions.join() === test.expectedDimensions.join() && frame.videoElementDimensions.join() === test.expectedDimensions.join()));
} catch (error) { report.errors.push(error.stack || String(error)); }
finally {
  clearTimeout(deadlineTimer);
  report.finishedAt = new Date().toISOString();
  await progressWrites;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const brief = structuredClone(report);
  if (brief.observed) {
    const evidence = brief.observed.decoders.framesEvidence;
    if (evidence) {
      brief.observed.decoders.orderedFrameEvidenceSha256 = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
      brief.observed.decoders.frameHashCount = evidence.length;
      delete brief.observed.decoders.framesEvidence;
    }
    for (const stats of Object.values(brief.observed.analyses)) if (stats.resultHashes) {
      stats.orderedResultHashesSha256 = createHash('sha256').update(JSON.stringify(stats.resultHashes)).digest('hex');
      stats.resultHashCount = stats.resultHashes.length;
      delete stats.resultHashes;
    }
  }
  await fs.writeFile(path.join(publish, 'summary.json'), JSON.stringify(brief, null, 2));
  console.log('COMPONENT_FINAL ' + JSON.stringify(brief));
  if (!report.passed) process.exitCode = 1;
  await browser?.close();
}
