import fs from 'node:fs/promises';
const root='public/seed-catalog',overlayPath='public/catalog-quality/v1/exclusions.json';
const manifest=JSON.parse(await fs.readFile(root+'/manifest.json','utf8')),overlay=JSON.parse(await fs.readFile(overlayPath,'utf8')),excluded=new Set((overlay.excluded??[]).map(x=>x.id));
const cells={},missing=new Set(excluded),reasons={};
for(const item of overlay.excluded??[])reasons[item.reason]=(reasons[item.reason]??0)+1;
for(const [key,cell] of Object.entries(manifest.cells)){let total=0,remaining=0;for(const file of cell.shards??[cell.shard]){const rows=JSON.parse(await fs.readFile(root+'/shards/'+file,'utf8')).items;for(const e of rows){total++;if(excluded.has(e.id))missing.delete(e.id);else remaining++;}}cells[key]={total,remaining,removed:total-remaining};}
if(missing.size)throw new Error('Overlay contains unknown ids: '+[...missing].slice(0,20).join(', '));
const empty=Object.entries(cells).filter(([,x])=>x.remaining===0),thin=Object.entries(cells).filter(([,x])=>x.remaining<8);
if(empty.length)throw new Error('Quality exclusions emptied pose cells: '+empty.map(x=>x[0]).join(', '));
const report={catalogFaces:manifest.totalFaces,excluded:excluded.size,reasons,emptyCells:empty.length,cellsBelow8:thin.length,minimumRemaining:Math.min(...Object.values(cells).map(x=>x.remaining)),affectedCells:Object.values(cells).filter(x=>x.removed).length};
console.log('QUALITY_OVERLAY '+JSON.stringify(report));
