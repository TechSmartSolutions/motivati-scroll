// Motivati-scroll home server: serves the built app, the media library API, and the media files
// from one origin. Node built-ins only.
//
// Env: PORT (5183), DATA_DIR (<repo>/media-library; /data in Docker), STATIC_DIR (<repo>/dist)
import http from 'node:http';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Downloader } from './downloader.mjs';
import { extractUrls } from './downloader-lib.mjs';
import { repairLibrary } from './repair.mjs';
import { Transcriber } from './transcriber.mjs';
import { Suggester } from './suggester.mjs';
import { Goals } from './goals.mjs';
import { cleanTags, parseTagList } from './tags.mjs';
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
const downloader = await new Downloader(lib, { bin: process.env.YTDLP_BIN ?? 'yt-dlp' }).init();
// Facebook changes often and yt-dlp breaks with it, so refresh it on every start (best effort, in the background).
if (process.env.YTDLP_AUTO_UPDATE !== '0') {
  downloader.update().then((r) => console.log(`yt-dlp ${r.after ?? 'not found'}${r.updated ? ` (updated from ${r.before})` : ''}`));
}

// Convert downloaded videos that iPhone cannot play (one at a time, in the background).
let repairing;
const startRepair = () => (repairing ??= repairLibrary(lib).finally(() => (repairing = undefined)));
if (process.env.AUTO_REPAIR !== '0') startRepair().catch((e) => console.error('repair failed', e));

// Transcribe every video in the background with a local Whisper model (WHISPER=0 turns it off).
// Env: WHISPER_MODEL (small), WHISPER_THREADS (6), PYTHON_BIN (python3; /opt/whisper/bin/python in Docker).
const transcriber = await new Transcriber(lib, {
  enabled: process.env.WHISPER !== '0',
  python: process.env.PYTHON_BIN ?? 'python3',
  script: path.join(here, 'transcribe.py'),
  model: process.env.WHISPER_MODEL ?? 'small',
  threads: Number(process.env.WHISPER_THREADS ?? 6),
}).init();
transcriber.kick();

const goals = await new Goals(DATA_DIR).init();

// Claude drafts SUGGESTED challenges from finished transcripts. Off unless ANTHROPIC_API_KEY is set.
// Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (claude-opus-5-5; e.g. claude-haiku-5-5 is much cheaper).
const suggester = await new Suggester(lib, transcriber, {
  goals,
  apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  model: process.env.ANTHROPIC_MODEL?.trim() || undefined,
}).init();
const orphans = await suggester.dropOrphans();
if (orphans) console.log(`hid ${orphans} card${orphans > 1 ? 's' : ''} whose video was deleted`);
console.log(suggester.enabled ? `Claude suggestions on (${suggester.model})` : 'Claude suggestions off (no ANTHROPIC_API_KEY)');

// Cheap in-memory scan: picks up new uploads/downloads and videos the repair step has finished with.
setInterval(() => {
  transcriber.kick();
  suggester.kick();
}, 30_000).unref();
suggester.kick();

const goalIds = () => goals.get().goals.map((g) => g.id);

const toClient = (item) => ({
  id: item.id,
  name: item.name,
  kind: item.kind,
  size: item.size,
  addedAt: item.addedAt,
  url: `/media/${item.file}`,
  favorite: !!item.favorite,
  tags: cleanTags(item.tags, goalIds()),
  ...(item.kind === 'video' ? { transcript: item.transcript ?? 'pending' } : {}),
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
      const tags = cleanTags(parseTagList(url.searchParams.get('tags')), goalIds());
      if (tags.length) it.tags = tags;
      items.push(it);
      return { it };
    });
    if (item.dup) {
      await fs.rm(tmp, { force: true });
      return sendJson(res, 409, { error: 'Already in the library', item: toClient(item.dup) });
    }
    console.log(`added ${name} (${size} bytes)`);
    sendJson(res, 201, toClient(item.it));
    transcriber.kick();
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.status ? e.message : 'Upload failed' });
    if (!e.status) console.error('upload failed', e);
  }
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Bad JSON'), { status: 400 });
  }
}

