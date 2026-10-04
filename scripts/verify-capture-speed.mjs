import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {verifyVideoCancellation} from './verify-video-cancellation.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const out='work/capture-speed';
await fs.mkdir(out,{recursive:true});
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fixtureSha256=createHash('sha256').update(await fs.readFile('public/test-fixtures/reference-face-motion.mp4')).digest('hex');
const report={commit:process.env.GITHUB_SHA,baseline:'8f075841995d20710ea72300b980b8d125659235',catalogFaces:70000,densityFps:20,fixtureSha256,trials:[],checks:[],hostedSiteVerified:false,passed:false};
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
let browser,page;
try{
 for(const [index,variant] of ['before','after','after','before'].entries()){
  const base=`http://127.0.0.1:${variant==='before'?4185:4183}`;
  browser=await launch();const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker{
      constructor(url,options){super(url,options);this.__speedUrl=new URL(String(url),location.href).href;}
      postMessage(message,...rest){
        if(Array.isArray(message?.frames)&&message.build){
          window.__speedInput=structuredClone(message);window.__speedWorkerUrl=this.__speedUrl;
          this.addEventListener('message',event=>{
            if(event.data?.type==='result')window.__speedResult={
              metrics:event.data.performanceMetrics||null,
              choices:event.data.choices.map(choice=>({id:choice.candidate.id,time:choice.frame.time,error:choice.error,emission:choice.emission,accepted:choice.accepted,expressionMotion:choice.expressionMotion}))
            };
          });
        }
        return super.postMessage(message,...rest);
      }
    };
  });
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const identity=await (await context.request.get(base+'/api/runtime')).json();
  await page.goto(base+'/live',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__MANY_FACES_RUNTIME__?.phase==='idle',null,{timeout:30000});
  const started=Date.now();
  await page.getByTestId('video-input').setInputFiles(path.resolve('public/test-fixtures/reference-face-motion.mp4'));
  await page.waitForFunction(()=>window.__MANY_FACES_VERIFY__||window.__MANY_FACES_RUNTIME__?.phase==='error',null,{timeout:480000});
  const wallMs=Date.now()-started;
  const observed=await page.evaluate(()=>({result:window.__MANY_FACES_VERIFY__,runtime:window.__MANY_FACES_RUNTIME__,search:window.__speedResult,worker:window.__speedWorkerUrl,duration:document.querySelector('[data-testid="input-video"]').duration}));
  assert.equal(observed.result?.passed,true,JSON.stringify(observed.runtime));
  assert.equal(observed.result.plannedFrames,Math.floor(observed.duration*20));assert.ok(observed.duration>23);
  assert.equal(observed.result.sequenceFrames,observed.result.faceFrames);assert.equal(observed.result.imageFailures,0);
  assert.equal(errors.length,0,errors.join(';'));
  const frames=await page.evaluate(()=>JSON.stringify(window.__speedInput.frames,(_key,value)=>ArrayBuffer.isView(value)?{__typed:value.constructor.name,data:Array.from(value)}:value));
  const trial={index,variant,wallMs,identity,duration:observed.duration,framesHash:hash(frames),...observed.result,metrics:observed.search.metrics,choiceHash:hash(observed.search.choices)};
  await fs.writeFile(`${out}/${variant}-${index}.json`,JSON.stringify(trial,null,2));
  report.trials.push({...trial,sequenceIds:undefined});console.log('CAPTURE_SPEED_TRIAL '+JSON.stringify(report.trials.at(-1)));
  if(variant==='after'){
    await page.getByTestId('play-pause').click();await page.waitForTimeout(600);
    await page.getByTestId('play-pause').click();await page.getByTestId('step-forward').click();
    assert.ok(await page.getByTestId('input-video').evaluate(video=>video.currentTime>0&&video.paused));
    report.checks.push(`playback and frame-step ${index}`);
  }
  await browser.close();browser=null;
 }
 const inputHashes = new Set(report.trials.map(trial=>trial.framesHash));
 const outputHashes = new Set(report.trials.map(trial=>trial.choiceHash));
 assert.equal(inputHashes.size,1,'Every acquired face descriptor must be identical across old/new runs');
 assert.equal(outputHashes.size,1,'Every selected ID and numeric error/sequence decision must be identical across old/new runs');
 for (const trial of report.trials) for (const key of ['plannedFrames','faceFrames','sequenceFrames','uniqueFaces','outputChanges']) assert.equal(trial[key],report.trials[0][key],key);
 for (const trial of report.trials) assert.deepEqual(trial.searchTraffic,report.trials[0].searchTraffic,'Search working set must not change');
 report.checks.push('all four descriptor hashes and all four complete sequence/score hashes match');
 report.checks.push('sampling, input resolution, all output counts and search traffic unchanged');
 report.cancellation=await verifyVideoCancellation(out);
 report.checks.push('cancel during a pending catalog response returns to video selection');
 for(const variant of ['before','after']){
  const trials=report.trials.filter(value=>value.variant===variant);
  report[variant+'Mean']={wallMs:trials.reduce((s,t)=>s+t.wallMs,0)/trials.length,processingMs:trials.reduce((s,t)=>s+t.processingMs,0)/trials.length,phaseTimingsMs:{}};
  for(const key of Object.keys(trials[0].phaseTimingsMs))report[variant+'Mean'].phaseTimingsMs[key]=trials.reduce((s,t)=>s+t.phaseTimingsMs[key],0)/trials.length;
 }
 report.wallReductionPercent=(1-report.afterMean.wallMs/report.beforeMean.wallMs)*100;
 report.framePhaseReductionPercent=(1-report.afterMean.phaseTimingsMs.faceMesh/report.beforeMean.phaseTimingsMs.faceMesh)*100;
 assert.ok(report.wallReductionPercent>0,'No measured end-to-end improvement');
 report.passed=true;
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{await browser?.close();await fs.writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE_SPEED_FINAL '+JSON.stringify(report));}
