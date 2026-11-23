import { describe, expect, it } from 'vitest';
import { defaultProgress, recordDone, stepLevel, streak, dateKey, MAX_LEVEL } from './progress';

describe('progress', () => {
  it('levels up after the threshold and resets the counter', () => {
    let p = defaultProgress();
    for (let i = 0; i < 4; i++) p = recordDone(p, 5).progress;
    expect(p.level).toBe(1);
    const r = recordDone(p, 5);
    expect(r.leveledUp).toBe(true);
    expect(r.progress.level).toBe(2);
    expect(r.progress.doneAtLevel).toBe(0);
    expect(r.progress.totalDone).toBe(5);
  });

  it('never exceeds the max level', () => {
    let p = { ...defaultProgress(), level: MAX_LEVEL };
    for (let i = 0; i < 10; i++) p = recordDone(p, 2).progress;
    expect(p.level).toBe(MAX_LEVEL);
  });

  it('steps levels within bounds', () => {
    expect(stepLevel(defaultProgress(), -1).level).toBe(1);
    expect(stepLevel(defaultProgress(), 1).level).toBe(2);
    expect(stepLevel({ ...defaultProgress(), level: MAX_LEVEL }, 1).level).toBe(MAX_LEVEL);
  });

  it('counts a streak ending today or yesterday', () => {
    const now = new Date(2026, 10, 23);
    const day = (offset: number) => dateKey(new Date(2026, 10, 23 + offset));
    const p = { ...defaultProgress(), days: { [day(0)]: 1, [day(-1)]: 2, [day(-2)]: 1, [day(-4)]: 1 } };
    expect(streak(p, now)).toBe(3);
    const yesterdayOnly = { ...defaultProgress(), days: { [day(-1)]: 1 } };
    expect(streak(yesterdayOnly, now)).toBe(1);
    expect(streak({ ...defaultProgress(), days: { [day(-3)]: 1 } }, now)).toBe(0);
  });
});
