import { describe, expect, it } from 'vitest';
import { defaultProgress, fromSaved, recordDone, resetToday, rollDay, stepLevel, streak, dateKey, MAX_LEVEL } from './progress';

describe('progress', () => {
  it('levels up after the threshold and resets the counter', () => {
    let p = defaultProgress();
    for (let i = 0; i < 4; i++) p = recordDone(p, 5).progress;
    expect(p.level).toBe(1);
    const r = recordDone(p, 5);
    expect(r.leveledUp).toBe(true);
    expect(r.progress.level).toBe(2);
    expect(r.progress.doneAtLevel).toBe(0);
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

describe('levels start over every day', () => {
  const mon = new Date(2026, 10, 23, 9);
  const monLate = new Date(2026, 10, 23, 23, 50);
  const tue = new Date(2026, 10, 24, 7);

  it('a new day goes back to level 1 with the counter at zero, keeping the totals', () => {
    let p = { ...defaultProgress(), levelDay: dateKey(mon) };
    for (let i = 0; i < 7; i++) p = recordDone(p, 3, mon).progress;
    expect(p.level).toBe(3);
    const next = rollDay(p, tue);
    expect(next).toMatchObject({ level: 1, doneAtLevel: 0, levelDay: dateKey(tue) });
    expect(next.days).toEqual(p.days);
  });

  it('the same day changes nothing', () => {
    const p = { ...defaultProgress(), level: 3, doneAtLevel: 2, levelDay: dateKey(mon) };
    expect(rollDay(p, monLate)).toBe(p);
  });

  it('the first card of a new day counts toward level 1, not the old level', () => {
    const p = { ...defaultProgress(), level: 3, doneAtLevel: 2, levelDay: dateKey(mon) };
    const r = recordDone(p, 15, tue);
    expect(r.progress).toMatchObject({ level: 1, doneAtLevel: 1, levelDay: dateKey(tue) });
    expect(r.leveledUp).toBe(false);
  });

  it('you must finish N at level 1 before level 2, then N at level 2 before level 3', () => {
    let p = defaultProgress();
    for (let i = 0; i < 14; i++) p = recordDone(p, 15).progress;
    expect(p.level).toBe(1);
    p = recordDone(p, 15).progress;
    expect(p).toMatchObject({ level: 2, doneAtLevel: 0 });
    for (let i = 0; i < 15; i++) p = recordDone(p, 15).progress;
    expect(p.level).toBe(3);
  });

  it('progress saved before this change (no levelDay) starts at level 1 today', () => {
    const old = { level: 3, doneAtLevel: 4, totalDone: 20, days: {} } as unknown as ReturnType<typeof defaultProgress>; // old saves still carry totalDone
    expect(rollDay(old)).toMatchObject({ level: 1, doneAtLevel: 0 });
  });
});

describe('resetToday', () => {
  const mon = new Date(2026, 10, 23, 9);
  const day = (offset: number) => dateKey(new Date(2026, 10, 23 + offset));

  it('zeroes today only: level 1, counter 0, done today 0, earlier days stay', () => {
    let p = { ...defaultProgress(), levelDay: dateKey(mon), days: { [day(-1)]: 4 } };
    for (let i = 0; i < 7; i++) p = recordDone(p, 3, mon).progress;
    expect(p.level).toBe(3);
    const r = resetToday(p, mon);
    expect(r).toMatchObject({ level: 1, doneAtLevel: 0, levelDay: dateKey(mon) });
    expect(r.days).toEqual({ [day(-1)]: 4 });
  });

  it('is safe when nothing was done today', () => {
    const p = { ...defaultProgress(), levelDay: dateKey(mon) };
    expect(resetToday(p, mon)).toMatchObject({ level: 1, doneAtLevel: 0 });
  });
});

describe('loading saved progress', () => {
  it('an old save (no levelDay) is not treated as today: the old level and count are dropped', () => {
    const loaded = fromSaved({ level: 3, doneAtLevel: 2, days: { '2026-11-25': 6 } });
    expect(loaded.levelDay).toBe('');
    expect(rollDay(loaded)).toMatchObject({ level: 1, doneAtLevel: 0, levelDay: dateKey() });
    expect(rollDay(loaded).days).toEqual({ '2026-11-25': 6 });
  });

  it('a save made today keeps its level and count', () => {
    const saved = { level: 2, doneAtLevel: 4, levelDay: dateKey(), days: { [dateKey()]: 19 } };
    expect(rollDay(fromSaved(saved))).toMatchObject({ level: 2, doneAtLevel: 4 });
  });

  it('nothing saved starts fresh at level 1', () => {
    expect(rollDay(fromSaved({}))).toMatchObject({ level: 1, doneAtLevel: 0 });
  });
});
