import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require=createRequire(import.meta.url);
const root=process.cwd(),output=path.resolve('work/input-audit'),assets=path.resolve('public/__input_audit');
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
await fs.mkdir(output,{recursive:true});
const base=process.env.MANY_FACES_BASE_URL||'http://127.0.0.1:4173';
if(process.argv.includes('--prepare')){
  await fs.mkdir(assets,{recursive:true});
  const manifest=JSON.parse(await fs.readFile('public/seed-catalog/manifest.json','utf8'));
  const selected=[];
  for(const target of [-30,-18,-9,9,18,30]){
    const distance=key=>{const[y,p]=key.split(':').map(Number);return(y-target)**2+p*p;};
    const keys=Object.keys(manifest.cells).sort((a,b)=>distance(a)-distance(b));
    for(const key of keys){
      const cell=manifest.cells[key],file=(cell.shards||[cell.shard])[0];if(!file)continue;
      const shard=JSON.parse(await fs.readFile(path.join('public/seed-catalog/shards',file),'utf8'));
      for(const entry of shard.items.slice(0,3)){
        const params=new URLSearchParams({source:'seed',catalog:manifest.catalogId||'seed'});
        if(entry.image)params.set('id',entry.image);else for(const name of ['pack','offset','length'])params.set(name,String(entry[name]));
        selected.push({id:entry.id,stored:entry.feature.slice(0,3).map(v=>v*90),url:'/api/catalog/image?'+params});
      }
      break;
    }
  }
  await fs.writeFile(path.join(assets,'cases.json'),JSON.stringify(selected));
  await fs.copyFile('work/astra-fixtures/part-0.mp4',path.join(assets,'face.mp4'));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','4','-i','work/astra-fixtures/part-0.mp4','-t','5','-c','copy',path.join(assets,'face-five-seconds.mp4')],{timeout:30000});
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=96x96:r=12:d=1','-f','lavfi','-i','color=c=green:s=96x96:r=12:d=1','-f','lavfi','-i','color=c=blue:s=96x96:r=12:d=1','-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p','-c:v','libvpx','-deadline','realtime',path.join(assets,'colors.webm')],{timeout:30000});
  const code=`
import {FaceLandmarker,FilesetResolver} from '@mediapipe/tasks-vision';
import {captureVideoFrameAt} from './app/live/video-frame.ts';
import {catalogPoseFromWebMatrix} from './app/catalog-pose.ts';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ranges=value=>Array.from({length:value.length},(_,i)=>[value.start(i),value.end(i)]);
const oldPose=m=>[Math.atan2(-m[8],Math.hypot(m[9],m[10])),Math.atan2(m[9],m[10])*1.4,Math.atan2(m[4],m[0])].map(v=>v*180/Math.PI);
window.__poseAudit=async()=>{
  const engine=await FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(location.origin+'/api/mediapipe'),{baseOptions:{modelAssetPath:location.origin+'/api/mediapipe/face_landmarker.task',delegate:'CPU'},runningMode:'IMAGE',numFaces:1,outputFaceBlendshapes:true,outputFacialTransformationMatrixes:true});
  const cases=await(await fetch('/__input_audit/cases.json')).json(),rows=[];
  try{for(const c of cases){const image=new Image();image.src=c.url;await image.decode();const result=engine.detect(image),m=result.facialTransformationMatrixes[0]?.data;rows.push({...c,url:undefined,detected:!!m,old:m?oldPose(m):null,corrected:catalogPoseFromWebMatrix(m)?.map(v=>v*90)||null});}}finally{engine.close();}
  return rows;
};
window.__httpSeekAudit=async()=>{
  const response=await fetch('/__input_audit/colors.webm',{headers:{Range:'bytes=0-31'}});
  const headers={status:response.status,type:response.headers.get('content-type'),acceptRanges:response.headers.get('accept-ranges'),contentRange:response.headers.get('content-range')};await response.arrayBuffer();
  const video=document.createElement('video');video.muted=true;video.preload='auto';document.body.append(video);
  video.src='/__input_audit/colors.webm';await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;video.load();});video.pause();await sleep(120);
  const rows=[];
  try{for(const requested of [0.04,1.2]){
    const before={currentTime:video.currentTime,seekable:ranges(video.seekable),buffered:ranges(video.buffered)};
    const event=await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);resolve('seeked');};video.addEventListener('seeked',done);timer=setTimeout(()=>{video.removeEventListener('seeked',done);resolve('deadline');},1500);video.currentTime=requested;});
    rows.push({requested,event,before,after:{currentTime:video.currentTime,seekable:ranges(video.seekable),buffered:ranges(video.buffered),ready:video.readyState,seeking:video.seeking}});
  }}finally{video.remove();}
  return {headers,rows};
};
window.__frameAudit=async()=>{
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.style.cssText='width:192px;height:192px';document.body.append(video);
  // The application consumes user-selected Files through object URLs. Keep the
  // exact pixel assertions, but do not confuse HTTP server range support with
  // the file-decoder contract. HTTP seekability is diagnosed separately above.
  const response=await fetch('/__input_audit/colors.webm');if(!response.ok)throw new Error('Fixture unavailable');
  const url=URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:'video/webm'}));
  video.src=url;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;video.load();});video.pause();await sleep(120);
  const rows=[];
  try{for(const time of [0,0,0.04,0.04,0.5,1.2,2.2,0.4,2.999]){
    const started=performance.now();
    try{
      const frame=await captureVideoFrameAt(video,time);const canvas=document.createElement('canvas');canvas.width=frame.bitmap.width;canvas.height=frame.bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(frame.bitmap,0,0);frame.bitmap.close();
      const rgb=[...ctx.getImageData(48,48,1,1).data].slice(0,3),expected=time<1?0:time<2?1:2;
      rows.push({time,passed:rgb[expected]>80&&rgb[expected]>Math.max(...rgb.filter((_,i)=>i!==expected))*2,rgb,evidence:frame.evidence,currentTime:video.currentTime,seekable:ranges(video.seekable),elapsedMs:performance.now()-started});
    }catch(error){rows.push({time,passed:false,error:error.message,currentTime:video.currentTime,duration:video.duration,ready:video.readyState,seeking:video.seeking,seekable:ranges(video.seekable),paused:video.paused,elapsedMs:performance.now()-started});break;}
  }}finally{video.remove();URL.revokeObjectURL(url);}
  return rows;
};
`;
  const {build}=require(path.resolve('.browser-tools/node_modules/esbuild'));
  await build({stdin:{contents:code,loader:'ts',resolveDir:root,sourcefile:'input-probe.ts'},outfile:path.join(assets,'probe.js'),bundle:true,format:'esm',platform:'browser'});
  console.log('Prepared public-only pixel tests and exact application helper probes');process.exit(0);
}
const check=(value,message)=>{if(!value)throw new Error(message);};
const report={testedCommit:process.env.GITHUB_SHA||null,physicalCameraVerified:false,privateUserVideoUsed:false,mode:'regression',frameSource:'File-equivalent Blob URL, 12fps WebM',pose:[],frames:[],errors:[],passed:false};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
try{
  const page=await browser.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(base+'/live/astra',{waitUntil:'networkidle'});
  await page.addScriptTag({url:base+'/__input_audit/probe.js',type:'module'});
  await page.waitForFunction(()=>typeof window.__poseAudit==='function');
  report.pose=await page.evaluate(()=>window.__poseAudit());
  report.httpSeekability=await page.evaluate(()=>window.__httpSeekAudit());
  report.frames=await page.evaluate(()=>window.__frameAudit());
  const detected=report.pose.filter(row=>row.detected);
  for(const variant of ['old','corrected']){
    report[variant+'YawMAE']=detected.reduce((sum,row)=>sum+Math.abs(row[variant][0]-row.stored[0]),0)/detected.length;
    report[variant+'YawSignMatches']=detected.filter(row=>Math.sign(row[variant][0])===Math.sign(row.stored[0])).length;
  }
  check(detected.length===18,'Expected all 18 real catalog photos to be detected');
  check(report.correctedYawSignMatches===18,'Corrected yaw no longer agrees with the stored catalog');
  check(report.correctedYawMAE<8,'Unexpected yaw magnitude regression');
  check(report.frames.length===9&&report.frames.every(row=>row.passed),'A decoded frame contains the wrong color/time or could not be acquired');
  check(report.errors.length===0,'Page runtime errors');
  report.passed=true;
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(output,'input-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
