import { describe, expect, it } from 'vitest';
import { addItem, ageLabel, counts, daysOld, emptyToday, hasItem, markDone, markDoneForPrompt, overdueCount, removeItem, rollover } from './today';

const p = { id: 'l2-1', level: 2, need: 'growth', text: 'Do the thing for 5 minutes.' };
const noon = new Date(2026, 10, 23, 12);

describe('today list', () => {
  it('adds a challenge once and ignores duplicates', () => {
    const a = addItem(emptyToday(noon), p, noon);
    expect(a.added).toBe(true);
    expect(a.list.items).toHaveLength(1);
    expect(a.list.items[0]).toMatchObject({ promptId: 'l2-1', text: p.text, level: 2, done: false });
    const b = addItem(a.list, p, noon);
    expect(b.added).toBe(false);
    expect(b.list).toBe(a.list);
  });

  it('treats the same prompt with different goal wording as a different entry', () => {
    const goalPrompt = { ...p, id: 'l4-2' };
    const a = addItem(emptyToday(noon), { ...goalPrompt, text: 'Do it for "Get fit".' }, noon).list;
    expect(hasItem(a, { id: 'l4-2', text: 'Do it for "Get fit".' })).toBe(true);
    expect(hasItem(a, { id: 'l4-2', text: 'Do it for "Earn more".' })).toBe(false);
  });

  it('marks done, removes, and counts', () => {
    let list = addItem(emptyToday(noon), p, noon).list;
    list = addItem(list, { ...p, id: 'l1-1', text: 'Breathe.' }, noon).list;
    expect(counts(list)).toEqual({ done: 0, total: 2 });
    list = markDone(list, list.items[0].id);
    expect(counts(list)).toEqual({ done: 1, total: 2 });
    list = removeItem(list, list.items[1].id);
    expect(counts(list)).toEqual({ done: 1, total: 1 });
  });

  it('ticks off the matching entry when the card itself is completed', () => {
    let list = addItem(emptyToday(noon), p, noon).list;
    list = markDoneForPrompt(list, { id: 'other', text: 'x' });
    expect(counts(list).done).toBe(0);
    list = markDoneForPrompt(list, p);
    expect(counts(list).done).toBe(1);
  });

  it('stays the same object within a day', () => {
    const list = addItem(emptyToday(noon), p, noon).list;
    expect(rollover(list, new Date(2026, 10, 23, 23, 59))).toBe(list);
  });

  it('carries unfinished items to the next day and clears finished ones', () => {
    let list = addItem(emptyToday(noon), p, noon).list;
    list = addItem(list, { ...p, id: 'l1-1', text: 'Breathe.' }, noon).list;
    list = markDone(list, list.items[1].id);
    const next = rollover(list, new Date(2026, 10, 24, 0, 1));
    expect(next.date).toBe('2026-11-24');
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ promptId: 'l2-1', done: false, addedDate: '2026-11-23' });
  });

  it('measures how overdue a carried item is', () => {
    const list = addItem(emptyToday(noon), p, noon).list;
    const item = list.items[0];
    expect(daysOld(item, noon)).toBe(0);
    expect(daysOld(item, new Date(2026, 10, 24, 8))).toBe(1);
    expect(daysOld(item, new Date(2026, 10, 27, 8))).toBe(4);
    expect(ageLabel(0)).toBe('');
    expect(ageLabel(1)).toBe('from yesterday');
    expect(ageLabel(4)).toBe('from 4 days ago');
  });

  it('counts overdue unfinished items only', () => {
    let list = addItem(emptyToday(noon), p, noon).list;
    list = addItem(list, { ...p, id: 'l1-1', text: 'Breathe.' }, noon).list;
    const later = new Date(2026, 10, 25, 9);
    list = rollover(list, later);
    expect(overdueCount(list, later)).toBe(2);
    list = markDone(list, list.items[0].id);
    expect(overdueCount(list, later)).toBe(1);
    list = addItem(list, { ...p, id: 'new', text: 'Fresh one.' }, later).list;
    expect(overdueCount(list, later)).toBe(1);
  });
});
