// Pure helpers for the media server, kept separate so they can be unit tested.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Allowed extensions and the Content-Type each one is served with. */
export const MEDIA_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
};

/** Lower-case extension of a file name if it is an allowed media type, else undefined. */
export function mediaExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '');
  const ext = m?.[1].toLowerCase();
  return ext && ext in MEDIA_TYPES ? ext : undefined;
}

export const kindOf = (ext) => (MEDIA_TYPES[ext].startsWith('video/') ? 'video' : 'image');

/**
 * Parse a single-range `Range: bytes=...` header against a file size.
 * Returns {start, end} (inclusive), null when there is no usable header (serve whole file),
 * or 'invalid' when the range cannot be satisfied (416).
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    // suffix range: last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Library index stored as JSON next to the media folder. Writes are serialized and atomic. */
export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'media');
    this.indexPath = path.join(dataDir, 'library.json');
    this.items = [];
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.mediaDir, { recursive: true });
    try {
      this.items = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.items = [];
    }
    return this;
  }

  list() {
    return [...this.items].sort((a, b) => a.addedAt - b.addedAt);
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  fileFor(item) {
    return path.join(this.mediaDir, item.file);
  }

  newId() {
    return randomUUID();
  }

  /** Run fn with exclusive access to the index, then persist it. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.items);
      const tmp = `${this.indexPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.items, null, 2));
      await fs.rename(tmp, this.indexPath);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** Safe file name for display: strip any directory parts and control characters. */
export function cleanName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'untitled';
}
