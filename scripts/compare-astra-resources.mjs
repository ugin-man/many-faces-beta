import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const out=path.resolve('work/astra-resource-audit');await fs.mkdir(out,{recursive:true});
const report={testedCommit:process.env.GITHUB_SHA||null,baselineCommit:process.env.ASTRA_BASELINE_COMMIT||null,input:'same three public photographs, native virtual camera',physicalCameraVerified:false,privateUserVideoUsed:false,measurement:'ABBA; fresh browser processes; 20-second count deltas after warmup',resourceMeaning:'Same-origin Window and Worker Resource Timing entries initiated and ended within the interval; entries can include failed or cancelled loads. Separate lifecycle events record failures. transferSize is browser-reported transfer including fixed header accounting, not a packet capture. Zero transferSize with positive decodedBodySize indicates local cache service in this same-origin test.',trials:[],passed:false};
function check(value,message){if(!value)throw new Error(message);}
const state=page=>page.evaluate(()=>window.__MANY_FACES_REALTIME__);
function classify(name){if(name.includes('/api/catalog/shard'))return 'shard';if(name.includes('/api/catalog/image'))return 'image';if(name.includes('/api/mediapipe/'))return 'model';return null;}
function resourceSummary(entries){
  return Object.fromEntries(['shard','image','model'].map(kind=>{
    const rows=entries.filter(e=>classify(e.name)===kind),unique=new Set(rows.map(e=>e.name));
    return [kind,{resourceEntries:rows.length,uniqueObjects:unique.size,repeatedRequests:rows.length-unique.size,browserTransferBytes:rows.reduce((s,e)=>s+e.transferSize,0),decodedBodyBytes:rows.reduce((s,e)=>s+e.decodedBodySize,0),locallyCachedResponses:rows.filter(e=>e.transferSize===0&&e.decodedBodySize>0).length,unclassifiedZeroSizeResponses:rows.filter(e=>e.transferSize===0&&e.decodedBodySize===0).length}];
  }));
}
async function begin(scope){await scope.evaluate(()=>{performance.setResourceTimingBufferSize(20000);globalThis.__astraResourceBegin=performance.now();});}
async function finish(scope){return scope.evaluate(()=>{const end=performance.now();return performance.getEntriesByType('resource').filter(e=>e.startTime>=globalThis.__astraResourceBegin&&e.responseEnd>0&&e.responseEnd<=end).map(e=>({name:e.name,startTime:e.startTime,responseEnd:e.responseEnd,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize,deliveryType:e.deliveryType??null,responseStatus:e.responseStatus??null}));});}
async function trial(variant,index){
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${path.resolve('work/astra-fixtures/moving.y4m')}`]});
  const context=await browser.newContext({viewport:{width:1280,height:920},permissions:['camera']});
  await context.addInitScript(()=>{
    performance.setResourceTimingBufferSize(20000);
    const Native=window.Worker;window.__astraLastWorkerStats=null;
    window.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data?.type==='frame')window.__astraLastWorkerStats=e.data.diagnostics||null;});}};
  });
  const page=await context.newPage(),errors=[],requestFailures=[],httpErrors=[];
  let measuring=false;
  context.on('requestfailed',r=>{if(measuring&&classify(r.url()))requestFailures.push({kind:classify(r.url()),url:r.url(),error:r.failure()?.errorText||'unknown'});});
  context.on('response',r=>{if(measuring&&classify(r.url())&&r.status()>=400)httpErrors.push({kind:classify(r.url()),url:r.url(),status:r.status()});});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('worker',worker=>void worker.evaluate(()=>performance.setResourceTimingBufferSize(20000)).catch(()=>{}));
  try{
    await page.goto(`http://127.0.0.1:${variant==='before'?4175:4173}/live/astra`,{waitUntil:'networkidle'});
    await page.getByTestId('camera-start').click();
    await page.waitForFunction(()=>window.__MANY_FACES_REALTIME__?.phase==='error'||(window.__MANY_FACES_REALTIME__?.frames>=10&&window.__MANY_FACES_REALTIME__?.outputChanges>0),null,{timeout:65000});
    check((await state(page)).phase==='running',(await state(page)).message);
    await page.waitForTimeout(3000);
    const workers=page.workers();check(workers.length>0,'Inference worker missing');
    await begin(page);for(const worker of workers)await begin(worker);
    const start=await state(page),startAt=performance.now();measuring=true;
    for(let second=0;second<20;second++){await page.waitForTimeout(1000);const s=await state(page);check(s.phase==='running',s.message);}
    const end=await state(page),seconds=(performance.now()-startAt)/1000;measuring=false;
    const resources=await finish(page);for(const worker of workers)resources.push(...await finish(worker));
    check(resources.some(e=>classify(e.name)==='shard'&&e.decodedBodySize>0),'Missing worker resource-size evidence');
    check(requestFailures.filter(e=>e.kind==='shard').length===0,'Shard request failed during measurement');
    check(httpErrors.length===0,`HTTP errors: ${JSON.stringify(httpErrors)}`);
    check(end.catalogTotal===70000,'Catalog was reduced');check(end.maxInFlight===1,'Frame backlog');
    check(end.shards<=48,'Parsed shard capacity grew');check(end.imageBytes<=32*1024*1024&&end.pendingImages<=3,'Image budget exceeded');
    check(end.frames>start.frames,'No processing');check(end.imageFailures===0,'Image failure');check(errors.length===0,errors.join(';'));
    const row={variant,index,seconds,processedFps:(end.frames-start.frames)/seconds,actualOutputRate:(end.outputChanges-start.outputChanges)/seconds,faceFrames:end.faceFrames-start.faceFrames,sessionLatencyP95Ms:end.latencyP95Ms,resource:resourceSummary(resources),requestFailures,httpErrors,final:end,workerDiagnostics:await page.evaluate(()=>window.__astraLastWorkerStats)};
    await fs.writeFile(path.join(out,`${variant}-${index}-resources.json`),JSON.stringify(resources,null,2)+'\n');
    await page.screenshot({path:path.join(out,`${variant}-${index}.png`),fullPage:true});
    await page.getByTestId('stop').click();
    return row;
  }finally{await browser.close();}
}
try{
  for(const [i,v] of ['before','after','after','before'].entries()){console.log(`Resource trial ${i+1}: ${v}`);report.trials.push(await trial(v,i));}
  const before=report.trials.filter(r=>r.variant==='before'),after=report.trials.filter(r=>r.variant==='after');
  const mean=(rows,fn)=>rows.reduce((s,row)=>s+fn(row),0)/rows.length;
  const metrics={processedFps:r=>r.processedFps,actualOutputRate:r=>r.actualOutputRate,meanSessionP95Ms:r=>r.sessionLatencyP95Ms,shardResourceEntries:r=>r.resource.shard.resourceEntries,distinctShards:r=>r.resource.shard.uniqueObjects,shardBrowserTransferBytes:r=>r.resource.shard.browserTransferBytes,shardDecodedBodyBytes:r=>r.resource.shard.decodedBodyBytes,locallyCachedShardResponses:r=>r.resource.shard.locallyCachedResponses,imageBrowserTransferBytes:r=>r.resource.image.browserTransferBytes};
  report.summary=Object.fromEntries(Object.entries(metrics).map(([k,fn])=>[k,{before:mean(before,fn),after:mean(after,fn)}]));
  report.throughputGate=report.summary.processedFps.after>=report.summary.processedFps.before*.95;
  report.shardEntryImprovement=report.summary.shardResourceEntries.after<report.summary.shardResourceEntries.before;
  check(report.throughputGate,'Paired throughput regressed >5%');report.passed=true;
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'paired-resource-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
