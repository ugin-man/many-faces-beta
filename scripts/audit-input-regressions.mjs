import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = process.cwd();
const output = path.resolve('work/input-audit');
const assets = path.resolve('public/__input_audit');
const { chromium } = require(path.resolve('.browser-tools/node_modules/playwright'));
await fs.mkdir(output, {recursive:true});
const base = process.env.MANY_FACES_BASE_URL || 'http://127.0.0.1:4173';
if (process.argv.includes('--prepare')) {
  await fs.mkdir(assets, {recursive:true});
  const manifest = JSON.parse(await fs.readFile('public/seed-catalog/manifest.json','utf8'));
  const selected = [];
  for (const target of [-30,-18,-9,9,18,30]) {
    const keys = Object.keys(manifest.cells).sort((a,b) => {
      const d = key => {const [y,p]=key.split(':').map(Number);return (y-target)**2+p*p;};return d(a)-d(b);
    });
    for (const key of keys) {
      const cell=manifest.cells[key], file=(cell.shards || [cell.shard])[0];
      if(!file) continue;
      const shard=JSON.parse(await fs.readFile(path.join('public/seed-catalog/shards',file),'utf8'));
      for (const entry of shard.items.slice(0,3)) {
        const params=new URLSearchParams({source:'seed',catalog:manifest.catalogId||'seed'});
        if(entry.image) params.set('id',entry.image);
        else for(const name of ['pack','offset','length']) params.set(name,String(entry[name]));
        selected.push({id:entry.id,stored:entry.feature.slice(0,3).map(v=>v*90),url:'/api/catalog/image?'+params});
      }
      break;
    }
  }
  await fs.writeFile(path.join(assets,'cases.json'),JSON.stringify(selected));
  await fs.copyFile('work/astra-fixtures/part-0.mp4',path.join(assets,'face.mp4'));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=96x96:r=12:d=1','-f','lavfi','-i','color=c=green:s=96x96:r=12:d=1','-f','lavfi','-i','color=c=blue:s=96x96:r=12:d=1','-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p','-c:v','libvpx','-deadline','realtime',path.join(assets,'colors.webm')],{timeout:30000});
  const review = await fs.readFile('app/live/review-client-lite.tsx','utf8');
  const legacy = review.includes('function waitForDecodedVideoFrame(') ? review.slice(review.indexOf('function waitForDecodedVideoFrame('),review.indexOf('function nextTask()')) : '';
  const improved = await fs.access('app/live/video-frame.ts').then(()=>true,()=>false);
  const code = `
import {FaceLandmarker, FilesetResolver} from '@mediapipe/tasks-vision';
${improved ? "import {captureVideoFrameAt} from './app/live/video-frame.ts';" : ''}
const CAPTURE_SECONDS=5;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
type VideoWithFrameCallback=HTMLVideoElement;
${legacy}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const oldPose=m=>[Math.atan2(-m[8],Math.hypot(m[9],m[10])),Math.atan2(m[9],m[10])*1.4,Math.atan2(m[4],m[0])].map(v=>v*180/Math.PI);
const transposedPose=m=>[Math.atan2(-m[2],Math.hypot(m[6],m[10])),Math.atan2(m[6],m[10])*1.4,Math.atan2(m[1],m[0])].map(v=>v*180/Math.PI);
window.__poseAudit=async()=>{
  const engine=await FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(location.origin+'/api/mediapipe'),{baseOptions:{modelAssetPath:location.origin+'/api/mediapipe/face_landmarker.task',delegate:'CPU'},runningMode:'IMAGE',numFaces:1,outputFaceBlendshapes:true,outputFacialTransformationMatrixes:true});
  const cases=await (await fetch('/__input_audit/cases.json')).json();
  const rows=[];
  try{for(const c of cases){const image=new Image();image.src=c.url;await image.decode();const result=engine.detect(image);const m=result.facialTransformationMatrixes[0]?.data;rows.push({...c,url:undefined,detected:!!m,old:m?oldPose(m):null,transposed:m?transposedPose(m):null});}}finally{engine.close();}
  return rows;
};
window.__frameAudit=async()=>{
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.style.cssText='width:192px;height:192px';document.body.append(video);
  video.src='/__input_audit/colors.webm';await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;video.load();});video.pause();await sleep(120);
  const rows=[];
  ${legacy ? `for(const time of [0,0.5]){try{await seekVideo(video,time);await sleep(120);const start=performance.now();await waitForDecodedVideoFrame(video,time);rows.push({time,passed:true,ms:performance.now()-start});}catch(e){rows.push({time,passed:false,error:e.message});}}` : ''}
  ${improved ? `for(const time of [0,0,0.04,0.04,0.5,1.2,2.2,0.4,2.999]){const frame=await captureVideoFrameAt(video,time);const canvas=document.createElement('canvas');canvas.width=frame.bitmap.width;canvas.height=frame.bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(frame.bitmap,0,0);frame.bitmap.close();const rgb=[...ctx.getImageData(48,48,1,1).data].slice(0,3);const expected=time<1?0:time<2?1:2;rows.push({time,passed:rgb[expected]>80&&rgb[expected]>Math.max(...rgb.filter((_,i)=>i!==expected))*2,rgb,evidence:frame.evidence});}` : ''}
  video.remove();return rows;
};
`;
  const {build}=require(path.resolve('.browser-tools/node_modules/esbuild'));
  await build({stdin:{contents:code,loader:'ts',resolveDir:root,sourcefile:'input-probe.ts'},outfile:path.join(assets,'probe.js'),bundle:true,format:'esm',platform:'browser'});
  console.log('Prepared public-only fixtures and exact-source probes');
  process.exit(0);
}
const report={testedCommit:process.env.GITHUB_SHA||null,physicalCameraVerified:false,privateUserVideoUsed:false,mode:'diagnostic',pose:[],frames:[],errors:[]};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
try{
  const page=await browser.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(base+'/live/astra',{waitUntil:'networkidle'});
  await page.addScriptTag({url:base+'/__input_audit/probe.js',type:'module'});
  await page.waitForFunction(()=>typeof window.__poseAudit==='function');
  report.pose=await page.evaluate(()=>window.__poseAudit());
  report.frames=await page.evaluate(()=>window.__frameAudit());
  const detected=report.pose.filter(row=>row.detected);
  for(const variant of ['old','transposed']){
    report[variant+'YawMAE']=detected.reduce((sum,row)=>sum+Math.abs(row[variant][0]-row.stored[0]),0)/detected.length;
    report[variant+'YawSignMatches']=detected.filter(row=>Math.sign(row[variant][0])===Math.sign(row.stored[0])).length;
  }
  report.completed=true;
}catch(error){report.completed=false;report.error=error.stack||String(error);process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(output,'input-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
