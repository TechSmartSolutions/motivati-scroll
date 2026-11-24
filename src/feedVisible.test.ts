import { describe, expect, it } from 'vitest';
import { feedVisible, type MediaItem } from './library';

const v = (id: string, tags?: string[]): MediaItem => ({ id, name: id, kind: 'video', size: 1, addedAt: 0, url: '', tags });
const goals = [{ id: 'a', active: true }, { id: 'b', active: false }];

describe('feedVisible', () => {
  it('shows untagged videos and videos with at least one active goal', () => {
    const out = feedVisible([v('none'), v('empty', []), v('act', ['a']), v('mixed', ['b', 'a']), v('parked', ['b'])], goals);
    expect(out.map((x) => x.id)).toEqual(['none', 'empty', 'act', 'mixed']);
  });

  it('hides a video whose only goal no longer exists', () => {
    expect(feedVisible([v('gone', ['zzz'])], goals)).toEqual([]);
  });
});

describe('feedVisible with one goal picked', () => {
  const goals3 = [{ id: 'a', active: true }, { id: 'b', active: true }, { id: 'c', active: false }];

  it('keeps only videos filed under that goal and hides untagged ones', () => {
    const items = [v('none'), v('a-only', ['a']), v('b-only', ['b']), v('both', ['a', 'b'])];
    expect(feedVisible(items, goals3, 'a').map((x) => x.id)).toEqual(['a-only', 'both']);
    expect(feedVisible(items, goals3, 'b').map((x) => x.id)).toEqual(['b-only', 'both']);
  });

  it('with no goal picked it behaves as before', () => {
    const items = [v('none'), v('a', ['a']), v('c', ['c'])];
    expect(feedVisible(items, goals3, null).map((x) => x.id)).toEqual(['none', 'a']);
    expect(feedVisible(items, goals3).map((x) => x.id)).toEqual(['none', 'a']);
  });
});
