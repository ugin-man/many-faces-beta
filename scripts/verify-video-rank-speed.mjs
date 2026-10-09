import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const out='work/video-rank';await fs.mkdir(out,{recursive:true});
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const report={commit:process.env.GITHUB_SHA,baseline:'03488140287d51af994417b7a4d613ac388ca46f',densityFps:20,catalogFaces:70000,fixtureSha256:createHash('sha256').update(await fs.readFile('public/test-fixtures/reference-face-motion.mp4')).digest('hex'),trials:[],sameFrameReplay:[],checks:[],hostedSiteVerified:false,passed:false};
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
let browser,page,inputFrames;const scripts={},allChoices=[];
try{
 for(const [index,variant] of ['before','after','after','before'].entries()){
  const base=`http://127.0.0.1:${variant==='before'?4185:4183}`;
  browser=await launch();const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{
   const NativeWorker=window.Worker;
   window.Worker=class extends NativeWorker{
    constructor(url,options){super(url,options);this.__rankUrl=new URL(String(url),location.href).href;}
    postMessage(message,...rest){
     if(Array.isArray(message?.frames)&&message.build){
      window.__rankInput=structuredClone(message);window.__rankWorkerUrl=this.__rankUrl;
      this.addEventListener('message',event=>{if(event.data?.type==='result')window.__rankResult={metrics:event.data.performanceMetrics||null,choices:event.data.choices.map(choice=>({id:choice.candidate.id,time:choice.frame.time,error:choice.error,emission:choice.emission,accepted:choice.accepted,expressionMotion:choice.expressionMotion}))};});
     }
     return super.postMessage(message,...rest);
    }
   };
  });
  page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const identity=await (await context.request.get(base+'/api/runtime')).json();
  await page.goto(base+'/live',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__MANY_FACES_RUNTIME__?.phase==='idle',null,{timeout:30000});
  const started=Date.now();
  await page.getByTestId('video-input').setInputFiles(path.resolve('public/test-fixtures/reference-face-motion.mp4'));
  await page.waitForFunction(()=>window.__MANY_FACES_VERIFY__||window.__MANY_FACES_RUNTIME__?.phase==='error',null,{timeout:480000});
  const wallMs=Date.now()-started;
  const observed=await page.evaluate(()=>({result:window.__MANY_FACES_VERIFY__,runtime:window.__MANY_FACES_RUNTIME__,search:window.__rankResult,worker:window.__rankWorkerUrl,duration:document.querySelector('[data-testid="input-video"]').duration}));
  assert.equal(observed.result?.passed,true,JSON.stringify(observed.runtime));
  assert.ok(observed.duration>23);assert.equal(observed.result.plannedFrames,Math.floor(observed.duration*20));
  assert.equal(observed.result.sequenceFrames,observed.result.faceFrames);assert.equal(observed.result.imageFailures,0);assert.equal(errors.length,0,errors.join(';'));
  const frames=await page.evaluate(()=>JSON.stringify(window.__rankInput.frames,(_key,value)=>ArrayBuffer.isView(value)?{__typed:value.constructor.name,data:Array.from(value)}:value));
  if(!inputFrames)inputFrames=frames;
  scripts[variant]={code:await (await context.request.get(observed.worker)).text(),build:identity.build};
  const choices=observed.search.choices;allChoices.push(choices);
  const trial={index,variant,wallMs,identity,duration:observed.duration,framesHash:hash(frames),...observed.result,metrics:observed.search.metrics,choiceHash:hash(choices)};
  await fs.writeFile(`${out}/${variant}-${index}.json`,JSON.stringify({...trial,choices},null,2));
  report.trials.push({...trial,sequenceIds:undefined});console.log('RANK_SPEED_TRIAL '+JSON.stringify(report.trials.at(-1)));
  if(variant==='after'){
   await page.getByTestId('play-pause').click();await page.waitForTimeout(650);await page.getByTestId('play-pause').click();await page.getByTestId('step-forward').click();
   assert.ok(await page.getByTestId('input-video').evaluate(v=>v.currentTime>0&&v.paused));
   await page.getByTestId('review-seek').focus();await page.keyboard.press('End');
   assert.ok(await page.getByTestId('input-video').evaluate(v=>v.currentTime>20));
   report.checks.push(`playback/pause/frame-step/seek ${index}`);
  }
  await browser.close();browser=null;
 }
 assert.equal(new Set(report.trials.map(t=>t.framesHash)).size,1,'acquired frame descriptors changed');
 for(const choices of allChoices.slice(1))assert.deepEqual(choices,allChoices[0],'full-video output differs');
 for(const t of report.trials)assert.deepEqual(t.searchTraffic,report.trials[0].searchTraffic,'hidden candidate-data reduction');
 report.checks.push('all four acquired-descriptor arrays and complete ID/error/sequence decisions match');
 // Both unmodified, compiled worker bundles receive the very same captured
 // descriptors. This is an equality check, not a cold-network timing claim.
 browser=await launch();const context=await browser.newContext();page=await context.newPage();
 await page.goto('http://127.0.0.1:4183/live',{waitUntil:'networkidle'});
 const replay=[];
 for(const variant of ['before','after']){
  const result=await page.evaluate(async({script,frames})=>{
   const input=JSON.parse(frames,(_key,v)=>v?.__typed==='Float32Array'?new Float32Array(v.data):v?.__typed==='Float64Array'?new Float64Array(v.data):v);
   const url=URL.createObjectURL(new Blob([script.code],{type:'text/javascript'}));const worker=new Worker(url);let progress=null;
   try{return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('same-frame worker timeout')),480000);
    worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};
    worker.onmessage=e=>{
     const v=e.data;
     if(v.type==='progress')progress=v;
     else if(v.type==='error'){clearTimeout(timer);reject(new Error(v.message));}
     else if(v.type==='result'){clearTimeout(timer);resolve({candidateSearchMs:v.candidateSearchMs,pathOptimizationMs:v.pathOptimizationMs,metrics:v.performanceMetrics||null,progress,choices:v.choices.map(c=>({id:c.candidate.id,time:c.frame.time,error:c.error,emission:c.emission,accepted:c.accepted,expressionMotion:c.expressionMotion}))});}
    };
    worker.postMessage({frames:input,origin:location.origin,build:script.build});
   });}finally{worker.terminate();URL.revokeObjectURL(url);}
  },{script:scripts[variant],frames:inputFrames});
  replay.push(result.choices);report.sameFrameReplay.push({variant,...result,choices:undefined,choiceCount:result.choices.length,choiceHash:hash(result.choices)});
  console.log('RANK_SPEED_REPLAY '+JSON.stringify(report.sameFrameReplay.at(-1)));
 }
 assert.deepEqual(replay[0],replay[1]);assert.deepEqual(replay[0],allChoices[0]);
 for(const key of ['bytes','files','decoded','completed','total','peakCandidates'])assert.equal(report.sameFrameReplay[0].progress[key],report.sameFrameReplay[1].progress[key]);
 report.checks.push('same-frame deep equality and unchanged bytes/files/decoded candidates/peak');
 for(const variant of ['before','after']){
  const rows=report.trials.filter(t=>t.variant===variant);
  report[variant+'Mean']={wallMs:rows.reduce((s,t)=>s+t.wallMs,0)/rows.length,processingMs:rows.reduce((s,t)=>s+t.processingMs,0)/rows.length,rankMs:rows.reduce((s,t)=>s+t.metrics.candidateRankMs,0)/rows.length,phaseTimingsMs:{}};
  for(const key of Object.keys(rows[0].phaseTimingsMs))report[variant+'Mean'].phaseTimingsMs[key]=rows.reduce((s,t)=>s+t.phaseTimingsMs[key],0)/rows.length;
 }
 report.wallReductionPercent=(1-report.afterMean.wallMs/report.beforeMean.wallMs)*100;
 report.rankReductionPercent=(1-report.afterMean.rankMs/report.beforeMean.rankMs)*100;
 report.passed=true;
}catch(error){report.error=String(error.stack||error);if(page&&!page.isClosed())report.failure=await page.evaluate(()=>({runtime:window.__MANY_FACES_RUNTIME__,alert:document.querySelector('[role="alert"]')?.textContent})).catch(()=>null);process.exitCode=1;}
finally{await browser?.close();await fs.writeFile(`${out}/browser-report.json`,JSON.stringify(report,null,2));console.log('RANK_SPEED_FINAL '+JSON.stringify(report));}
