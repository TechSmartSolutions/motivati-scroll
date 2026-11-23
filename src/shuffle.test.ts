import { describe, expect, it } from 'vitest';
import { ShuffleBag } from './shuffle';

describe('ShuffleBag', () => {
  it('serves every item once per round', () => {
    const bag = new ShuffleBag(['a', 'b', 'c', 'd', 'e']);
    for (let round = 0; round < 5; round++) {
      const seen = Array.from({ length: 5 }, () => bag.next());
      expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    }
  });

  it('never repeats across a round boundary', () => {
    const bag = new ShuffleBag(['a', 'b', 'c']);
    let prev = bag.next();
    for (let i = 0; i < 300; i++) {
      const cur = bag.next();
      expect(cur).not.toBe(prev);
      prev = cur;
    }
  });

  it('handles empty and single-item libraries', () => {
    expect(new ShuffleBag<string>([]).next()).toBeUndefined();
    const one = new ShuffleBag(['x']);
    expect(one.next()).toBe('x');
    expect(one.next()).toBe('x');
  });

  it('adds new items and drops removed ones', () => {
    const bag = new ShuffleBag(['a', 'b']);
    bag.next();
    bag.setItems(['b', 'c', 'd']);
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 6; i++) seen.add(bag.next());
    expect(seen.has('a')).toBe(false);
    expect(seen.has('c') && seen.has('d')).toBe(true);
  });
});
