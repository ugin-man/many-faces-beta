import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const root=process.cwd(),assets=path.resolve('public/__capture_qa'),out=path.resolve('work/capture-speed');
const baseline=process.env.CAPTURE_BASELINE_ROOT||'/tmp/mf-capture-baseline';
await fs.mkdir(out,{recursive:true});
if(process.argv.includes('--prepare')){
 await fs.mkdir(assets,{recursive:true});
 // Known-color sections verify decoded pixels, not just seek notifications.
 const colors=['red','lime','blue','yellow','magenta','cyan'];
 const inputs=colors.flatMap(c=>['-f','lavfi','-i',`color=c=${c}:s=96x96:r=12:d=0.5`]);
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...inputs,'-filter_complex','[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0,format=yuv420p','-c:v','libvpx','-deadline','realtime',path.join(assets,'colors.webm')],{timeout:30000});
 const code=`
 import {captureVideoFrameAt as before} from ${JSON.stringify(path.join(baseline,'app/live/video-frame.ts'))};
 import {captureVideoFrameAt as after} from './app/live/video-frame.ts';
 import {createStableLandmarker} from './app/live/stable-landmarker.ts';
 import {catalogFeatureFromResult} from './app/catalog-feature.ts';
 import {faceGeometryFromLandmarks} from './app/offline-matching.ts';
 const abortName=error=>error instanceof Error?error.name:String(error);
 async function openVideo(source){
  const response=await fetch(source);if(!response.ok)throw new Error('Fixture '+response.status);
  const url=URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:source.endsWith('webm')?'video/webm':'video/mp4'}));
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.style.cssText='width:200px;height:200px';document.body.append(video);
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Decode fixture failed'));video.src=url;video.load();});
  video.pause();return{video,close(){video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}};
 }
 window.captureFrames=async(variant,source,times,disableCallback=false)=>{
  const {video,close}=await openVideo(source);const rows=[];let captureMs=0,inferenceMs=0,copyMs=0;
  const engine=source.includes('reference-face-motion')?await createStableLandmarker('IMAGE',()=>{}):null;
  const digest=async data=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(disableCallback){video.requestVideoFrameCallback=()=>1;video.cancelVideoFrameCallback=()=>{};}
  try{for(const time of times){const start=performance.now(),frame=await(variant==='before'?before:after)(video,time);captureMs+=performance.now()-start;
   const copyStarted=performance.now();
   const canvas=document.createElement('canvas');canvas.width=frame.bitmap.width;canvas.height=frame.bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(frame.bitmap,0,0);frame.bitmap.close();
   copyMs+=performance.now()-copyStarted;
   let featureHash=null;
   if(engine){const inferenceStarted=performance.now();const result=engine.detect(canvas);inferenceMs+=performance.now()-inferenceStarted;
    const geometry=result.faceLandmarks[0]?faceGeometryFromLandmarks(result.faceLandmarks[0],canvas.width/canvas.height):null;
    if(geometry&&result.faceBlendshapes.length){const data={feature:catalogFeatureFromResult(result),geometry};featureHash=await digest(new TextEncoder().encode(JSON.stringify(data)));}
   }
   const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
   const hash=await digest(pixels);
   const rgb=[...ctx.getImageData(48,48,1,1).data].slice(0,3);
   rows.push({time,hash,featureHash,rgb,width:canvas.width,height:canvas.height,timingsMs:frame.timingsMs||null,evidence:frame.evidence});
  }return{captureMs,inferenceMs,copyMs,rows};}finally{engine?.close();close();}
 };
 window.captureFailures=async()=>{
  const{video,close}=await openVideo('/__capture_qa/colors.webm');const results={};
  try{
   try{await after(video,NaN);results.invalidTime=false;}catch(e){results.invalidTime=abortName(e)==='RangeError';}
   const c=new AbortController();c.abort();try{await after(video,0,{signal:c.signal});results.preCancelled=false;}catch(e){results.preCancelled=abortName(e)==='AbortError';}
   const first=after(video,2.2);const parallel=after(video,1.2).then(()=>false,()=>true);(await first).bitmap.close();results.singleFlight=await parallel;
   const controller=new AbortController();const pending=after(video,0.2,{signal:controller.signal});controller.abort();try{await pending;results.cancel=false;}catch(e){results.cancel=abortName(e)==='AbortError';}
   (await after(video,1.2)).bitmap.close();results.retryAfterCancel=true;
   // Hold the decoder in HAVE_METADATA: no position-only success is allowed.
   Object.defineProperty(video,'readyState',{get:()=>1,configurable:true});
   try{await after(video,1.2,{timeoutMs:150});results.realStall=false;}catch(e){results.realStall=String(e.message).includes('VIDEO_FRAME_TIMEOUT');}
   delete video.readyState;(await after(video,2.2)).bitmap.close();results.retryAfterTimeout=true;
   return results;
  }finally{close();}
 };
 `;
 const {build}=require(path.resolve('.browser-tools/node_modules/esbuild'));
 await build({stdin:{contents:code,resolveDir:root,loader:'ts'},outfile:path.join(assets,'probe.js'),bundle:true,format:'esm',platform:'browser'});
 await fs.writeFile(path.join(assets,'index.html'),'<html><meta charset="utf-8"><script type="module" src="/__capture_qa/probe.js"></script></html>');
 process.exit(0);
}
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
const report={commit:process.env.GITHUB_SHA,baseline:'8f075841995d20710ea72300b980b8d125659235',checks:[],reference:{},cases:[],passed:false};
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4183/__capture_qa/index.html');await page.waitForFunction(()=>typeof window.captureFrames==='function');
 const times=Array.from({length:466},(_,i)=>i/20);
 for(const variant of ['before','after']){
  report.reference[variant]=await page.evaluate(({variant,times})=>window.captureFrames(variant,'/test-fixtures/reference-face-motion.mp4',times),{variant,times});
  console.log('CAPTURE_PIXELS',variant,report.reference[variant].captureMs);
 }
 assert.deepEqual(report.reference.after.rows.map(x=>[x.time,x.hash,x.featureHash,x.width,x.height]),report.reference.before.rows.map(x=>[x.time,x.hash,x.featureHash,x.width,x.height]),'Full-resolution decoded pixels must match at every one of 466 sample times');
 report.checks.push('all 466 full-resolution reference snapshots and their face descriptors are byte-identical');
 const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255]];
 for(const fps of [12,20,30])for(const noCallback of [false,true]){
  const sample=[0,0,.01,.04,.04,...Array.from({length:3*fps},(_,i)=>i/fps),2.999,.01,2.62,1.2,.4];
  const result=await page.evaluate(({sample,noCallback})=>window.captureFrames('after','/__capture_qa/colors.webm',sample,noCallback),{sample,noCallback});
  for(const row of result.rows){const expected=colors[Math.min(5,Math.floor(row.time*2+1e-6))];for(let i=0;i<3;i++)assert.ok(Math.abs(row.rgb[i]-expected[i])<25,JSON.stringify({fps,noCallback,row,expected}));}
  report.cases.push({fps,noCallback,samples:result.rows.length,passed:true});
 }
 report.checks.push('known pixels for 12/20/30-fps sampling, repeated/within-frame/backward/end seeks, and absent callbacks');
 report.failures=await page.evaluate(()=>window.captureFailures());assert.ok(Object.values(report.failures).every(Boolean),JSON.stringify(report.failures));
 report.checks.push('invalid time, concurrent capture, cancellation, true decoder stall, and clean retry');report.passed=true;
}catch(e){report.error=e.stack||String(e);process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(out,'pixels.json'),JSON.stringify(report,null,2));console.log('CAPTURE_PIXEL_GATE',JSON.stringify({...report,reference:Object.fromEntries(Object.entries(report.reference).map(([k,v])=>[k,{captureMs:v.captureMs,inferenceMs:v.inferenceMs,copyMs:v.copyMs,samples:v.rows.length}]))}));}
