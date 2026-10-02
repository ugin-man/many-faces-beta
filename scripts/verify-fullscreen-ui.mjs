import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const base=process.env.MANY_FACES_BASE_URL||'http://127.0.0.1:4173';
const out=process.env.FULLSCREEN_REPORT_DIR||'work/fullscreen-evidence';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${process.env.MANY_FACES_CAMERA_FIXTURE||path.resolve('work/fullscreen-fixtures/moving.y4m')}`]});
const report={checks:[],pageErrors:[],video:null,camera:null,physicalCameraVerified:false,hostedSiteVerified:false};
const check=(condition,label)=>{assert.ok(condition,label);report.checks.push(label);};
let page;
const layout=async()=>page.evaluate(()=>{
 const stage=document.querySelector('[data-testid="result-stage"]'),pip=document.querySelector('[data-testid="source-pip"]');
 const r=stage.getBoundingClientRect(),p=pip.getBoundingClientRect();
 return {width:innerWidth,height:innerHeight,stage:{x:r.x,y:r.y,w:r.width,h:r.height},pip:{x:p.x,y:p.y,w:p.width,h:p.height},scroll:document.documentElement.scrollWidth,nav:document.querySelectorAll('[role="tab"], nav').length};
});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera']});
 await context.addInitScript(()=>{
   if (!navigator.mediaDevices) return;
   const acquire=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__streams=[];
   navigator.mediaDevices.getUserMedia=async options=>{const stream=await acquire(options);window.__streams.push(stream);return stream;};
 });
 page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.goto(base+'/',{waitUntil:'networkidle'});
 await page.getByTestId('sample-video').waitFor();
 let l=await layout();check(l.stage.w===390&&l.stage.h===844,'mobile output covers the entire viewport');check(l.scroll===390,'no mobile horizontal overflow');check(l.nav===0,'no old navigation or tabs');
 await page.screenshot({path:path.join(out,'video-ready-mobile.png')});
 await page.getByTestId('settings').click();await page.getByTestId('analysis-fps').selectOption('12');await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.getByTestId('sample-video').click();
 await page.waitForFunction(()=>window.__MANY_FACES_VERIFY__||window.__MANY_FACES_RUNTIME__?.phase==='error',null,{timeout:240000});
 let v=await page.evaluate(()=>window.__MANY_FACES_VERIFY__||window.__MANY_FACES_RUNTIME__);report.video={...v,sequenceIds:undefined};check(v.passed===true,'bundled real recorded video completes actual analysis with nonblank output');
 const duration=await page.getByTestId('input-video').evaluate(video=>video.duration);
 check(duration>20&&v.plannedFrames===Math.floor(duration*12)&&v.sequenceFrames===v.faceFrames,'the full existing reference recording is retained, not truncated to five seconds');
 await page.screenshot({path:path.join(out,'video-result-mobile.png')});
 report.reviewPositions=[];
 for (const fraction of [.25,.5,.75,.94]) {
   const slider=page.getByTestId('review-seek'),box=await slider.boundingBox();
   await slider.click({position:{x:8+(box.width-16)*fraction,y:box.height/2}});
   await page.waitForFunction(()=>{const video=document.querySelector('[data-testid="input-video"]');return !video.seeking&&video.readyState>=2;});
   const time=await page.getByTestId('input-video').evaluate(video=>video.currentTime);
   report.reviewPositions.push(time);
   await page.screenshot({path:path.join(out,`video-motion-${Math.round(fraction*100)}.png`)});
 }
 await page.getByTestId('review-seek').focus();await page.keyboard.press('Home');
 l=await layout();check(l.pip.x>l.width/2&&l.pip.y<40&&l.pip.w*l.pip.h<l.width*l.height*.12,'source is a small top-right picture-in-picture');
 await page.getByTestId('play-pause').click();await page.waitForTimeout(6500);
 check(await page.getByTestId('input-video').evaluate(video=>video.currentTime>5&&video.currentTime<video.duration),'source and result continue past five seconds through the analyzed recording');
 await page.getByTestId('play-pause').click();await page.getByTestId('step-forward').click();
 check(await page.evaluate(()=>document.querySelector('[data-testid="input-video"]').paused),'frame stepping pauses the original');
 await page.getByTestId('settings').click();await page.getByTestId('mirror-toggle').check();
 check(await page.evaluate(()=>{const q=x=>getComputedStyle(document.querySelector(`[data-testid="${x}"]`)).transform;return q('input-video')===q('output-canvas')&&q('input-video')!=='none';}),'video mirror setting is paired');
 await page.getByRole('button',{name:'画像情報・診断',exact:true}).click();await page.screenshot({path:path.join(out,'video-details.png')});await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.setViewportSize({width:1440,height:900});await page.screenshot({path:path.join(out,'video-result-desktop.png')});l=await layout();check(l.stage.w===1440&&l.stage.h===900,'desktop also uses the complete output surface');
 await page.getByTestId('mode-camera').click();await page.getByTestId('camera-start').click();
 await page.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error'||(window.__MANY_FACES_REALTIME__?.frames>70&&window.__MANY_FACES_REALTIME__?.outputChanges>0),null,{timeout:90000});
 report.camera=await page.evaluate(()=>window.__MANY_FACES_REALTIME__);
 check(report.camera.phase==='running'&&report.camera.outputChanges>0,'actual MediaPipe virtual-camera pipeline produces result images');check(report.camera.catalogTotal===70000,'all 70,000 source images remain available');
 await page.screenshot({path:path.join(out,'camera-result-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(1000);await page.screenshot({path:path.join(out,'camera-result-mobile.png')});
 await page.mouse.move(12,300);await page.mouse.down();await page.waitForTimeout(80);await page.mouse.move(180,305,{steps:8});await page.mouse.up();
 await page.getByTestId('camera-start').waitFor();
 check(await page.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'edge-swipe back stops the camera');
 await page.getByTestId('camera-start').click();await page.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='running',null,{timeout:90000});
 await page.getByTestId('mode-video').click();await page.getByTestId('sample-video').waitFor();
 check(await page.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'switching mode stops and releases every camera track');
 await page.getByTestId('sample-video').click();await page.getByTestId('cancel-analysis').click();
 await page.getByTestId('sample-video').waitFor();check(await page.evaluate(()=>!window.__MANY_FACES_VERIFY__),'cancel returns cleanly without a false successful report');
 check(report.pageErrors.length===0,'no uncaught page errors');
 report.passed=true;
}catch(error){report.error=String(error.stack||error);if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
