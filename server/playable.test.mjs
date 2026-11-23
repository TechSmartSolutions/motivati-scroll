import { describe, expect, it } from 'vitest';
import { planFix } from './playable.mjs';

const mk = (v, a = 'aac', fmt = 'mov,mp4,m4a,3gp,3g2,mj2', pix = 'yuv420p') => ({
  format: { format_name: fmt },
  streams: [{ codec_type: 'video', codec_name: v, pix_fmt: pix }, ...(a ? [{ codec_type: 'audio', codec_name: a }] : [])],
});

describe('planFix', () => {
  it('leaves a good file alone', () => expect(planFix(mk('h264'), true).action).toBe('none'));
  it('accepts silent video', () => expect(planFix(mk('h264', null), true).action).toBe('none'));
  it('re-encodes VP9 and AV1', () => {
    expect(planFix(mk('vp9'), true).action).toBe('transcode');
    expect(planFix(mk('av1'), true).action).toBe('transcode');
  });
  it('re-encodes Opus audio', () => expect(planFix(mk('h264', 'opus'), true).action).toBe('transcode'));
  it('re-encodes 10-bit h264', () => expect(planFix(mk('h264', 'aac', undefined, 'yuv420p10le'), true).action).toBe('transcode'));
  it('only remuxes when the index is at the end', () => expect(planFix(mk('h264'), false).action).toBe('remux'));
  it('remuxes non-mp4 containers with good codecs', () => expect(planFix(mk('h264', 'aac', 'matroska,webm'), true).action).toBe('remux'));
});
