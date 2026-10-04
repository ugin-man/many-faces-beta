import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const esbuild=require(path.resolve('.browser-tools/node_modules/esbuild'));
if(process.argv.includes('--prepare')){
 await esbuild.build({entryPoints:['scripts/wink-probe-entry.ts'],bundle:true,format:'esm',platform:'browser',outfile:'public/__wink_qa/probe.js'});
 await fs.writeFile('public/__wink_qa/index.html','<!doctype html><meta charset="utf-8"><script type="module">import {examine} from "./probe.js"; window.examine=examine;</script>');
}else{
 const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:4183/__wink_qa/index.html');await page.waitForFunction(()=>window.examine);
  const results=await page.evaluate(()=>window.examine());
  const dest='work/wink-coverage/staged-supplement';await fs.mkdir(dest+'/images',{recursive:true});
  const entries=[];
  for(const row of results.candidates){
   if(row.rejected||!row.imageData)continue;
   const bytes=Buffer.from(row.imageData.split(',')[1],'base64'),sha=createHash('sha256').update(bytes).digest('hex'),id='wink-extra-'+sha.slice(0,24);
   const encode=values=>{const buffer=Buffer.alloc(values.length*2);values.forEach((v,i)=>buffer.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v*4096))),i*2));return buffer.toString('base64');};
   const g=row.fresh.geometry;
   await fs.writeFile(`${dest}/images/${id}.webp`,bytes);
   entries.push({id,name:'Wink supplement '+(entries.length+1),image:`${id}.webp`,feature:row.fresh.feature,shape:encode(g.structure),mesh:encode(g.surface),projection:encode(g.projection),layout:g.layout,...row.source,side:row.fresh.side,imageSha256:sha,crop:row.crop,validation:'fresh-model-plus-eyelid-geometry; visual approval still required'});
  }
  const summary={rechecked:results.rechecked,candidates:results.candidates.map(row=>({...row,imageData:undefined,fresh:row.fresh&&{side:row.fresh.side,left:row.fresh.left,right:row.fresh.right,eye:row.fresh.eye,yaw:row.fresh.feature[0]*90,pitch:row.fresh.feature[1]*90}})),stagedCount:entries.length,left:entries.filter(x=>x.side==='left').length,right:entries.filter(x=>x.side==='right').length,notYetEnabled:true};
  await fs.writeFile('work/wink-coverage/reanalysis.json',JSON.stringify(summary,null,2));
  await fs.writeFile(`${dest}/catalog.json`,JSON.stringify({schemaVersion:1,baseCatalogTree:'559f7f39e3a8eed452ef7eb6a3355a318235c307',items:entries},null,2));
  console.log('WINK_REANALYSIS '+JSON.stringify(summary));
 }finally{await browser.close();}
}
