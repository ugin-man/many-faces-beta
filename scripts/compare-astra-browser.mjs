import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const out=path.resolve('work/astra-adversarial');
await fs.mkdir(out,{recursive:true});
const report={testedCommit:process.env.GITHUB_SHA||null,baselineCommit:'e6e380a1b4f585a1b0836b262c991e4c8b188939',input:'native virtual camera; three changing public catalog photographs',physicalCameraVerified:false,privateUserVideoUsed:false,measurement:'12-second frame/output deltas after output and warmup; ABBA order, fresh browser for every trial',trials:[],passed:false};
const state=page=>page.evaluate(()=>window.__MANY_FACES_REALTIME__);
function check(value,message){if(!value)throw new Error(message);}
function kind(url){if(url.includes('/api/catalog/shard'))return 'shard';if(url.includes('/api/catalog/image'))return 'image';if(url.includes('/api/mediapipe/'))return 'model';return null;}
async function trial(variant,index){
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${path.resolve('work/astra-fixtures/moving.y4m')}`]});
  const context=await browser.newContext({viewport:{width:1280,height:920},permissions:['camera']});
  const responses={shard:0,image:0,model:0},errors=[];
  context.on('response',r=>{const k=kind(r.url());if(k)responses[k]++;});
  await context.addInitScript(()=>{
    const Native=window.Worker;
    window.__astraWorkerAudit={messages:0,last:null};
    window.Worker=class extends Native {
      constructor(...args){super(...args);this.addEventListener('message',event=>{
        if(event.data?.type==='frame'){
          window.__astraWorkerAudit.messages++;
          // Store only scalar diagnostics, never input imagery or face vectors.
          window.__astraWorkerAudit.last=event.data.diagnostics||null;
        }
      });}
    };
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  try{
    const port=variant==='before'?4175:4173;
    await page.goto(`http://127.0.0.1:${port}/live/astra`,{waitUntil:'networkidle'});
    const clicked=Date.now();await page.getByTestId('camera-start').click();
    await page.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error'||(window.__MANY_FACES_REALTIME__?.frames>=10&&window.__MANY_FACES_REALTIME__?.outputChanges>0),null,{timeout:65000});
    const startup=await state(page);check(startup.phase==='running',startup.message);
    const firstObservedOutputFromClickMs=Date.now()-clicked;
    await page.waitForTimeout(2000);
    const start=await state(page),startAt=performance.now(),responsesAtStart={...responses};
    for(let i=0;i<12;i++){
      await page.waitForTimeout(1000);
      const s=await state(page);check(s.phase==='running',s.message);
    }
    const finish=await state(page),seconds=(performance.now()-startAt)/1000;
    check(finish.catalogTotal===70000,'not the full catalog');
    check(finish.maxInFlight===1,'unbounded in-flight frames');
    check(finish.imageBytes<=32*1024*1024&&finish.pendingImages<=3,'image budget exceeded');
    check(finish.frames>start.frames,'processing stopped');
    check(errors.length===0,`page errors: ${errors.join('; ')}`);
    const diagnostics=await page.evaluate(()=>window.__astraWorkerAudit);
    const row={variant,index,seconds,firstObservedOutputFromClickMs,processedFrames:finish.frames-start.frames,faceFrames:finish.faceFrames-start.faceFrames,outputChanges:finish.outputChanges-start.outputChanges,processedFps:(finish.frames-start.frames)/seconds,actualOutputRate:(finish.outputChanges-start.outputChanges)/seconds,sessionLatencyP95Ms:finish.latencyP95Ms,imageRequests:finish.imageRequests-start.imageRequests,networkResponses:Object.fromEntries(Object.keys(responses).map(k=>[k,responses[k]-responsesAtStart[k]])),final:finish,workerDiagnostics:diagnostics};
    await page.screenshot({path:path.join(out,`${variant}-${index}.png`),fullPage:true});
    await page.getByTestId('stop').click();
    return row;
  }finally{await browser.close();}
}
try{
  for(const [index,variant] of ['before','after','after','before'].entries()){
    console.log(`Starting paired trial ${index+1}: ${variant}`);
    report.trials.push(await trial(variant,index));
  }
  const mean=(rows,key)=>rows.reduce((sum,row)=>sum+row[key],0)/rows.length;
  const before=report.trials.filter(r=>r.variant==='before'),after=report.trials.filter(r=>r.variant==='after');
  report.summary=Object.fromEntries(['processedFps','actualOutputRate','sessionLatencyP95Ms','imageRequests'].map(key=>[key,{before:mean(before,key),after:mean(after,key)}]));
  report.performanceGate=mean(after,'processedFps')>=mean(before,'processedFps')*0.95;
  check(report.performanceGate,'paired throughput regressed by more than 5%');
  report.passed=true;
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'paired-browser-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
