import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const dir='public/__motion_qa',out='work/demo-evidence';
if(process.argv.includes('--prepare')){
 await fs.mkdir(dir,{recursive:true});
 const root='public/seed-catalog';const manifest=JSON.parse(await fs.readFile(root+'/manifest.json','utf8'));
 const key=Object.keys(manifest.cells).sort((a,b)=>a.split(':').reduce((s,v)=>s+Number(v)**2,0)-b.split(':').reduce((s,v)=>s+Number(v)**2,0))[0];
 const cell=manifest.cells[key],shard=JSON.parse(await fs.readFile(root+'/shards/'+(cell.shards?.[0]||cell.shard),'utf8'));
 const items=shard.items.slice(0,3);
 for(let i=0;i<items.length;i++){
  const item=items[i];let bytes;
  if(item.image)bytes=await fs.readFile(root+'/images/'+item.image);
  else {const file=await fs.open(root+'/packs/'+item.pack);try{bytes=Buffer.alloc(item.length);await file.read(bytes,0,item.length,item.offset);}finally{await file.close();}}
  await fs.writeFile(`${dir}/photo-${i}.webp`,bytes);
 }
 await fs.writeFile(`${dir}/cases.json`,JSON.stringify(items.map(x=>({id:x.id,feature:x.feature,geometry:{layout:x.layout,structure:x.shape,surface:x.mesh,projection:x.projection}}))));
 const code=`
import {FaceLandmarker,FilesetResolver} from '@mediapipe/tasks-vision';
import {faceGeometryFromLandmarks} from './app/offline-matching.ts';
import {catalogFeatureFromResult} from './app/catalog-feature.ts';
import {screenRoll,shortestAngle} from './app/live/video-motion.ts';
import {drawDemoFaceComposite} from './app/demo-face-composite.ts';
window.runMotionAudit=async()=>{
 const engine=await FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(location.origin+'/api/mediapipe'),{baseOptions:{modelAssetPath:location.origin+'/api/mediapipe/face_landmarker.task',delegate:'CPU'},runningMode:'IMAGE',numFaces:1,outputFaceBlendshapes:true,outputFacialTransformationMatrixes:true});
 const cases=await(await fetch('/__motion_qa/cases.json')).json(),rows=[];
 const sheet=document.createElement('canvas');sheet.width=1280;sheet.height=768;const sctx=sheet.getContext('2d');
 try{for(let n=0;n<cases.length;n++){
  const image=new Image();image.src='/__motion_qa/photo-'+n+'.webp';await image.decode();
  const original=engine.detect(image);const originalGeometry=faceGeometryFromLandmarks(original.faceLandmarks[0],image.width/image.height);
  if(!originalGeometry)throw Error('Public source face not detected');
  for(const [j,degrees] of [-45,-25,0,25,45].entries()){
   const input=document.createElement('canvas');input.width=input.height=512;const ctx=input.getContext('2d');
   ctx.fillStyle='#506070';ctx.fillRect(0,0,512,512);ctx.translate(256,256);ctx.rotate(degrees*Math.PI/180);ctx.drawImage(image,-170,-170,340,340);
   const detection=engine.detect(input),points=detection.faceLandmarks[0];
   if(!points){rows.push({photo:n,degrees,detected:false});continue;}
   const geometry=faceGeometryFromLandmarks(points),feature=catalogFeatureFromResult(detection);
   const expected=degrees*Math.PI/180+originalGeometry.roll;
   const measured=screenRoll(geometry,feature);
   const candidate=cases[n];
   const result=document.createElement('canvas');result.width=result.height=512;
   const rc=result.getContext('2d'),rotations=[],rotate=rc.rotate.bind(rc);rc.rotate=a=>{rotations.push(a);rotate(a);};
   Object.assign(input,{videoWidth:512,videoHeight:512,currentTime:0,readyState:4,seeking:false});
   const safe=drawDemoFaceComposite(result,input,image,{frame:{time:0,geometry,feature},candidate},{time:0,fps:30,sourceAspectRatio:1});
   rows.push({photo:n,degrees,detected:true,safe,measured:measured*180/Math.PI,eyeError:Math.abs(shortestAngle(measured-expected))*180/Math.PI,catalogRollError:Math.abs(shortestAngle(screenRoll(candidate.geometry,candidate.feature)-originalGeometry.roll))*180/Math.PI,matrixRollError:Math.abs(shortestAngle(screenRoll({...geometry,roll:undefined},feature)-measured))*180/Math.PI,rotation:rotations[0]||0,expectedRotation:shortestAngle(measured-screenRoll(candidate.geometry,candidate.feature))});
   sctx.drawImage(result,j*256,n*256,256,256);
  }
 }}finally{engine.close();}
 return {rows,sheet:sheet.toDataURL('image/png')};
};`;
 const {build}=require('esbuild');
 await build({stdin:{contents:code,loader:'ts',resolveDir:process.cwd(),sourcefile:'motion-audit.ts'},outfile:dir+'/probe.js',bundle:true,format:'esm',platform:'browser'});
 process.exit(0);
}
const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});
 await page.addScriptTag({url:'http://127.0.0.1:4173/__motion_qa/probe.js',type:'module'});
 await page.waitForFunction(()=>typeof window.runMotionAudit==='function');
 const report=await page.evaluate(()=>window.runMotionAudit());
 await fs.mkdir(out,{recursive:true});await fs.writeFile(out+'/motion-rotations.png',Buffer.from(report.sheet.split(',')[1],'base64'));
 delete report.sheet;
 const detected=report.rows.filter(x=>x.detected);
 report.passed=detected.length===15&&detected.every(x=>x.safe&&x.eyeError<10&&x.catalogRollError<10&&x.matrixRollError<10&&Math.abs(x.rotation-x.expectedRotation)<1e-6);
 await fs.writeFile(out+'/motion-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(!report.passed)throw Error('Public-photo rotation audit failed');
}finally{await browser.close();}
