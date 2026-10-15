import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const output='work/demo-evidence';await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
const page=await browser.newPage({acceptDownloads:true,viewport:{width:390,height:844}});
const errors=[],requests=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>requests.push(r.url()));
const meta=JSON.parse(await fs.readFile('public/demo/sample.json','utf8'));
const waitReady=()=>page.waitForFunction(()=>document.querySelector('[data-testid="processed-sample-video"]')?.readyState>=2);
const controlsFit=async(width,height)=>{
 for(const b of await page.locator('[data-testid="mode-camera"], [data-testid="mode-video"], [aria-label="操作"] button').all()){
  const box=await b.boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,`${await b.textContent()} clipped at ${width}x${height}`);
 }
};
const seek=async(time)=>{
 await page.getByTestId('sample-seek').evaluate((element,value)=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,String(value));
  element.dispatchEvent(new Event('input',{bubbles:true}));
  element.dispatchEvent(new Event('change',{bubbles:true}));
 },time);
 await page.waitForFunction(t=>{const v=document.querySelector('[data-testid="processed-sample-video"]');return v&&!v.seeking&&Math.abs(v.currentTime-t)<.005;},time);
};
try{
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});
 assert.match(await page.getByTestId('mode-camera').textContent(),/リアルタイム（デモ）/);
 const button=await page.getByTestId('sample-video').boundingBox();assert.ok(button.x>250&&button.width<125&&button.y<100);
 await page.screenshot({path:`${output}/home-phone.png`});
 await page.getByTestId('sample-video').click();await waitReady();
 assert.equal(await page.getByTestId('source-pip').getAttribute('data-visible'),'false');
 const vm=await page.getByTestId('processed-sample-video').evaluate(v=>({src:new URL(v.currentSrc).pathname,duration:v.duration,width:v.videoWidth,height:v.videoHeight}));
 assert.equal(vm.src,'/demo/many-faces-sample-30fps.mp4');assert.ok(Math.abs(vm.duration-23.3)<.01);assert.equal(vm.width,768);assert.equal(vm.height,768);
 await page.getByTestId('sample-play-pause').click();await page.waitForFunction(()=>document.querySelector('[data-testid="processed-sample-video"]').currentTime>.2);
 await page.getByTestId('sample-play-pause').click();await seek(5);
 await page.getByRole('button',{name:'1フレーム進む',exact:true}).click();
 assert.ok(Math.abs(await page.getByTestId('processed-sample-video').evaluate(v=>v.currentTime)-(5+1/30))<.001);
 await page.getByRole('button',{name:'1フレーム戻る',exact:true}).click();await seek(5);
 for(const [id,name] of [['sample-save-image','many-faces-sample.png'],['sample-save-video','many-faces-sample-30fps.mp4']]){
  const downloaded=page.waitForEvent('download');await page.getByTestId(id).click();const d=await downloaded;assert.equal(d.suggestedFilename(),name);await d.saveAs(`${output}/${name}`);
 }
 const saved=await fs.readFile(`${output}/many-faces-sample-30fps.mp4`);assert.equal(createHash('sha256').update(saved).digest('hex'),meta.sha256);
 for(const [width,height] of [[390,844],[320,568],[844,390],[1280,850]]){
  await page.setViewportSize({width,height});await controlsFit(width,height);
  if(width===390)await page.screenshot({path:`${output}/sample-phone.png`});
 }
 assert.equal(requests.filter(u=>/mediapipe|face_landmarker|\.wasm|processor\.worker|review-search\.worker/.test(u)).length,0,'Sample navigation must not start inference or download the model');
 await page.getByTestId('back').click();await page.getByTestId('sample-video').waitFor();
 await page.goto('http://127.0.0.1:4173/demo',{waitUntil:'networkidle'});await waitReady();
 for(const p of ['/test-fixtures/reference-face-motion.mp4','/test-fixtures/reference-face-motion-analysis.json','/test-fixtures/reference-face-motion-rankings.json']){const r=await page.request.get('http://127.0.0.1:4173'+p);assert.ok([404,410].includes(r.status()),`${p} must not be distributed`);}
 // Exercise the real upload pipeline with an already-protected, short input.
 await page.getByTestId('back').click();await page.getByTestId('video-input').setInputFiles(path.resolve('work/public-test-input.mp4'));
 await page.getByTestId('demo-save-image').waitFor({timeout:900000});
 const verification=await page.evaluate(()=>window.__MANY_FACES_VERIFY__);assert.ok(verification.passed,verification.reasons.join('; '));
 assert.equal(await page.getByTestId('source-pip').getAttribute('data-visible'),'false');
 const image=page.waitForEvent('download');await page.getByTestId('demo-save-image').click();await(await image).saveAs(`${output}/upload-composite.png`);
 const video=page.waitForEvent('download',{timeout:30000});await page.getByTestId('demo-export-video').click();const d=await video;assert.match(d.suggestedFilename(),/^many-faces-composite\.(mp4|webm)$/);await d.saveAs(`${output}/${d.suggestedFilename()}`);
 await page.setViewportSize({width:390,height:844});await controlsFit(390,844);
 await page.getByTestId('mode-camera').click();await page.getByTestId('mode-camera').waitFor();assert.equal(await page.getByTestId('mode-camera').getAttribute('aria-pressed'),'true');
 await page.getByTestId('mode-video').click();await page.getByTestId('video-input').waitFor({state:'attached'});
 assert.equal(errors.length,0,errors.join('\n'));
 await fs.writeFile(`${output}/report.json`,JSON.stringify({passed:true,sample:vm,sampleHash:meta.sha256,sampleUsesInference:false,phoneAndLandscapeControls:true,retiredAssetsUnavailable:true,userUploadPassed:verification.passed,cameraModeNavigation:true,pageErrors:errors},null,2));
 console.log('PRODUCT_QA_PASS');
 }catch(error){
 await page.screenshot({path:`${output}/failure.png`}).catch(()=>{});
 const state=await page.evaluate(()=>{const v=document.querySelector('[data-testid="processed-sample-video"]');const r=document.querySelector('[data-testid="sample-seek"]');return {video:v?{time:v.currentTime,ready:v.readyState,seeking:v.seeking,error:v.error?.message}:null,range:r?{value:r.value,disabled:r.disabled}:null,body:document.body.innerText};}).catch(()=>null);
 console.log('QA_FAILURE_STATE',JSON.stringify(state));throw error;
}finally{await browser.close();}
