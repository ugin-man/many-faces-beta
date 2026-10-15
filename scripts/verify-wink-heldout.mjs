import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),out='work/wink-heldout';
if(process.argv.includes('--prepare')){
 const esbuild=require(path.resolve('.browser-tools/node_modules/esbuild'));
 await esbuild.build({entryPoints:['scripts/wink-heldout-probe.ts'],bundle:true,format:'esm',platform:'browser',outfile:'public/__wink_eval/probe.js'});
 await fs.writeFile('public/__wink_eval/index.html','<!doctype html><meta charset="utf-8"><script type="module">import {checkWinkWinners} from "./probe.js"; window.examine=checkWinkWinners;</script>');
}else{
 const {chromium}=require(path.resolve('.browser-tools/node_modules/playwright'));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:4183/__wink_eval/index.html');await page.waitForFunction(()=>window.examine);
  const result=await page.evaluate(()=>window.examine());
  result.comparison=result.cases.map(row=>({source:row.sourceId,expected:row.expectedSide,sourceFresh:result.fresh[row.sourceId]?.evidence??null,beforeFresh:result.fresh[row.before.id]?.evidence??null,afterFresh:result.fresh[row.after.id]?.evidence??null,beforeId:row.before.id,afterId:row.after.id}));
  result.beforeFreshSameSide=result.comparison.filter(x=>x.beforeFresh?.side===x.expected).length;
  result.afterFreshSameSide=result.comparison.filter(x=>x.afterFresh?.side===x.expected).length;
  result.independentHumanLabels=false;result.physicalCameraVerified=false;
  await fs.writeFile(`${out}/fresh-winners.json`,JSON.stringify(result,null,2));
  console.log('WINK_FRESH_WINNERS '+JSON.stringify({comparison:result.comparison,beforeFreshSameSide:result.beforeFreshSameSide,afterFreshSameSide:result.afterFreshSameSide,independentHumanLabels:false}));
 }finally{await browser.close();}
}
