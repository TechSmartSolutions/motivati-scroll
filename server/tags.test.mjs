import { describe, expect, it } from 'vitest';
import { cleanTags, parseTagList } from './tags.mjs';

const GOALS = ['discomfort', 'body', 'invest'];

describe('cleanTags', () => {
  it('keeps real goal ids in the goal list order', () => {
    expect(cleanTags(['invest', 'discomfort'], GOALS)).toEqual(['discomfort', 'invest']);
  });

  it('drops unknown ids, non-strings and duplicates', () => {
    expect(cleanTags(['body', 'body', 'nope', 5, null, { id: 'invest' }], GOALS)).toEqual(['body']);
  });

  it('drops ids of goals that no longer exist', () => {
    expect(cleanTags(['study', 'body'], GOALS)).toEqual(['body']);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(cleanTags(undefined, GOALS)).toEqual([]);
    expect(cleanTags('body', GOALS)).toEqual([]);
    expect(cleanTags({ body: true }, GOALS)).toEqual([]);
  });
});

describe('parseTagList', () => {
  it('splits a comma-separated list and ignores blanks', () => {
    expect(parseTagList('body, discomfort,,')).toEqual(['body', 'discomfort']);
    expect(parseTagList(null)).toEqual([]);
  });
});
