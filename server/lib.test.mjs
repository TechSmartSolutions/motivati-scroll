import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Library, cleanName, kindOf, mediaExt, parseRange } from './lib.mjs';

describe('parseRange', () => {
  it('returns null without a header', () => expect(parseRange(undefined, 100)).toBeNull());
  it('parses an explicit range', () => expect(parseRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 }));
  it('parses an open-ended range', () => expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 }));
  it('clamps the end to the file size', () => expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 }));
  it('parses a suffix range', () => expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 }));
  it('rejects a start past the end of file', () => expect(parseRange('bytes=100-', 100)).toBe('invalid'));
  it('ignores multi-range and malformed headers', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('file names', () => {
  it('accepts known media extensions case-insensitively', () => {
    expect(mediaExt('IMG_0001.MOV')).toBe('mov');
    expect(mediaExt('pic.jpeg')).toBe('jpeg');
    expect(mediaExt('notes.txt')).toBeUndefined();
    expect(mediaExt('noext')).toBeUndefined();
  });
  it('classifies kind', () => {
    expect(kindOf('mp4')).toBe('video');
    expect(kindOf('png')).toBe('image');
  });
  it('strips directories and control characters', () => {
    expect(cleanName('../../etc/passwd')).toBe('passwd');
    expect(cleanName('C:\\Users\\a\\clip.mp4')).toBe('clip.mp4');
    expect(cleanName('a\nb.mp4')).toBe('ab.mp4');
    expect(cleanName('')).toBe('untitled');
  });
});

describe('Library', () => {
  it('persists mutations to library.json and reloads them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'motivati-'));
    try {
      const lib = await new Library(dir).init();
      await Promise.all([
        lib.mutate((items) => void items.push({ id: 'a', addedAt: 2 })),
        lib.mutate((items) => void items.push({ id: 'b', addedAt: 1 })),
      ]);
      expect(JSON.parse(await readFile(path.join(dir, 'library.json'), 'utf8'))).toHaveLength(2);
      const again = await new Library(dir).init();
      expect(again.list().map((i) => i.id)).toEqual(['b', 'a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
