import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.env.MANY_FACES_PREVIEW_ROOT || path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.wasm':'application/wasm', '.task':'application/octet-stream', '.webp':'image/webp', '.png':'image/png', '.mp4':'video/mp4', '.bin':'application/octet-stream' };
function filename(value) {
  if (!value || path.basename(value) !== value || value.includes('\\') || value.includes('\0') || value === '.' || value === '..') throw new Error('Invalid file name');
  return value;
}
function within(relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid path');
  return resolved;
}
async function sendFile(response, relative) {
  const file = within(relative);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Not a file');
  response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': info.size, 'cache-control': relative.endsWith('manifest.json') ? 'no-cache' : 'public, max-age=3600' });
  createReadStream(file).on('error', () => response.destroy()).pipe(response);
}
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/catalog/manifest') return await sendFile(response, 'public/seed-catalog/manifest.json');
    if (url.pathname === '/api/catalog/shard') return await sendFile(response, `public/seed-catalog/shards/${filename(url.searchParams.get('file'))}`);
    if (url.pathname === '/api/catalog/image') {
      if (url.searchParams.has('id')) return await sendFile(response, `public/seed-catalog/images/${filename(url.searchParams.get('id'))}`);
      const pack = filename(url.searchParams.get('pack'));
      const offset = Number(url.searchParams.get('offset'));
      const length = Number(url.searchParams.get('length'));
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 4 * 1024 * 1024) throw new Error('Invalid image range');
      const handle = await open(within(`public/seed-catalog/packs/${pack}`), 'r');
      try {
        const info = await handle.stat();
        if (offset + length > info.size) throw new Error('Image range exceeds pack');
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) throw new Error('Truncated image range');
        response.writeHead(200, { 'content-type':'image/webp', 'content-length':length, 'cache-control':'public, max-age=3600' });
        response.end(buffer);
      } finally { await handle.close(); }
      return;
    }
    if (url.pathname === '/api/mediapipe/face_landmarker.task') return await sendFile(response, 'public/models/face_landmarker.task');
    if (url.pathname.startsWith('/api/mediapipe/')) return await sendFile(response, `public/mediapipe/wasm/${filename(url.pathname.split('/').pop())}`);
    if (url.pathname === '/' || url.pathname === '/live/astra') return await sendFile(response, 'index.html');
    if (url.pathname === '/live') return await sendFile(response, 'review.html');
    if (url.pathname.startsWith('/assets/')) return await sendFile(response, url.pathname.slice(1));
    if (url.pathname.startsWith('/seed-catalog/')) return await sendFile(response, `public${url.pathname}`);
    response.writeHead(404).end('Not found');
  } catch {
    if (!response.headersSent) response.writeHead(404, { 'content-type':'text/plain; charset=utf-8' });
    response.end('Requested asset or range is not available');
  }
});
// Local only: do not expose a user's preview or local filesystem to the LAN.
server.listen(port, '127.0.0.1', () => console.log(`Many Faces: http://127.0.0.1:${port}/live/astra`));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
