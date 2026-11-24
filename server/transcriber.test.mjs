import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Library } from './lib.mjs';
import { Transcriber } from './transcriber.mjs';

// Stand-ins for python: node scripts that behave like transcribe.py (last arg is the output file).
const OK_SCRIPT = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), JSON.stringify({ text: 'hello there', segments: [], language: 'en' }));
`;
const FAIL_SCRIPT = `process.stderr.write('boom\\n'); process.exit(3);`;

async function setup(script, items) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tr-'));
  const lib = await new Library(dir).init();
  await lib.mutate((all) => void all.push(...items));
  const scriptPath = path.join(dir, 'stub.mjs');
  await writeFile(scriptPath, script);
  const t = await new Transcriber(lib, {
    python: process.execPath,
    script: scriptPath,
    nice: false,
    hasAudio: async () => true,
  }).init();
  return { dir, lib, t };
}

const video = (id, extra = {}) => ({ id, name: `${id}.mp4`, kind: 'video', size: 1, addedAt: 1, file: `${id}.mp4`, ...extra });

describe('Transcriber', () => {
  it('picks only videos still to do and waits for the repair step on downloads', async () => {
    const { dir, t } = await setup(OK_SCRIPT, [
      video('a'),
      video('b', { transcript: 'done' }),
      { id: 'c', name: 'c.png', kind: 'image', size: 1, addedAt: 1, file: 'c.png' },
      video('d', { source: 'facebook' }),
      video('e', { source: 'facebook', playableChecked: true }),
    ]);
    try {
      expect(t.pending().map((i) => i.id)).toEqual(['a', 'e']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the transcript and marks the video done', async () => {
    const { dir, lib, t } = await setup(OK_SCRIPT, [video('a'), video('b')]);
    try {
      await t.kick();
      expect(lib.list().map((i) => i.transcript)).toEqual(['done', 'done']);
      expect((await t.read('a')).text).toBe('hello there');
      expect(t.status()).toMatchObject({ done: 2, pending: 0, failed: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries once, then marks the video failed and moves on', async () => {
    const { dir, lib, t } = await setup(FAIL_SCRIPT, [video('a')]);
    try {
      await t.kick();
      const item = lib.get('a');
      expect(item.transcript).toBe('failed');
      expect(item.transcriptAttempts).toBe(2);
      expect(t.status().lastError).toContain('boom');
      expect(existsSync(t.pathFor('a'))).toBe(false);
      expect(existsSync(`${t.pathFor('a')}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives silent videos an empty transcript without running the model', async () => {
    const { dir, lib, t } = await setup(FAIL_SCRIPT, [video('a')]);
    t.hasAudio = async () => false;
    try {
      await t.kick();
      expect(lib.get('a').transcript).toBe('done');
      expect((await t.read('a')).text).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when disabled', async () => {
    const { dir, lib, t } = await setup(OK_SCRIPT, [video('a')]);
    t.enabled = false;
    try {
      await t.kick();
      expect(lib.get('a').transcript).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a transcript file on request', async () => {
    const { dir, t } = await setup(OK_SCRIPT, [video('a')]);
    try {
      await t.kick();
      await t.remove('a');
      expect(await t.read('a')).toBeUndefined();
      expect(await readFile(path.join(dir, 'library.json'), 'utf8')).toContain('"transcript": "done"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