async function remove(res, id) {
  const removed = await lib.mutate(async (items) => {
    const i = items.findIndex((x) => x.id === id);
    return i < 0 ? undefined : items.splice(i, 1)[0];
  });
  if (!removed) return sendJson(res, 404, { error: 'Not found' });
  await fs.rm(lib.fileFor(removed), { force: true });
  await transcriber.remove(removed.id);
  const cards = await suggester.dropVideo(removed.id); // its challenge cards go with it
  console.log(`removed ${removed.name}${cards ? ` and ${cards} card${cards > 1 ? 's' : ''}` : ''}`);
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
    if (p === '/api/downloads' && req.method === 'GET') return sendJson(res, 200, downloader.list());
    if (p === '/api/downloads' && req.method === 'POST') {
      const body = await readJson(req);
      // Accepts { urls: [...] } (any source) or { text } (pasted text with one or more links).
      const urls = Array.isArray(body.urls) ? body.urls.map(String).slice(0, 25) : extractUrls(body.text).slice(0, 25);
      if (!urls.length) return sendJson(res, 400, { error: 'Paste a Facebook reel link.' });
      return sendJson(res, 202, downloader.enqueue(urls));
    }
    if (p === '/api/transcriber' && req.method === 'GET') return sendJson(res, 200, transcriber.status());
    if (p === '/api/goals' && req.method === 'GET') return sendJson(res, 200, goals.get());
    if (p === '/api/goals' && req.method === 'PUT') {
      const saved = await goals.set(await readJson(req));
      // A goal that was removed must not linger as a tag on videos.
      const keep = new Set(saved.goals.map((g) => g.id));
      await lib.mutate(async (items) => {
        for (const it of items) {
          if (!it.tags) continue;
          const left = it.tags.filter((t) => keep.has(t));
          if (left.length === it.tags.length) continue;
          if (left.length) it.tags = left; else delete it.tags;
        }
      });
      return sendJson(res, 200, saved);
    }
    if (p === '/api/suggestions' && req.method === 'GET') return sendJson(res, 200, { status: suggester.status(), items: suggester.list('new') });
    if (p === '/api/challenges' && req.method === 'GET') return sendJson(res, 200, suggester.accepted());
    if (p === '/api/challenges/regenerate' && req.method === 'POST') {
      try {
        return sendJson(res, 200, await suggester.regenerate((await readJson(req)).ids));
      } catch (e) {
        if (e.status) return sendJson(res, e.status, { error: e.message });
        console.error('regenerate failed', e);
        return sendJson(res, 502, { error: `Claude call failed: ${e.message}` });
      }
    }
    const sg = /^\/api\/suggestions\/([\w-]+)\/(accept|dismiss)$/.exec(p);
    if (sg && req.method === 'POST') {
      const ok = await suggester[sg[2]](sg[1]);
      return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });
    }
    const tr = /^\/api\/transcripts\/([\w-]+)$/.exec(p);
    if (tr && req.method === 'GET') {
      const t = await transcriber.read(tr[1]);
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: 'No transcript yet' });
    }
    if (p === '/api/downloader' && req.method === 'GET') return sendJson(res, 200, { version: await downloader.version() });
    if (p === '/api/downloader/update' && req.method === 'POST') return sendJson(res, 200, await downloader.update());
    if (p === '/api/library/repair' && req.method === 'POST') {
      const wasRunning = !!repairing;
      startRepair().catch((e) => console.error('repair failed', e));
      return sendJson(res, 202, { started: !wasRunning });
    }
    const fav = /^\/api\/media\/([\w-]+)\/favorite$/.exec(p);
    if (fav && req.method === 'PUT') {
      const body = await readJson(req);
      const favorite = body.favorite === true;
      const found = await lib.mutate(async (items) => {
        const it = items.find((x) => x.id === fav[1]);
        if (!it) return false;
        if (favorite) it.favorite = true;
        else delete it.favorite;
        return true;
      });
      return found ? sendJson(res, 200, { id: fav[1], favorite }) : sendJson(res, 404, { error: 'Not found' });
    }
    const tg = /^\/api\/media\/([\w-]+)\/tags$/.exec(p);
    if (tg && req.method === 'PUT') {
      const tags = cleanTags((await readJson(req)).tags, goalIds());
      const found = await lib.mutate(async (items) => {
        const it = items.find((x) => x.id === tg[1]);
        if (!it) return false;
        if (tags.length) it.tags = tags;
        else delete it.tags;
        return true;
      });
      if (found && tags.length) suggester.kick(); // a video that was waiting for a goal can get its cards now
      return found ? sendJson(res, 200, { id: tg[1], tags }) : sendJson(res, 404, { error: 'Not found' });
    }
    const del = /^\/api\/media\/([\w-]+)$/.exec(p);
    if (del && req.method === 'DELETE') return await remove(res, del[1]);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    const media = /^\/media\/([\w-]+\.[a-z0-9]+)$/i.exec(p);
    if (media) return await serveMedia(req, res, media[1]);
    if (p.startsWith('/media/')) return sendJson(res, 404, { error: 'Not found' });
    await serveStatic(req, res, p);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.status ? e.message : 'Server error' });
    else res.destroy();
  }
});

// Uploads of big videos over Wi-Fi can take a while; don't cut them off.
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`Motivati-scroll on http://0.0.0.0:${PORT} (data: ${DATA_DIR}, app: ${STATIC_DIR})`));
