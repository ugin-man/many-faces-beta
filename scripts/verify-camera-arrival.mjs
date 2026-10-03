import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const out=path.resolve('work/camera-arrival');await fs.mkdir(out,{recursive:true});
const report={commit:process.env.GITHUB_SHA,baseline:'de063df626617178c6296f660eb3931d73feb3c8',physicalCameraVerified:false,hostedSiteVerified:false,description:'Native file-backed camera with real MediaPipe and full 70k assets. Only timing/counter API behavior is fault-injected; frames, landmarks and ranked images are not mocked.',cases:[],checks:[],pageErrors:[],passed:false};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${path.resolve('work/astra-fixtures/moving.y4m')}`]});
let page;
const check=(condition,message)=>{assert.ok(condition,message);report.checks.push(message);};
const snap=p=>p.evaluate(()=>window.__MANY_FACES_REALTIME__);
async function setup(port,mode){
  const context=await browser.newContext({permissions:['camera'],viewport:{width:960,height:720}});
  await context.addInitScript(({mode})=>{
    window.__timingTest={callbacks:0,lastPresented:null,lastRealMediaTime:null,freeze:false,frozenQuality:null,frozenPresented:null,frozenLegacy:null};
    const state=window.__timingTest;
    const acquire=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__streams=[];
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await acquire(constraints);window.__streams.push(stream);return stream;};
    const original=HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){
      if(mode==='decoder-only')return 1;
      return original.call(this,(now,metadata)=>{
        state.callbacks++;state.lastPresented=metadata.presentedFrames;state.lastRealMediaTime=metadata.mediaTime;
        if(state.freeze){
          state.frozenPresented??=metadata.presentedFrames;
          callback(now,{...metadata,mediaTime:0,presentedFrames:state.frozenPresented});
        }else callback(now,{...metadata,...(mode==='normal'?{}:{mediaTime:0})});
      });
    };
    if(mode==='decoder-only')HTMLVideoElement.prototype.cancelVideoFrameCallback=function(){};
    const clock=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    Object.defineProperty(HTMLVideoElement.prototype,'currentTime',{configurable:true,get(){return mode==='decoder-only'||state.freeze?0:clock.get.call(this);},set(value){clock.set.call(this,value);}});
    const quality=HTMLVideoElement.prototype.getVideoPlaybackQuality;
    HTMLVideoElement.prototype.getVideoPlaybackQuality=function(){
      const q=quality.call(this);
      const result={totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames,creationTime:q.creationTime};
      if(state.freeze){state.frozenQuality??=result;return state.frozenQuality;}return result;
    };
    const legacy=Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype,'webkitDecodedFrameCount');
    if(legacy?.get)Object.defineProperty(HTMLVideoElement.prototype,'webkitDecodedFrameCount',{configurable:true,get(){const n=legacy.get.call(this);if(state.freeze){state.frozenLegacy??=n;return state.frozenLegacy;}return n;}});
  },{mode});
  const p=await context.newPage();page=p;p.on('pageerror',e=>report.pageErrors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/live/astra`,{waitUntil:'networkidle'});
  await p.getByTestId('camera-start').click();
  await p.waitForFunction(()=>['running','error'].includes(window.__MANY_FACES_REALTIME__?.phase),null,{timeout:65000});
  const s=await snap(p);check(s.phase==='running',`startup succeeds: ${mode}/${port} ${s.message}`);
  return {p,context};
}
async function tracksStopped(p){return p.evaluate(()=>window.__streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));}
try{
  // A standards-permitted zero live PTS must not make real arriving frames stale.
  const baseline=await setup(4185,'zero-pts');let began=Date.now();
  await baseline.p.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error',null,{timeout:13000});
  const old=await snap(baseline.p),oldRaw=await baseline.p.evaluate(()=>window.__timingTest);
  check(old.errorCode==='VIDEO_FRAMES_STALLED','unchanged baseline reproduces the exact input-stall error');
  check(oldRaw.callbacks>30&&oldRaw.lastPresented>30,'the baseline stalls despite genuine compositor frame callbacks');
  report.cases.push({name:'baseline-zero-pts',elapsedRunningMs:Date.now()-began,state:old,raw:oldRaw});
  await baseline.p.screenshot({path:path.join(out,'baseline-false-stall.png')});await baseline.context.close();

  for(const mode of ['zero-pts','decoder-only','normal']){
    const test=await setup(4183,mode);began=Date.now();
    await test.p.waitForTimeout(11500);
    const state=await snap(test.p);
    check(state.phase==='running'&&state.frames>30&&state.outputChanges>0,`real output continues beyond eight seconds: ${mode}`);
    check(state.maxInFlight===1&&state.catalogTotal===70000,`single-flight and complete catalog retained: ${mode}`);
    if(mode==='decoder-only')check(state.frameClock==='decoded-frames'||state.frameClock==='playback-clock','decoder counter fallback is actually exercised');
    report.cases.push({name:`fixed-${mode}`,elapsedRunningMs:Date.now()-began,state,raw:await test.p.evaluate(()=>window.__timingTest)});
    await test.p.screenshot({path:path.join(out,`fixed-${mode}.png`)});
    if(mode==='zero-pts'){
      // Freeze every frame witness, not just PTS; timer/callback activity must
      // never refresh the application's input watchdog by itself.
      await test.p.evaluate(()=>{window.__timingTest.freeze=true;});const freezeAt=Date.now();
      await test.p.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error',null,{timeout:13000});
      const stopped=await snap(test.p);
      check(stopped.errorCode==='VIDEO_FRAMES_STALLED','genuinely frozen frame evidence still trips the original eight-second watchdog');
      check(await tracksStopped(test.p),'input-stall cleanup releases every acquired camera track');
      report.cases.push({name:'fixed-all-witnesses-frozen',elapsedFrozenMs:Date.now()-freezeAt,state:stopped});
      await test.p.evaluate(()=>{window.__timingTest.freeze=false;});
      await test.p.getByTestId('camera-start').click();
      await test.p.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error'||window.__MANY_FACES_REALTIME__?.outputChanges>0,null,{timeout:65000});
      check((await snap(test.p)).phase==='running','restart after actual input stall produces output');
    }
    await test.p.getByTestId('stop').click();check(await tracksStopped(test.p),`explicit stop releases all tracks: ${mode}`);
    await test.p.getByTestId('mode-video').click();await test.p.getByTestId('sample-video').waitFor();
    check(await tracksStopped(test.p),`working video mode remains accessible: ${mode}`);
    await test.context.close();
  }
  check(report.pageErrors.length===0,'no uncaught page errors');report.passed=true;
}catch(error){report.error=error.stack||String(error);if(page&&!page.isClosed()){report.failureSnapshot=await snap(page).catch(()=>null);report.failureRaw=await page.evaluate(()=>window.__timingTest).catch(()=>null);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
