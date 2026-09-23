import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const base=process.env.MANY_FACES_BASE_URL||'http://127.0.0.1:4173',out=path.resolve('work/input-audit');
const report={testedCommit:process.env.GITHUB_SHA||null,physicalCameraVerified:false,privateUserVideoUsed:false,stimulus:'existing public photo/video, native Chromium virtual camera; explicit API failure injection',camera:[],fixedVideo:[],checks:{},errors:[],passed:false};
const check=(value,message)=>{if(!value)throw new Error(message);};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${path.resolve('work/astra-fixtures/moving.y4m')}`]});
const snapshot=page=>page.evaluate(()=>window.__MANY_FACES_REALTIME__);
async function waitLive(page){
  await page.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error'||(window.__MANY_FACES_REALTIME__?.frames>=15&&window.__MANY_FACES_REALTIME__?.outputChanges>0),null,{timeout:65000});
  const state=await snapshot(page);check(state.phase==='running',JSON.stringify(state));check(state.catalogTotal===70000,'Catalog reduction');return state;
}
async function transforms(page){return page.evaluate(()=>[document.querySelector('[data-testid="input-video"]'),document.querySelector('[data-testid="output-canvas"]')].map(node=>getComputedStyle(node).transform));}
let activePage;
try{
  // Real media/model paths; only the two potentially unsupported browser API
  // behaviors are injected. This is not a simulation of the user's hardware.
  const recovery=await browser.newContext({permissions:['camera'],viewport:{width:1280,height:920}});
  await recovery.addInitScript(()=>{
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(){return 1;};
    HTMLVideoElement.prototype.cancelVideoFrameCallback=function(){};
    const bitmap=window.createImageBitmap.bind(window);
    window.__videoBitmapAttempts=0;
    window.createImageBitmap=(source,...args)=>{if(source instanceof HTMLVideoElement){window.__videoBitmapAttempts++;throw new DOMException('Injected video bitmap incompatibility','NotSupportedError');}return bitmap(source,...args);};
    const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__streams=[];
    navigator.mediaDevices.getUserMedia=async options=>{const stream=await capture(options);window.__streams.push(stream);return stream;};
  });
  const rp=activePage=await recovery.newPage();rp.on('pageerror',e=>report.errors.push(e.message));
  await rp.goto(base+'/live/astra',{waitUntil:'networkidle'});await rp.getByTestId('camera-start').click();
  report.camera.push({name:'no-rvfc-and-no-video-bitmap',...await waitLive(rp)});
  check((await snapshot(rp)).frameClock==='playback-clock','Live stream callback fallback was not used');
  check(await rp.evaluate(()=>window.__videoBitmapAttempts===0),'Live input still calls createImageBitmap(video)');
  let mirror=await transforms(rp);check(mirror[0]===mirror[1]&&mirror[0]!=='none','Mirroring differs between camera and output');
  await rp.getByTestId('mirror-toggle').uncheck();mirror=await transforms(rp);check(mirror[0]===mirror[1]&&mirror[0]==='none','Mirror-off differs between panes');
  await rp.screenshot({path:path.join(out,'camera-recovery.png'),fullPage:true});
  await rp.getByTestId('stop').click();
  check(await rp.evaluate(()=>window.__streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),'Stop leaked a camera track');
  await rp.getByTestId('camera-start').click();await waitLive(rp);await rp.getByTestId('stop').click();
  report.checks.injectedApiRecovery=true;report.checks.pairedPresentationMirror=true;report.checks.restart=true;
  await rp.getByTestId('video-input').setInputFiles(path.resolve('public/__input_audit/face.mp4'));await waitLive(rp);
  mirror=await transforms(rp);check(mirror[0]===mirror[1]&&mirror[0]==='none','Video defaults to a reflected source');
  report.checks.videoStillWorks=true;await rp.getByTestId('stop').click();await recovery.close();

  const policy=await browser.newContext({permissions:['camera']});
  const pp=activePage=await policy.newPage();await pp.goto(base+'/live/astra');
  await pp.evaluate(()=>{const iframe=document.createElement('iframe');iframe.name='blocked';iframe.allow="camera 'none'";iframe.src='/live/astra';document.body.append(iframe);});
  const child=pp.frameLocator('iframe[name="blocked"]');await child.getByTestId('camera-start').click();
  await child.getByRole('alert').filter({hasText:'CAMERA_POLICY_BLOCKED'}).waitFor({timeout:15000});
  check(await child.getByTestId('open-direct').isVisible(),'Missing user-visible direct Site link');
  report.checks.embeddedPolicyExplained=true;await policy.close();

  const denied=await browser.newContext();const dp=activePage=await denied.newPage();await dp.goto(base+'/live/astra');await dp.getByTestId('camera-start').click();
  await dp.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error',null,{timeout:30000});
  check((await snapshot(dp)).errorCode==='CAMERA_PERMISSION_DENIED','Permission denial lost its diagnostic code');
  check(await dp.getByTestId('camera-start').isEnabled(),'No retry after denial');report.checks.denialRecoverable=true;await denied.close();

  // Execute the actual /live screen, not only the new sampling helper. Three
  // analysis densities exercise the initial paused frame and all later seeks.
  const fixed=await browser.newContext({viewport:{width:1280,height:920}});
  const fp=activePage=await fixed.newPage();fp.on('pageerror',e=>report.errors.push(e.message));
  for(const fps of [12,20,30]){
    await fp.goto(base+'/live',{waitUntil:'networkidle'});
    await fp.getByLabel('解析密度',{exact:true}).selectOption(String(fps));
    await fp.getByTestId('verification-file-input').setInputFiles(path.resolve('public/__input_audit/face-five-seconds.mp4'));
    await fp.waitForFunction(()=>Boolean(window.__MANY_FACES_VERIFY__)||window.__MANY_FACES_RUNTIME__?.phase==='error',null,{timeout:240000});
    const result=await fp.evaluate(()=>({report:window.__MANY_FACES_VERIFY__,runtime:window.__MANY_FACES_RUNTIME__,alert:document.querySelector('[role="alert"]')?.textContent}));
    check(result.report?.passed,JSON.stringify(result));
    check(result.report.plannedFrames===fps*5,'Fixed video frame count changed');
    check(result.report.faceFrames===result.report.plannedFrames,'Some public-face frames were not detected');
    check(result.report.sequenceFrames===result.report.faceFrames&&result.report.imageFailures===0&&result.report.canvasNonBlank,'Incomplete fixed-video output');
    report.fixedVideo.push({fps,...result.report});
    await fp.screenshot({path:path.join(out,`fixed-${fps}.png`),fullPage:true});
    await fp.getByRole('button',{name:'+1 frame',exact:true}).click();
    await fp.getByRole('button',{name:'再生',exact:true}).click();await fp.waitForTimeout(300);
    await fp.getByRole('button',{name:'一時停止',exact:true}).click();
  }
  report.checks.fixedVideoPlayback=true;await fixed.close();
  check(report.errors.length===0,report.errors.join('; '));report.passed=true;
}catch(error){report.error=error.stack||String(error);if(activePage&&!activePage.isClosed()){report.failureSnapshot=await activePage.evaluate(()=>({live:window.__MANY_FACES_REALTIME__,fixed:window.__MANY_FACES_RUNTIME__})).catch(()=>null);await activePage.screenshot({path:path.join(out,'input-failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(out,'input-lifecycle.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
