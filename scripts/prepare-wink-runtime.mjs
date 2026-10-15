import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),esbuild=require(path.resolve('.browser-tools/node_modules/esbuild'));
await fs.mkdir('public/__wink_runtime',{recursive:true});await fs.mkdir('work/wink-runtime',{recursive:true});
await esbuild.build({entryPoints:['scripts/wink-runtime-probe.ts'],bundle:true,format:'esm',platform:'browser',outfile:'public/__wink_runtime/probe.js'});
const pilot=JSON.parse(await fs.readFile('data/wink-pilot/catalog.json','utf8'));
const run=args=>{const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||'ffmpeg failed');};
const list=[];
for(const [i,item] of pilot.items.entries()){
 run(['-loop','1','-i',`data/wink-pilot/images/${item.image}`,'-t','1','-r','30','-vf','scale=512:512,setsar=1,format=yuv420p','-an','-c:v','libx264','-crf','12',`work/wink-runtime/part-${i}.mp4`]);
 list.push(`file 'part-${i}.mp4'`);
}
await fs.writeFile('work/wink-runtime/list.txt',list.join('\n'));
run(['-f','concat','-safe','0','-i','work/wink-runtime/list.txt','-c','copy','work/wink-runtime/heldout-winks.mp4']);
run(['-i','work/wink-runtime/heldout-winks.mp4','-t','1','-c','copy','work/wink-runtime/fallback.mp4']);
await fs.writeFile('work/wink-runtime/fixture-provenance.json',JSON.stringify({kind:'six real still photographs encoded as a test video; not human motion',ids:pilot.items.map(x=>x.id),sources:pilot.items.map(x=>x.sourceUrl),privateUserVideoUsed:false,excludeTheseSourcesFromSupplementDuringHeldoutTest:true},null,2));
