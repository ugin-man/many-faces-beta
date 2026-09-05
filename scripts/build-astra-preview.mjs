import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const esbuild = require(path.resolve('.browser-tools/node_modules/esbuild'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.env.MANY_FACES_PREVIEW_OUT || 'work/astra-preview');
await fs.mkdir(path.join(out, 'assets'), { recursive: true });
const linkShim = 'import React from "react"; export default function Link({href,children,...props}) { return <a href={href} {...props}>{children}</a>; }';
const plugin = {
  name: 'portable-preview',
  setup(build) {
    build.onResolve({ filter: /^next\/link$/ }, () => ({ path:'link', namespace:'preview' }));
    build.onLoad({ filter:/.*/, namespace:'preview' }, () => ({ contents:linkShim, loader:'jsx', resolveDir:root }));
    build.onLoad({ filter:/app\/live\/astra\/client\.tsx$/ }, async ({ path: filename }) => {
      const source = await fs.readFile(filename, 'utf8');
      const old = 'new URL("./processor.worker.ts", import.meta.url)';
      if (source.split(old).length !== 2) throw new Error('Worker entry-point contract changed');
      return { contents:source.replace(old, 'new URL("/assets/processor.worker.js", window.location.origin)'), loader:'tsx', resolveDir:path.dirname(filename) };
    });
  },
};
for (const [name, module] of [['astra','./app/live/astra/client.tsx'], ['review','./app/live/review-client-lite.tsx']]) {
  await esbuild.build({
    stdin:{ contents:`import React from 'react'; import { createRoot } from 'react-dom/client'; import View from '${module}'; createRoot(document.getElementById('root')).render(<View/>);`, resolveDir:root, sourcefile:`preview-${name}.tsx`, loader:'tsx' },
    outfile:path.join(out, `assets/${name}.js`), bundle:true, minify:true, format:'esm', platform:'browser', jsx:'automatic', plugins:[plugin], define:{'process.env.NODE_ENV':'"production"'},
  });
  const title = name === 'astra' ? 'Many Faces — Realtime Preview' : 'Many Faces — Fixed Video';
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/assets/${name}.css"><style>html,body{margin:0;background:#0b0f17;color:#edf1f8;font-family:system-ui,sans-serif}a{color:inherit}</style><div id="root"></div><script type="module" src="/assets/${name}.js"></script></html>`;
  await fs.writeFile(path.join(out, name === 'astra' ? 'index.html' : 'review.html'), html);
}
await esbuild.build({ entryPoints:['app/live/astra/processor.worker.ts'], outfile:path.join(out,'assets/processor.worker.js'), bundle:true, minify:true, platform:'browser', format:'esm', define:{'process.env.NODE_ENV':'"production"'} });
await fs.copyFile('scripts/serve-astra-preview.mjs', path.join(out,'server.mjs'));
await fs.writeFile(path.join(out,'START-WINDOWS.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (echo Node.js 22 or newer is required. & pause & exit /b 1)\r\nstart "" http://127.0.0.1:4173/live/astra\r\nnode server.mjs\r\npause\r\n');
await fs.writeFile(path.join(out,'start.sh'), '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexec node server.mjs\n');
for (const name of ['LICENSE','DATA_LICENSE.md','CATALOG.md']) await fs.copyFile(name,path.join(out,name));
await fs.writeFile(path.join(out,'README-JA.txt'), 'Many Faces リアルタイム確認用\n\nWindows: ZIPを展開し START-WINDOWS.cmd を開いてください。Node.js 22以降が必要です。\nMac/Linux: このフォルダで node server.mjs を起動し http://127.0.0.1:4173/live/astra を開いてください。\n\nカメラを開始 → 許可 → 正面 → 左右・口の動き → 停止 → 再開始。\n解析と出力は区別して表示します。静止中は出力切替0回/秒が正常です。\n入力映像は外部へ送信しません。診断JSONにも映像や顔の特徴量は含みません。\n\n同梱カタログが小型版の場合は配布容量を減らした実写真サブセットです。正式な70,000顔カタログとの差はPREVIEW-IDENTITY.jsonで確認できます。一致品質と実機の性能は別途確認してください。\n');
console.log(out);
