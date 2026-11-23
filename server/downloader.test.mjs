import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Library } from './lib.mjs';
import { Downloader } from './downloader.mjs';
import { extractUrls, friendlyError, parseFacebookUrl, parseProgress, titleToName } from './downloader-lib.mjs';

describe('parseFacebookUrl', () => {
  it('accepts reel links and strips tracking', () => {
    const r = parseFacebookUrl('https://m.facebook.com/reel/1234567890?s=yWDuG2&fs=e#x');
    expect(r).toEqual({ url: 'https://www.facebook.com/reel/1234567890', key: 'fb:1234567890' });
  });
  it('gives the same key for different forms of one video', () => {
    const a = parseFacebookUrl('https://www.facebook.com/watch/?v=42').key;
    const b = parseFacebookUrl('https://facebook.com/someone/videos/42/').key;
    expect(a).toBe('fb:42');
    expect(b).toBe('fb:42');
  });
  it('accepts short and share links', () => {
    expect(parseFacebookUrl('https://fb.watch/abc123/').key).toBe('url:fb.watch/abc123');
    expect(parseFacebookUrl('https://www.facebook.com/share/r/AbC/').key).toBe('url:www.facebook.com/share/r/AbC');
  });
  it('rejects non-Facebook hosts, lookalikes, and junk', () => {
    expect(parseFacebookUrl('https://example.com/reel/1').error).toBeTruthy();
    expect(parseFacebookUrl('https://facebook.com.evil.com/reel/1').error).toBeTruthy();
    expect(parseFacebookUrl('http://10.0.0.1/reel/1').error).toBeTruthy();
    expect(parseFacebookUrl('file:///etc/passwd').error).toBeTruthy();
    expect(parseFacebookUrl('not a url').error).toBeTruthy();
    expect(parseFacebookUrl('https://www.facebook.com/someone').error).toBeTruthy();
  });
});

describe('helpers', () => {
  it('extracts links from pasted text', () => {
    expect(extractUrls('look https://fb.watch/a/ and\nhttps://www.facebook.com/reel/1 ok https://fb.watch/a/')).toEqual(['https://fb.watch/a/', 'https://www.facebook.com/reel/1']);
  });
  it('translates the vague parse error into a login-wall message', () => {
    expect(friendlyError('ERROR: [facebook] 123: Cannot parse data; please report', 1)).toMatch(/Facebook blocked this link/);
    expect(friendlyError('ERROR: [facebook] This video is private', 1)).toMatch(/private/);
  });
  it('does not blame Facebook for network failures', () => {
    expect(friendlyError('ERROR: Unable to download webpage: <urlopen error Tunnel connection failed: 403>', 1)).toMatch(/could not reach Facebook/);
  });
  it('parses progress and builds file names', () => {
    expect(parseProgress('dl: 42.5%')).toBeCloseTo(0.425);
    expect(parseProgress('other')).toBeUndefined();
    expect(titleToName('a/b:c*d', '1')).toBe('a b c d.mp4');
    expect(titleToName('', '99')).toBe('facebook-99.mp4');
  });
});

// A fake yt-dlp: writes a tiny file where asked, or fails like Facebook's login wall.
const STUB = `#!/bin/sh
for a in "$@"; do last="$a"; done
prev=""; out=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
case "$*" in *--version*) echo 2099.01.01; exit 0;; esac
case "$last" in *9999*) echo "ERROR: [facebook] 9999: Cannot parse data; please report" >&2; exit 1;; esac
id=$(echo "$last" | sed 's/.*reel\\/\\([0-9]*\\).*/\\1/')
file=$(echo "$out" | sed 's/%(ext)s/mp4/')
echo "dl: 50.0%"
printf 'video-bytes' > "$file"
printf 'FINAL\\t%s\\tTitle %s\\t%s\\n' "$id" "$id" "$file"
`;

describe('Downloader', () => {
  let dir, dl, lib;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dl-'));
    const bin = path.join(dir, 'stub.sh');
    await writeFile(bin, STUB);
    await chmod(bin, 0o755);
    lib = await new Library(path.join(dir, 'data')).init();
    dl = await new Downloader(lib, { bin, makePlayable: async (f) => ({ action: 'none', reason: 'stub', output: f }) }).init();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const settle = async () => { await dl.queue; };

  it('downloads into the library, then flags a repeat link as a duplicate', async () => {
    dl.enqueue(['https://www.facebook.com/reel/111']);
    await settle();
    expect(dl.list()[0]).toMatchObject({ status: 'done' });
    expect(lib.list()).toHaveLength(1);
    expect(lib.list()[0]).toMatchObject({ name: 'Title 111.mp4', kind: 'video', source: 'fb:111' });
    const again = dl.enqueue(['https://m.facebook.com/reel/111?s=x']);
    expect(again[0]).toMatchObject({ status: 'duplicate', message: 'Already in your library.' });
    expect(lib.list()).toHaveLength(1);
  });
  it('accepts a list and keeps going after a failure', async () => {
    dl.enqueue(['https://www.facebook.com/reel/9999', 'https://www.facebook.com/reel/222', 'https://example.com/x']);
    await settle();
    expect(dl.list().map((j) => j.status)).toEqual(['error', 'done', 'error']);
    expect(dl.list()[0].message).toMatch(/Facebook blocked this link/);
    expect(lib.list()).toHaveLength(1);
  });
  it('cleans up temp files', async () => {
    dl.enqueue(['https://www.facebook.com/reel/333']);
    await settle();
    expect(await readdir(dl.tmpDir)).toEqual([]);
  });
  it('reports a missing downloader plainly', async () => {
    const d = await new Downloader(lib, { bin: '/nonexistent/yt-dlp' }).init();
    d.enqueue(['https://www.facebook.com/reel/444']);
    await d.queue;
    expect(d.list()[0]).toMatchObject({ status: 'error' });
    expect(d.list()[0].message).toBeTruthy();
  });
  it('reads the version', async () => expect(await dl.version()).toBe('2099.01.01'));
});
