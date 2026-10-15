import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const require=createRequire(import.meta.url);
const {chromium}=require(path.resolve(".browser-tools/node_modules/playwright"));
const output=path.resolve("work/processed-sample"), frames=path.resolve("work/composite-frames");
await fs.mkdir(output,{recursive:true});await fs.mkdir(frames,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader"]});
try{
 const page=await browser.newPage({viewport:{width:1024,height:850}});page.setDefaultTimeout(30000);
 await page.goto("http://127.0.0.1:4173/",{waitUntil:"domcontentloaded"});
 await page.getByTestId("settings").click();
 await page.getByTestId("analysis-fps").selectOption("30");
 await page.getByRole("button",{name:"閉じる"}).click();
 await page.getByTestId("video-input").setInputFiles(path.resolve(process.env.SAMPLE_SOURCE||"public/test-fixtures/reference-face-motion.mp4"));
 await page.getByTestId("demo-save-image").waitFor({timeout:900000});
 const verification=await page.evaluate(()=>window.__MANY_FACES_VERIFY__);
 assert.ok(verification.passed,verification.reasons.join("; "));
 const metadata=await page.getByTestId("input-video").evaluate(video=>({duration:video.duration,width:video.videoWidth,height:video.videoHeight}));
 const count=Math.round(metadata.duration*30);
 assert.equal(verification.plannedFrames,Math.floor(metadata.duration*30));
 for(let index=0;index<count;index++){
  const png=await page.evaluate(async({index})=>{
   const video=document.querySelector('[data-testid="input-video"]');video.pause();
   const target=index/30;
   if(Math.abs(video.currentTime-target)>.0001){
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{video.removeEventListener('seeked',done);reject(new Error('Frame seek timed out'));},10000);const done=()=>{clearTimeout(timer);resolve();};video.addEventListener('seeked',done,{once:true});video.currentTime=target;});
   }
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   return document.querySelector('[data-testid="output-canvas"]').toDataURL('image/png').split(',')[1];
  },{index});
  await fs.writeFile(path.join(frames,`${String(index).padStart(4,'0')}.png`),Buffer.from(png,'base64'));
  if(index%90===0)console.log(`Protected composite ${index}/${count}`);
 }
 const videoFile=path.join(output,'many-faces-sample-30fps.mp4');
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-framerate','30','-i',path.join(frames,'%04d.png'),'-an','-c:v','libx264','-preset','slow','-crf','23','-pix_fmt','yuv420p','-r','30','-movflags','+faststart',videoFile],{timeout:180000});
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',path.join(frames,'0000.png'),'-c:v','libwebp','-quality','84',path.join(output,'poster.webp')]);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration','-of','json',videoFile],{encoding:'utf8'}));
 const stream=probe.streams[0];assert.equal(stream.avg_frame_rate,'30/1');assert.equal(Number(stream.nb_frames),count);assert.equal(probe.streams.length,1);
 const bytes=await fs.readFile(videoFile);
 const manifest={schemaVersion:1,kind:'protected-composite',fps:30,frames:count,durationSeconds:count/30,width:768,height:768,audio:false,sourceVideoIncluded:false,sourceFacePixelsIncluded:false,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,renderCommit:process.env.GITHUB_SHA,analysisFps:30,protectedIntervals:verification.poseContinuity?.intervals||[],catalogFaces:70000};
 await fs.writeFile(path.join(output,'sample.json'),JSON.stringify(manifest,null,2)+'\n');
 // Only protected composite frames leave the runner. Never upload the raw input,
 // its landmarks, detector screenshots, or the complete checkout.
 for(let sheet=0;sheet<Math.ceil(count/63);sheet++)execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-start_number',String(sheet*63),'-framerate','30','-i',path.join(frames,'%04d.png'),'-vf','scale=128:128,tile=9x7','-frames:v','1',path.join(output,`review-${String(sheet).padStart(2,'0')}.jpg`)]);
 console.log('PROTECTED_SAMPLE_READY',JSON.stringify(manifest));
}finally{await browser.close();}
