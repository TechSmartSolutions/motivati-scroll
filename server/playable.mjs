// Makes video files playable on iPhone Safari: H.264 (8-bit 4:2:0) + AAC in an mp4 with the moov
// index at the start (faststart), so range streaming works. Anything else is remuxed or re-encoded.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

function exec(bin, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: e.message });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** True when the `moov` box comes before `mdat` (reads only top-level box headers). */
export async function moovFirst(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      await fh.read(head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      if (len < 8) return false;
      pos += len;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/** Pure decision from an ffprobe JSON result: what has to be done to make the file iPhone-safe. */
export function planFix(probe, moovAtStart) {
  const streams = probe?.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) return { action: 'none', reason: 'no video stream' };
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const containerOk = /mov,mp4/.test(probe?.format?.format_name ?? '');
  const videoOk = v.codec_name === 'h264' && (v.pix_fmt === 'yuv420p' || !v.pix_fmt);
  const audioOk = audio.every((a) => a.codec_name === 'aac');
  if (!videoOk) return { action: 'transcode', reason: `video is ${v.codec_name}/${v.pix_fmt}` };
  if (!audioOk) return { action: 'transcode', reason: `audio is ${audio.map((a) => a.codec_name).join(',')}` };
  if (!containerOk || !moovAtStart) return { action: 'remux', reason: containerOk ? 'index at end of file' : 'not an mp4 container' };
  return { action: 'none', reason: 'already playable' };
}

export async function probe(file) {
  const r = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.err.trim().split('\n').pop()}`);
  return JSON.parse(r.out);
}

/**
 * Make `file` iPhone-playable. Returns { action, reason, output } where `output` is the path of the
 * file to use (the input itself when nothing was needed, otherwise a new `<file>.fixed.mp4` that the
 * caller moves into place). Throws when ffmpeg fails.
 */
export async function makePlayable(file) {
  const info = await probe(file);
  const plan = planFix(info, await moovFirst(file).catch(() => false));
  if (plan.action === 'none') return { ...plan, output: file };
  const output = `${file}.fixed.mp4`;
  const common = ['-nostdin', '-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn'];
  const args =
    plan.action === 'remux'
      ? [...common, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output]
      : [
          ...common,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
          '-movflags', '+faststart', '-f', 'mp4', output,
        ];
  const r = await exec('ffmpeg', args);
  if (r.code !== 0) {
    await fs.rm(output, { force: true });
    throw new Error(`ffmpeg ${plan.action} failed: ${r.err.trim().split('\n').pop()}`);
  }
  return { ...plan, output };
}
