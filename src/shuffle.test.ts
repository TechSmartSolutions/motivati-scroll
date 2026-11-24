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

  describe('weights (favorites)', () => {
    const fav = new Set(['b']);
    const weight = (t: string) => (fav.has(t) ? 3 : 1);

    it('serves a weight-3 item three times per round and the rest once', () => {
      const bag = new ShuffleBag(['a', 'b', 'c', 'd'], Math.random, weight);
      for (let round = 0; round < 20; round++) {
        const seen = Array.from({ length: 6 }, () => bag.next());
        expect(seen.filter((x) => x === 'b')).toHaveLength(3);
        for (const other of ['a', 'c', 'd']) expect(seen.filter((x) => x === other)).toHaveLength(1);
      }
    });

    it('never serves the same item twice in a row, even a heavy one', () => {
      const bag = new ShuffleBag(['a', 'b', 'c'], Math.random, weight);
      let prev = bag.next();
      for (let i = 0; i < 600; i++) {
        const cur = bag.next();
        expect(cur).not.toBe(prev);
        prev = cur;
      }
    });

    it('adds extra copies when an unplayed item becomes a favorite', () => {
      const fav2 = new Set<string>();
      const bag = new ShuffleBag(['a', 'b', 'c', 'd'], Math.random, (t) => (fav2.has(t) ? 3 : 1));
      fav2.add('d');
      bag.setItems(['a', 'b', 'c', 'd']);
      const round = Array.from({ length: 6 }, () => bag.next());
      expect(round.filter((x) => x === 'd')).toHaveLength(3);
    });

    it('removes the extra copies again when it stops being a favorite', () => {
      const fav2 = new Set<string>();
      const bag = new ShuffleBag(['a', 'b', 'c', 'd'], Math.random, (t) => (fav2.has(t) ? 3 : 1));
      fav2.add('d');
      bag.setItems(['a', 'b', 'c', 'd']);
      fav2.delete('d');
      bag.setItems(['a', 'b', 'c', 'd']);
      const round = Array.from({ length: 4 }, () => bag.next());
      expect([...round].sort()).toEqual(['a', 'b', 'c', 'd']);
    });
    it('treats a single heavy item as the only choice without looping forever', () => {
      const bag = new ShuffleBag(['x'], Math.random, () => 3);
      expect(bag.next()).toBe('x');
      expect(bag.next()).toBe('x');
    });
  });
});