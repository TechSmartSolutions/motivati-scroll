// Background transcription of every video in the library, using a local Whisper model
// (faster-whisper, run by server/transcribe.py). One video at a time, at low CPU priority.
// Transcripts are saved as <DATA_DIR>/transcripts/<id>.json and the library item is marked
// `transcript: 'done' | 'failed'`. Nothing leaves this machine except the one-time model download.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_ATTEMPTS = 2;

function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: String(e.message) });
    }
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => resolve({ code: -1, out, err: `${cmd}: ${e.message}` }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** True when the file has an audio stream (silent clips are given an empty transcript, no model run). */
export async function hasAudioStream(file) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { timeoutMs: 30000 });
  // If ffprobe itself fails, let the model try rather than silently skipping.
  return r.code !== 0 || r.out.trim().length > 0;
}

export class Transcriber {
  /**
   * @param lib Library instance
   * @param opts { enabled, python, script, model, threads, nice, hasAudio, timeoutMs }
   */
  constructor(lib, opts = {}) {
    this.lib = lib;
    this.enabled = opts.enabled ?? true;
    this.python = opts.python ?? 'python3';
    this.script = opts.script;
    this.model = opts.model ?? 'small';
    this.threads = opts.threads ?? 4;
    this.nice = opts.nice ?? process.platform !== 'win32';
    this.hasAudio = opts.hasAudio ?? hasAudioStream;
    this.timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
    this.dir = path.join(lib.dataDir, 'transcripts');
    this.modelDir = path.join(lib.dataDir, 'models');
    this.loop = undefined;
    this.current = undefined;
    this.lastError = undefined;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  pathFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** Videos still to do. Downloaded videos wait until the iPhone-compatibility repair has checked them, because it can replace the file. */
  pending() {
    return this.lib.list().filter((i) => i.kind === 'video' && !i.transcript && !(i.source && !i.playableChecked));
  }

  status() {
    const videos = this.lib.list().filter((i) => i.kind === 'video');
    return {
      enabled: this.enabled,
      model: this.model,
      working: !!this.loop,
      current: this.current?.name ?? null,
      pending: this.pending().length,
      done: videos.filter((i) => i.transcript === 'done').length,
      failed: videos.filter((i) => i.transcript === 'failed').length,
      lastError: this.lastError ?? null,
    };
  }

  /** Start working through the queue if not already. Safe to call often. */
  kick() {
    if (!this.enabled || this.loop) return this.loop;
    this.loop = this.work().finally(() => {
      this.loop = undefined;
      this.current = undefined;
    });
    return this.loop;
  }

  async work() {
    for (let item = this.pending()[0]; item; item = this.pending()[0]) {
      this.current = item;
      await this.transcribe(item);
    }
  }

  async transcribe(item) {
    const out = this.pathFor(item.id);
    const part = `${out}.part`;
    let ok = false;
    let error;
    try {
      if (!(await this.hasAudio(this.lib.fileFor(item)))) {
        await fs.writeFile(part, JSON.stringify({ model: this.model, language: null, duration: 0, text: '', segments: [], note: 'no audio' }));
        ok = true;
      } else {
        const args = [this.script, '--model', this.model, '--model-dir', this.modelDir, '--threads', String(this.threads), this.lib.fileFor(item), part];
        const [cmd, cmdArgs] = this.nice ? ['nice', ['-n', '10', this.python, ...args]] : [this.python, args];
        const t0 = Date.now();
        const r = await run(cmd, cmdArgs, { timeoutMs: this.timeoutMs });
        ok = r.code === 0;
        if (!ok) error = (r.err || r.out).trim().split('\n').slice(-3).join(' | ') || `exit ${r.code}`;
        else console.log(`transcribed ${item.name} in ${Math.round((Date.now() - t0) / 1000)}s`);
      }
    } catch (e) {
      error = e.message;
    }
    if (ok) await fs.rename(part, out);
    else await fs.rm(part, { force: true }).catch(() => {});

    const stillThere = await this.lib.mutate(async (items) => {
      const it = items.find((x) => x.id === item.id);
      if (!it) return false; // deleted while we worked
      if (ok) {
        it.transcript = 'done';
        delete it.transcriptAttempts;
      } else {
        it.transcriptAttempts = (it.transcriptAttempts ?? 0) + 1;
        if (it.transcriptAttempts >= MAX_ATTEMPTS) it.transcript = 'failed';
      }
      return true;
    });
    if (!stillThere) await fs.rm(out, { force: true }).catch(() => {});
    if (!ok) {
      this.lastError = `${item.name}: ${error}`;
      console.error(`transcription failed for ${item.name}: ${error}`);
    }
  }

  async read(id) {
    try {
      return JSON.parse(await fs.readFile(this.pathFor(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async remove(id) {
    await fs.rm(this.pathFor(id), { force: true });
  }
}
