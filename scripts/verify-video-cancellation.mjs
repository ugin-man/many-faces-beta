import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));

export async function verifyVideoCancellation(out='work/video-speed') {
  await fs.mkdir(out,{recursive:true});
  const report={commit:process.env.GITHUB_SHA,checks:[],history:[],pageErrors:[],interceptedShards:0,passed:false};
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
  let page,unblock;
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    page=await context.newPage();
    page.on('pageerror',error=>report.pageErrors.push(error.message));
    const blocked=new Promise(resolve=>{unblock=resolve;});
    await page.route('**/api/catalog/shard?*',async route=>{
      report.interceptedShards++;
      await blocked;
      await route.abort().catch(()=>{});
    });
    await page.goto('http://127.0.0.1:4183/live',{waitUntil:'domcontentloaded'});
    // DOM presence is not hydration. Wait for the client effect before sending
    // the native file-change event; do not inject any application state.
    await page.waitForFunction(()=>window.__MANY_FACES_RUNTIME__?.phase==='idle',null,{timeout:30000});
    await page.getByTestId('sample-video').waitFor();
    report.checks.push('client hydration confirmed before file selection');
    await page.getByTestId('video-input').setInputFiles(path.resolve('public/test-fixtures/reference-face-motion.mp4'));
    const start=Date.now();
    let lastPhase;
    while(report.interceptedShards===0) {
      const state=await page.evaluate(()=>({runtime:window.__MANY_FACES_RUNTIME__,alert:document.querySelector('[role="alert"]')?.textContent,videoSource:Boolean(document.querySelector('[data-testid="input-video"]')?.currentSrc)}));
      if(state.runtime?.phase!==lastPhase){report.history.push({elapsedMs:Date.now()-start,...state});lastPhase=state.runtime?.phase;}
      if(state.runtime?.phase==='error')throw new Error(JSON.stringify(state));
      if(Date.now()-start>240000)throw new Error('No actual shard request arrived: '+JSON.stringify(state));
      await page.waitForTimeout(100);
    }
    report.checks.push('real full-recording analysis reaches a pending catalog request');
    assert.equal(await page.getByTestId('cancel-analysis').isVisible(),true);
    const clicked=Date.now();
    await page.getByTestId('cancel-analysis').click();
    await page.getByTestId('sample-video').waitFor();
    await page.waitForFunction(()=>window.__MANY_FACES_RUNTIME__?.phase==='idle',null,{timeout:5000});
    report.cancelToIdleMs=Date.now()-clicked;
    assert.equal(await page.evaluate(()=>Boolean(window.__MANY_FACES_VERIFY__)),false);
    unblock();await page.waitForTimeout(750);
    const after=await page.evaluate(()=>({runtime:window.__MANY_FACES_RUNTIME__,success:Boolean(window.__MANY_FACES_VERIFY__)}));
    assert.equal(after.runtime.phase,'idle');assert.equal(after.success,false);
    report.checks.push('cancel releases the operation without a false successful result or late restart');
    assert.equal(report.pageErrors.length,0,report.pageErrors.join(';'));
    report.passed=true;
    return report;
  }catch(error){report.error=error.stack||String(error);if(page)report.failure=await page.evaluate(()=>({runtime:window.__MANY_FACES_RUNTIME__,alert:document.querySelector('[role="alert"]')?.textContent})).catch(()=>null);throw error;}
  finally{unblock?.();await browser.close();await fs.writeFile(`${out}/cancellation.json`,JSON.stringify(report,null,2));console.log('VIDEO_CANCELLATION '+JSON.stringify(report));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  await verifyVideoCancellation(process.env.VIDEO_SPEED_REPORT_DIR||'work/video-speed').catch(()=>{process.exitCode=1;});
}
