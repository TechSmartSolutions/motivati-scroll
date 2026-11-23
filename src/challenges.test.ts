import { describe, expect, it } from 'vitest';
import { builtinPrompts, pickPrompt } from './challenges';

describe('pickPrompt', () => {
  it('returns a prompt at the requested level', () => {
    for (let lv = 1; lv <= 4; lv++) expect(pickPrompt(builtinPrompts, lv)?.level).toBe(lv);
  });

  it('avoids the excluded prompt when others exist', () => {
    const first = pickPrompt(builtinPrompts, 2)!;
    for (let i = 0; i < 50; i++) expect(pickPrompt(builtinPrompts, 2, first.id)!.id).not.toBe(first.id);
  });

  it('falls back to a nearby level when none exist', () => {
    const only = [{ id: 'x', level: 1, text: 't' }];
    expect(pickPrompt(only, 3)?.id).toBe('x');
    expect(pickPrompt([], 1)).toBeUndefined();
  });

  it('every built-in prompt has unique id and valid level', () => {
    const ids = new Set(builtinPrompts.map((p) => p.id));
    expect(ids.size).toBe(builtinPrompts.length);
    for (const p of builtinPrompts) expect([1, 2, 3, 4]).toContain(p.level);
  });
});
