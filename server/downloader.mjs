// Downloads public Facebook reels into the media library with yt-dlp.
//
// Privacy rule: the downloader is NEVER logged in. No cookies, no browser profile, no account, and
// `--ignore-config` stops any config file on the machine from adding them. Private or login-walled
// reels therefore fail by design; the app tells the user to upload the file instead.
//
// Input is a list of URLs on purpose: the paste box is one source, and a future source (for example
// a separate tool that suggests reels) can call `enqueue(urls)` without touching anything else.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { kindOf, mediaExt } from './lib.mjs';
import { makePlayable } from './playable.mjs';
import { friendlyError, parseFacebookUrl, parseProgress, titleToName } from './downloader-lib.mjs';

const MAX_JOBS_KEPT = 50;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Run a process to completion, streaming stdout lines to onLine. Never rejects. */
function run(bin, args, { onLine, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let buf = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: `spawn ${bin}: ${e.message}` });
    }
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined;
    child.stdout.on('data', (d) => {
      out += d;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine?.(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: `spawn ${bin}: ${e.code ?? ''} ${e.message}` }));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) onLine?.(buf);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

export class Downloader {
  /**
   * @param lib   the Library
   * @param opts  { bin, tmpDir, newId }
   */
  constructor(lib, { bin = 'yt-dlp', tmpDir, makePlayable: fix = makePlayable } = {}) {
    this.fix = fix;
    this.lib = lib;
    this.bin = bin;
    this.tmpDir = tmpDir ?? path.join(lib.dataDir, 'downloads-tmp');
    this.jobs = [];
    this.queue = Promise.resolve();
    this.updating = false;
  }

  async init() {
    // Anything left here is from a download that was interrupted by a restart.
    await fs.rm(this.tmpDir, { recursive: true, force: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
    return this;
  }

  list() {
    return this.jobs.map(({ promise, ...pub }) => pub);
  }

  /** Accept a list of URLs. Invalid, repeated and already-downloaded links are reported, not queued twice. */
  enqueue(urls) {
    const added = [];
    for (const raw of urls) {
      const parsed = parseFacebookUrl(raw);
      const job = { id: this.lib.newId(), url: parsed.url ?? String(raw), key: parsed.key, status: 'queued', progress: 0, message: '', createdAt: Date.now() };
      if (parsed.error) {
        Object.assign(job, { status: 'error', message: parsed.error });
      } else if (this.jobs.some((j) => j.key === job.key && (j.status === 'queued' || j.status === 'downloading'))) {
        Object.assign(job, { status: 'duplicate', message: 'Already downloading.' });
      } else if (this.findExisting(job.key)) {
        Object.assign(job, { status: 'duplicate', message: 'Already in your library.' });
      } else {
        this.queue = this.queue.then(() => this.process(job)).catch(() => {});
      }
      this.jobs.push(job);
      added.push(job);
    }
    this.prune();
    return added.map(({ promise, ...pub }) => pub);
  }

  findExisting(key) {
    return this.lib.list().find((i) => i.source === key || i.alias === key);
  }

  prune() {
    const done = (j) => j.status !== 'queued' && j.status !== 'downloading';
    while (this.jobs.length > MAX_JOBS_KEPT) {
      const i = this.jobs.findIndex(done);
      if (i < 0) break;
      this.jobs.splice(i, 1);
    }
  }

  async process(job) {
    job.status = 'downloading';
    const args = [
      '--ignore-config', // never pick up cookies or credentials from a config file
      '--no-playlist',
      '--no-mtime',
      // Prefer H.264 + AAC, which iPhone Safari plays; anything else is converted below.
      '-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--newline',
      '--progress', // --print would otherwise silence progress lines
      '--progress-template', 'download:dl:%(progress._percent_str)s',
      '--no-simulate',
      '--print', 'after_move:FINAL\t%(id)s\t%(title)s\t%(filepath)s',
      '-o', path.join(this.tmpDir, `${job.id}.%(ext)s`),
      '--', // the URL can never be read as an option
      job.url,
    ];
    let final;
    const res = await run(this.bin, args, {
      timeoutMs: JOB_TIMEOUT_MS,
      onLine: (line) => {
        const f = parseProgress(line);
        if (f !== undefined) job.progress = f;
        if (line.startsWith('FINAL\t')) final = line.split('\t').slice(1);
      },
    });
    try {
      if (res.code !== 0 || !final) {
        console.error(`download failed (${job.url}): ${res.err.trim().split('\n').slice(-3).join(' | ')}`);
        throw Object.assign(new Error(friendlyError(res.err, res.code)), { user: true });
      }
      const [id, title, rawPath] = final;
      let filepath = rawPath;
      try {
        // Guarantee H.264 + AAC + faststart whatever Facebook served, or iPhone shows "video unavailable".
        const fixed = await this.fix(rawPath);
        if (fixed.output !== rawPath) {
          console.log(`made playable (${fixed.action}: ${fixed.reason}): ${title}`);
          filepath = fixed.output;
        }
      } catch (e) {
        console.error('could not make video playable', e.message);
        throw Object.assign(new Error('The video downloaded but could not be converted to a format iPhone plays.'), { user: true });
      }
      const ext = mediaExt(filepath);
      if (!ext || !kindOf(ext).startsWith('video')) throw Object.assign(new Error('Facebook returned something that is not a video.'), { user: true });
      const key = `fb:${id}`;
      const name = titleToName(title, id);
      const file = `${this.lib.newId()}.${ext}`;
      const dest = path.join(this.lib.mediaDir, file);
      const { size } = await fs.stat(filepath);
      const outcome = await this.lib.mutate(async (items) => {
        const dup = items.find((i) => i.source === key || i.alias === job.key || i.source === job.key);
        if (dup) return { dup };
        await fs.rename(filepath, dest);
        // `alias` remembers the pasted link form (fb.watch / share links) so pasting it again is caught early.
        const item = { id: file.split('.')[0], name, kind: kindOf(ext), size, addedAt: Date.now(), file, source: key, playableChecked: true };
        if (job.key !== key) item.alias = job.key;
        items.push(item);
        return { item };
      });
      if (outcome.dup) {
        Object.assign(job, { status: 'duplicate', message: 'Already in your library.', progress: 1 });
      } else {
        Object.assign(job, { status: 'done', progress: 1, message: `Added ${name}`, item: outcome.item.id });
        console.log(`downloaded ${name} (${size} bytes)`);
      }
    } catch (e) {
      Object.assign(job, { status: 'error', message: e.user ? e.message : 'Could not save the video.' });
      if (!e.user) console.error('download save failed', e);
    } finally {
      await fs.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(this.tmpDir, { recursive: true }).catch(() => {});
    }
  }

  async version() {
    const r = await run(this.bin, ['--ignore-config', '--version'], { timeoutMs: 20000 });
    return r.code === 0 ? r.out.trim() : null;
  }

  /** Update yt-dlp in place. Runs after any queued downloads so it never swaps the binary mid-download. */
  update() {
    if (this.updating) return this.updating;
    const task = this.queue.then(async () => {
      const before = await this.version();
      const r = await run(this.bin, ['--ignore-config', '-U'], { timeoutMs: 120000 });
      const after = await this.version();
      if (r.code !== 0) console.error('yt-dlp update failed:', (r.err || r.out).trim().split('\n').slice(-2).join(' | '));
      return { ok: r.code === 0 && after !== null, before, after, updated: before !== after };
    });
    this.queue = task.catch(() => {});
    this.updating = task.finally(() => (this.updating = false));
    return this.updating;
  }
}
