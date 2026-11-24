import { describe, expect, it } from 'vitest';
import { availablePrompts, pickGoal, pickPrompt, usesGoal, withGoal } from './challenges';

describe('pickPrompt', () => {
  const deck = [1, 2, 3, 4].flatMap((level) => [`a${level}`, `b${level}`].map((id) => ({ id, level, text: `card ${id}` })));

  it('returns a prompt at the requested level', () => {
    for (let lv = 1; lv <= 4; lv++) expect(pickPrompt(deck, lv)?.level).toBe(lv);
  });

  it('avoids the excluded prompt when others exist', () => {
    const first = pickPrompt(deck, 2)!;
    for (let i = 0; i < 50; i++) expect(pickPrompt(deck, 2, first.id)!.id).not.toBe(first.id);
  });

  it('falls back to a nearby level when none exist', () => {
    const only = [{ id: 'x', level: 1, text: 't' }];
    expect(pickPrompt(only, 3)?.id).toBe('x');
    expect(pickPrompt([], 1)).toBeUndefined();
  });

  const sample = [
    { id: 'd', level: 1, text: 'Find a goal', discovery: true },
    { id: 'g', level: 1, text: 'Work on {goal} today' },
    { id: 'p', level: 2, text: 'Do 10 squats' },
  ];

  it('without a goal, hides goal prompts and shows discovery prompts', () => {
    const pool = availablePrompts(sample, false);
    expect(pool.map((p) => p.id)).toEqual(['d', 'p']);
  });

  it('with a goal, hides discovery prompts and fills in the goal text', () => {
    const pool = availablePrompts(sample, true);
    expect(pool.map((p) => p.id)).toEqual(['g', 'p']);
    const text = withGoal(pool.filter(usesGoal)[0], '  Get fit ').text;
    expect(text).toBe('Work on Get fit today');
  });
});

describe('pickGoal', () => {
  const g = (id: string, text: string, active: boolean) => ({ id, text, active, prompt: '' });
  const set = { goals: [g('a', 'Get fit', true), g('b', 'Earn more', false), g('c', 'Read daily', true)] };

  it('returns undefined with no goals', () => {
    expect(pickGoal({ goals: [] })).toBeUndefined();
  });

  it('only picks active goals, evenly', () => {
    expect(pickGoal(set, () => 0)).toBe('Get fit');
    expect(pickGoal(set, () => 0.49)).toBe('Get fit');
    expect(pickGoal(set, () => 0.51)).toBe('Read daily');
    expect(pickGoal(set, () => 0.999)).toBe('Read daily');
  });

  it('falls back to any goal when none is active, so cards never go blank', () => {
    expect(pickGoal({ goals: [g('a', 'Get fit', false)] })).toBe('Get fit');
  });
});