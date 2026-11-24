import { describe, expect, it } from 'vitest';
import { videoLabel } from './library';

describe('videoLabel', () => {
  it('uses the reactions count and the start of the title', () => {
    expect(videoLabel('75K views · 21K reactions You Can’t Stop Tip of the day Don’t rush the process T.mp4').full).toBe('👍 21K · You Can’t Stop…');
    expect(videoLabel('4K views · 270 reactions Have you ever looked at money this way Check the 🔗 in .mp4').count).toBe('👍 270');
  });

  it('falls back to shares when there are no reactions, and to views when there are no reactions', () => {
    expect(videoLabel('592 shares · 53 comments They think you are monster... 🖤 . . . . Follow Gauri M.mp4').count).toBe('↗ 592');
    expect(videoLabel('1.2M views · 81K reactions 💯 #fyp #motorcycle.mp4').count).toBe('👍 81K');
    expect(videoLabel('5K views Something here.mp4').count).toBe('▶ 5K');
  });

  it('shows just the title when there are no stats', () => {
    expect(videoLabel('Kill your laziness..mp4')).toEqual({ count: '', text: 'Kill your lazi…', full: 'Kill your lazi…' });
    expect(videoLabel('Short.mp4').full).toBe('Short');
  });

  it('drops hashtags, but uses them when they are all there is', () => {
    expect(videoLabel('2K views · 6.9K reactions Rich mindset✨ #luxury #mindset #success.mp4').text).toBe('Rich mindset✨');
    expect(videoLabel('3.6M views · 103K reactions #pushups #motivation #calisthenics.mp4').text).toBe('pushups motiva…');
  });

  it('does not cut an emoji in half', () => {
    expect(videoLabel('10 reactions 😎😎😎😎😎😎😎😎😎😎😎😎😎😎😎😎😎😎.mp4').text).toBe(`${'😎'.repeat(14)}…`);
  });

  it('tells two videos with the same title apart by their counts', () => {
    const a = videoLabel('30K views · 2.3K reactions I promise you. Elite Will.mp4').full;
    const b = videoLabel('38K views · 3.1K reactions I promise you. Elite Will.mp4').full;
    expect(a).not.toBe(b);
  });
});
