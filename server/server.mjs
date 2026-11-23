// Motivati-scroll home server: serves the built app, the media library API, and the media files
// from one origin. Node built-ins only.
//
// Env: PORT (5183), DATA_DIR (<repo>/media-library; /data in Docker), STATIC_DIR (<repo>/dist)
import http from 'node:http';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library, MEDIA_TYPES, cleanName, kindOf, mediaExt, parseRange } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5183);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(here, '..', 'media-library'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? path.join(here, '..', 'dist'));

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const lib = await new Library(DATA_DIR).init();

const toClient = (item) => ({
  id: item.id,
  name: item.name,
  kind: item.kind,
  size: item.size,
  addedAt: item.addedAt,
  url: `/media/${item.file}`,
});

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

async function upload(req, res, url) {
  const name = cleanName(url.searchParams.get('name'));
  const ext = mediaExt(name);
  if (!ext) return sendJson(res, 415, { error: `Unsupported file type. Allowed: ${Object.keys(MEDIA_TYPES).join(', ')}` });
  const id = lib.newId();
  const file = `${id}.${ext}`;
  const dest = path.join(lib.mediaDir, file);
  const tmp = `${dest}.part`;
  try {
    // Stream straight to disk so large phone videos never sit in memory.
    await pipeline(req, createWriteStream(tmp));
    const { size } = await fs.stat(tmp);
    if (size === 0) throw Object.assign(new Error('Empty upload'), { status: 400 });
    const item = await lib.mutate(async (items) => {
      const dup = items.find((i) => i.name === name && i.size === size);
      if (dup) return { dup };
      await fs.rename(tmp, dest);
      const it = { id, name, kind: kindOf(ext), size, addedAt: Date.now(), file };
      items.push(it);
      return { it };
    });
    if (item.dup) {
      await fs.rm(tmp, { force: true });
      return sendJson(res, 409, { error: 'Already in the library', item: toClient(item.dup) });
    }
    console.log(`added ${name} (${size} bytes)`);
    sendJson(res, 201, toClient(item.it));
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.status ? e.message : 'Upload failed' });
    if (!e.status) console.error('upload failed', e);
  }
}

async function remove(res, id) {
  const removed = await lib.mutate(async (items) => {
    const i = items.findIndex((x) => x.id === id);
    return i < 0 ? undefined : items.splice(i, 1)[0];
  });
  if (!removed) return sendJson(res, 404, { error: 'Not found' });
  await fs.rm(lib.fileFor(removed), { force: true });
  console.log(`removed ${removed.name}`);
  res.writeHead(204).end();
}

/** Stream a file, honoring Range requests (iOS Safari will not play video without them). */
async function sendFile(req, res, filePath, type, cache) {
  let st;
  try {
    st = await fs.stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return false;
  }
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'Last-Modified': st.mtime.toUTCString() };
  const range = parseRange(req.headers.range, st.size);
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
    return true;
  }
  const { start, end } = range ?? { start: 0, end: st.size - 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || st.size === 0) return void res.end() ?? true;
  await pipeline(createReadStream(filePath, { start, end }), res).catch(() => {});
  return true;
}

async function serveMedia(req, res, file) {
  const ext = mediaExt(file);
  // Only serve names that match an indexed item, so nothing else in the data dir is reachable.
  const item = ext && lib.list().find((i) => i.file === file);
  if (!item || !(await sendFile(req, res, lib.fileFor(item), MEDIA_TYPES[ext], 'public, max-age=31536000, immutable'))) {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function serveStatic(req, res, pathname) {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const filePath = path.join(STATIC_DIR, rel);
  if (!filePath.startsWith(STATIC_DIR)) return sendJson(res, 400, { error: 'Bad path' });
  const ext = path.extname(filePath);
  // index.html and the service worker must revalidate so updates show up; hashed assets can be cached.
  const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (rel && (await sendFile(req, res, filePath, STATIC_TYPES[ext] ?? 'application/octet-stream', cache))) return;
  // SPA fallback
  if (!(await sendFile(req, res, path.join(STATIC_DIR, 'index.html'), STATIC_TYPES['.html'], 'no-cache'))) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('App not built. Run `npm run build`.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p === '/api/library' && req.method === 'GET') return sendJson(res, 200, lib.list().map(toClient));
    if (p === '/api/media' && req.method === 'POST') return await upload(req, res, url);
    const del = /^\/api\/media\/([\w-]+)$/.exec(p);
    if (del && req.method === 'DELETE') return await remove(res, del[1]);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    const media = /^\/media\/([\w-]+\.[a-z0-9]+)$/i.exec(p);
    if (media) return await serveMedia(req, res, media[1]);
    if (p.startsWith('/media/')) return sendJson(res, 404, { error: 'Not found' });
    await serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.destroy();
  }
});

// Uploads of big videos over Wi-Fi can take a while; don't cut them off.
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`Motivati-scroll on http://0.0.0.0:${PORT} (data: ${DATA_DIR}, app: ${STATIC_DIR})`));
