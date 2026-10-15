import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {liveCandidateFromEntry} from '../app/live-matching.ts';
import {winkEvidence} from '../app/live/wink-evidence.ts';
const require=createRequire(import.meta.url),out='work/wink-core',qa='public/__wink_core',root='public/seed-catalog';
await fs.mkdir(out,{recursive:true});
if(process.argv.includes('--prepare')){
 await fs.mkdir(qa,{recursive:true});
 const manifest=JSON.parse(await fs.readFile(`${root}/manifest.json`,'utf8')),samples=[];
 let scanned=0;
 for(const cell of Object.values(manifest.cells))for(const file of cell.shards??[cell.shard]){
  const rows=JSON.parse(await fs.readFile(`${root}/shards/${file}`,'utf8')).items;
  for(const entry of rows){
   scanned++;const candidate=liveCandidateFromEntry(entry,file);if(!candidate)continue;
   const evidence=winkEvidence(candidate.feature,candidate.geometry.projection);if(!evidence)continue;
   let bytes;if(entry.image)bytes=await fs.readFile(`${root}/images/${entry.image}`);
   else{const h=await fs.open(`${root}/packs/${entry.pack}`);try{bytes=Buffer.alloc(entry.length);await h.read(bytes,0,entry.length,entry.offset);}finally{await h.close();}}
   const name=`core-${samples.length}.webp`;await fs.writeFile(`${qa}/${name}`,bytes);
   samples.push({entry,file:name,storedSide:evidence.side,imageSha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
 assert.equal(scanned,70000);await fs.writeFile(`${qa}/samples.json`,JSON.stringify(samples));
 const esbuild=require(path.resolve('.browser-tools/node_modules/esbuild'));
 await esbuild.build({entryPoints:['scripts/wink-core-probe.ts'],bundle:true,format:'esm',platform:'browser',outfile:`${qa}/probe.js`});
 await fs.writeFile(`${qa}/index.html`,'<!doctype html><meta charset="utf-8"><script type="module">import {reanalyzeCore} from "./probe.js";window.reanalyzeCore=reanalyzeCore;</script>');
 console.log('CORE_WINK_SCREEN '+JSON.stringify({scanned,photoReanalysisCandidates:samples.length}));
}else{
 const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:4183/__wink_core/index.html');await page.waitForFunction(()=>window.reanalyzeCore);
  const result=await page.evaluate(()=>window.reanalyzeCore());
  const encode=values=>{const b=Buffer.alloc(values.length*2);for(let i=0;i<values.length;i++){assert(Number.isFinite(values[i])&&values[i]>=-8&&values[i]<=32767/4096,'Geometry would be clipped');b.writeInt16LE(Math.round(values[i]*4096),i*2);}return b.toString('base64');};
  const entries=result.accepted.map(row=>({...row.entry,supportKind:'core-refresh',feature:row.feature,shape:encode(row.geometry.structure),mesh:encode(row.geometry.surface),projection:encode(row.geometry.projection),layout:row.geometry.layout,side:row.evidence.side,evidence:row.evidence,imageSha256:row.imageSha256,validation:'Fresh CPU analysis of exact original encoded pixels; automatic eyelid/action corroboration, not independent human labels'}));
  const pilot=JSON.parse(await fs.readFile('data/wink-pilot/catalog.json','utf8'));
  const extra=pilot.items.map(entry=>({...entry,supportKind:'addition'}));
  const payload={schemaVersion:2,baseCatalogTree:'559f7f39e3a8eed452ef7eb6a3355a318235c307',originalFaces:70000,addedPhotographs:extra.length,refreshedOriginals:entries.length,validationStatus:'automatic-pilot-not-perceptual-certification',items:[...entries,...extra]};
  assert.equal(new Set(payload.items.map(e=>e.id)).size,payload.items.length);
  await fs.mkdir(`${out}/runtime/images`,{recursive:true});
  for(const entry of extra)await fs.copyFile(`data/wink-pilot/images/${entry.image}`,`${out}/runtime/images/${entry.image}`);
  await fs.writeFile(`${out}/runtime/catalog.json`,JSON.stringify(payload));
  const audit={commit:process.env.GITHUB_SHA,originalFaces:70000,screenedCandidates:result.audit.length,acceptedOriginals:entries.length,addedPhotos:extra.length,left:payload.items.filter(e=>e.side==='left').length,right:payload.items.filter(e=>e.side==='right').length,changedSide:result.audit.filter(e=>e.freshSide&&e.freshSide!==e.storedSide).length,notRefreshedAll70k:true,notYetRuntimeEnabled:true,audit:result.audit};
  await fs.writeFile(`${out}/audit.json`,JSON.stringify(audit,null,2));
  const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const html='<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Many Faces — 画像の出典</title><style>body{max-width:820px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui}article{padding:18px 0;border-bottom:1px solid #ccc;overflow-wrap:anywhere}small{display:block}</style><h1>画像の出典・利用条件</h1><p>元の7万枚は変更していません。この補助索引は既存写真の再解析結果と、追加の実写真から構成されています。追加画像は顔の切り出し・縮小・WebP変換のみで、反転や表情生成はしていません。各画像には元のライセンスが引き続き適用されます。</p><p>自動検査による試験的な索引です。画像の著作権ライセンスは、人物のあらゆる用途への同意を保証するものではありません。</p>'+payload.items.map(e=>`<article id="${escape(e.id)}"><strong>${escape(e.id)}</strong><p>${escape(e.creator)} — <a href="${escape(e.sourceUrl)}" rel="noopener noreferrer">元画像・出典</a></p><p><a href="${escape(e.licenseUrl||e.sourceUrl)}" rel="noopener noreferrer">${escape(e.license)}</a></p><small>${escape(e.changes||'既存の顔画像は変更せず、照合用の特徴量のみ再解析。')}</small></article>`).join('')+'</html>';
  await fs.writeFile(`${out}/runtime/ATTRIBUTION.html`,html);
  console.log('CORE_WINK_REFRESH '+JSON.stringify({...audit,audit:undefined}));
 }finally{await browser.close();}
}
