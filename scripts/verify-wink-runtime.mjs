import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const out='work/wink-runtime';await fs.mkdir(out,{recursive:true});
const support=JSON.parse(await fs.readFile('public/wink-support/v1/catalog.json','utf8'));
const report={commit:process.env.GITHUB_SHA,baseline:'33670161de8affba26129c09de315f4803ad100f',trials:[],checks:[],physicalCameraVerified:false,hostedSiteVerified:false,independentHumanLabels:false,passed:false};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
let browser,page;
async function trial(name,port,file,{heldout=false,missing=false}={}){
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 if(heldout)await context.route('**/wink-support/v1/catalog.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...support,items:support.items.filter(item=>item.supportKind==='core-refresh')})}));
 if(missing)await context.route('**/wink-support/v1/catalog.json',route=>route.fulfill({status:404,body:'Missing optional overlay for regression test'}));
 await context.addInitScript(()=>{
  const Native=window.Worker;
  window.Worker=class extends Native{
   postMessage(message,...args){
    if(Array.isArray(message?.frames)&&message.build){window.__winkInput=structuredClone(message.frames);this.addEventListener('message',event=>{if(event.data?.type==='result')window.__winkResult={build:event.data.build,metrics:event.data.performanceMetrics,choices:event.data.choices.map(c=>({id:c.candidate.id,url:c.candidate.url,feature:c.candidate.feature,projection:Array.from(c.candidate.geometry.projection),supportKind:c.candidate.supportKind??null,time:c.frame.time,error:c.error}))};});}
    return super.postMessage(message,...args);
   }
  };
 });
 page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=`http://127.0.0.1:${port}`,identity=await (await context.request.get(base+'/api/runtime')).json();
 await page.goto(base+'/live',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__MANY_FACES_RUNTIME__?.phase==='idle',null,{timeout:30000});
 const start=Date.now();await page.getByTestId('video-input').setInputFiles(path.resolve(file));
 await page.waitForFunction(()=>window.__MANY_FACES_VERIFY__||window.__MANY_FACES_RUNTIME__?.phase==='error',null,{timeout:360000});
 const state=await page.evaluate(()=>({report:window.__MANY_FACES_VERIFY__,runtime:window.__MANY_FACES_RUNTIME__,search:window.__winkResult,frames:JSON.stringify(window.__winkInput,(_k,v)=>ArrayBuffer.isView(v)?Array.from(v):v)}));
 assert(state.report?.passed,JSON.stringify(state.runtime));assert.equal(state.report.imageFailures,0);assert.equal(errors.length,0,errors.join(';'));assert.equal(state.report.build,identity.build);assert.equal(state.search.build,identity.build);
 const row={name,identity,wallMs:Date.now()-start,...state.report,framesHash:hash(state.frames),metrics:state.search.metrics,choiceHash:hash(state.search.choices.map(c=>({id:c.id,time:c.time,error:c.error}))),uncaughtErrors:errors};
 if(port===4183){
  const check=await page.evaluate(async()=>{
   const {winkEvidence,inspectWinkUrls}=await import('/__wink_runtime/probe.js');
   const input=window.__winkInput,choices=window.__winkResult.choices;
   const expected=input.map((f,i)=>({i,evidence:winkEvidence(f.feature,f.geometry.projection)})).filter(r=>r.evidence);
   const selected=[...new Map(expected.map(r=>[choices[r.i].id,{id:choices[r.i].id,url:choices[r.i].url}])).values()];
   const fresh=await inspectWinkUrls(selected),byId=new Map(fresh.map(r=>[r.id,r.evidence]));
   return {winkFrames:expected.length,correctClosedEyeFrames:expected.filter(r=>byId.get(choices[r.i].id)?.side===r.evidence.side).length,selected,fresh};
  });
  row.freshOutputCheck=check;
  if(heldout){assert(check.winkFrames>20,'not enough actual detected wink frames');assert.equal(check.correctClosedEyeFrames,check.winkFrames,'selected actual images lost the input eye state');assert(state.search.choices.every(c=>c.supportKind!=='addition'),'source-photo holdout leaked into output');assert(state.search.metrics.wink.supportedFrames>0);}
  if(missing){assert(state.search.metrics.wink.indexError);assert.equal(state.search.metrics.wink.supportedFrames,0);assert(state.search.metrics.wink.fallbackFrames>0);}
  await page.getByTestId('play-pause').click();await page.waitForTimeout(350);await page.getByTestId('play-pause').click();await page.getByTestId('step-forward').click();assert(await page.getByTestId('input-video').evaluate(v=>v.paused&&v.currentTime>0));
  await page.getByTestId('settings').click();await page.getByRole('button',{name:'画像情報・診断',exact:true}).click();
  assert(await page.getByTestId('wink-attribution').isVisible());const credits=await context.request.get(base+'/wink-support/v1/ATTRIBUTION.html');assert(credits.ok());assert((await credits.text()).includes('CC BY'));
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.screenshot({path:`${out}/${name}.png`});
 }
 await fs.writeFile(`${out}/${name}.json`,JSON.stringify({...row,choices:state.search.choices},null,2));
 report.trials.push({...row,sequenceIds:undefined,freshOutputCheck:row.freshOutputCheck&&{winkFrames:row.freshOutputCheck.winkFrames,correctClosedEyeFrames:row.freshOutputCheck.correctClosedEyeFrames,selectedPhotos:row.freshOutputCheck.selected.length}});
 console.log('WINK_RUNTIME_TRIAL '+JSON.stringify(report.trials.at(-1)));
 await browser.close();browser=null;return state;
}
try{
 const before=await trial('reference-before',4185,'public/test-fixtures/reference-face-motion.mp4');
 const after=await trial('reference-after',4183,'public/test-fixtures/reference-face-motion.mp4');
 assert.equal(before.frames,after.frames,'input acquisition or model changed');
 assert.equal(before.report.plannedFrames,466);assert.equal(after.report.plannedFrames,466);assert.equal(before.report.faceFrames,after.report.faceFrames);assert.equal(after.report.sequenceFrames,after.report.faceFrames);
 report.checks.push('complete reference recording, identical acquired descriptors, nonblank output, no image failures, playback/pause/frame stepping and credit link');
 await trial('photo-heldout-winks',4183,'work/wink-runtime/heldout-winks.mp4',{heldout:true});
 report.checks.push('actual encoded-video UI uses original photos for held-out wink inputs and fresh output pixels preserve the anatomical eye state');
 await trial('missing-optional-index',4183,'work/wink-runtime/fallback.mp4',{missing:true});
 report.checks.push('missing optional index falls back to the unchanged core matcher without false support success');
 report.passed=true;
}catch(error){report.error=String(error.stack||error);if(page&&!page.isClosed())report.failure=await page.evaluate(()=>({runtime:window.__MANY_FACES_RUNTIME__,alert:document.querySelector('[role="alert"]')?.textContent})).catch(()=>null);process.exitCode=1;}
finally{await browser?.close();await fs.writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('WINK_RUNTIME_FINAL '+JSON.stringify(report));}
