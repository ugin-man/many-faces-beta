import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assets = path.resolve("public/__fixed_direction");
const output = path.resolve("work/demo-evidence/fixed-direction");
if (process.argv.includes("--prepare")) {
  await fs.mkdir(assets, { recursive: true });
  const { build } = require(path.resolve("node_modules/esbuild"));
  await build({ stdin: { contents: `
import {createStableLandmarker} from './app/live/stable-landmarker.ts';
import {captureVideoFrameAt} from './app/live/video-frame.ts';
import {catalogFeatureFromResult} from './app/catalog-feature.ts';
import {faceGeometryFromLandmarks} from './app/offline-matching.ts';
window.__fixedDirectionAudit = async () => {
  const engine = await createStableLandmarker('IMAGE', () => {});
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  document.body.append(video);
  const url = URL.createObjectURL(await (await fetch('/test-fixtures/reference-face-motion.mp4')).blob());
  const canvas = document.createElement('canvas');
  const rows = [];
  try {
    await new Promise((resolve,reject) => { video.onloadeddata=resolve;video.onerror=reject;video.src=url; });
    for (let index=0; index < Math.floor(video.duration*20); index++) {
      const time=index/20;
      const captured=await captureVideoFrameAt(video,time);
      canvas.width=captured.bitmap.width;canvas.height=captured.bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(captured.bitmap,0,0);captured.bitmap.close();
      const result=engine.detect(canvas),landmarks=result.faceLandmarks[0];
      const feature=landmarks?catalogFeatureFromResult(result):null;
      const geometry=landmarks?faceGeometryFromLandmarks(landmarks,canvas.width/canvas.height):null;
      rows.push({time,detected:!!geometry,feature,geometry,matrix:result.facialTransformationMatrixes[0]?.data,
        source: [4.4,4.5,4.75,5,5.1,5.2,5.4,5.5,9,12,16,20].includes(time)?canvas.toDataURL('image/jpeg',.88):null});
    }
    return {duration:video.duration,width:canvas.width,height:canvas.height,rows};
  } finally {engine.close();video.remove();URL.revokeObjectURL(url);}
};`, loader: "ts", resolveDir: process.cwd(), sourcefile: "fixed-direction-probe.ts" },
    outfile: path.join(assets, "probe.js"), bundle: true, format: "esm", platform: "browser" });
  process.exit(0);
}
const { chromium } = require(path.resolve(".browser-tools/node_modules/playwright"));
await fs.mkdir(output, { recursive: true });
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader"]});
try {
  const page=await browser.newPage();
  await page.goto("http://127.0.0.1:4173/",{waitUntil:"domcontentloaded"});
  await page.addScriptTag({url:"http://127.0.0.1:4173/__fixed_direction/probe.js",type:"module"});
  await page.waitForFunction(()=>typeof window.__fixedDirectionAudit==="function");
  const result=await page.evaluate(()=>window.__fixedDirectionAudit());
  result.testedCommit=process.env.GITHUB_SHA;
  for(const row of result.rows) {
    if(row.source) await fs.writeFile(path.join(output,`source-${row.time.toFixed(2)}.jpg`),Buffer.from(row.source.split(",")[1],"base64"));
    delete row.source;
  }
  await fs.writeFile(path.join(output,"analysis.json"),JSON.stringify(result));
  assert.equal(result.duration,23.3);
  console.log("FIXED_DIRECTION",JSON.stringify(result.rows.filter(row=>row.time>=4&&row.time<=5.6).map(row=>({time:row.time,pose:row.feature?.slice(0,3).map(v=>v*90),nose:row.geometry?.projection.slice(2,4)}))));
}finally{await browser.close();}
