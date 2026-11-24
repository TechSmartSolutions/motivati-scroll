import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Library } from './lib.mjs';
import { Suggester, cleanSuggestions, buildGuidance, cleanRegen, captionOf, SYSTEM_PROMPT, MAX_REGEN_CARDS, MAX_CARDS_PER_VIDEO } from './suggester.mjs';

const video = (id, extra = {}) => ({ id, name: `${id}.mp4`, kind: 'video', size: 1, addedAt: 1, file: `${id}.mp4`, transcript: 'done', tags: ['body'], ...extra });
const LONG = 'You have to stop waiting until you feel ready and take the first step today even if it is uncomfortable.';

async function setup(call, items, transcripts = {}, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sg-'));
  const lib = await new Library(dir).init();
  await lib.mutate((all) => void all.push(...items));
  const transcriber = { read: async (id) => (id in transcripts ? { text: transcripts[id] } : { text: LONG }) };
  const s = await new Suggester(lib, transcriber, { call, ...opts }).init();
  return { dir, lib, s };
}
const ok = (n = 1) => async () => ({
  challenges: Array.from({ length: n }, (_, i) => ({ level: 2, need: 'growth', text: `Do the first small step toward it now (${i}).` })),
});

describe('cleanSuggestions', () => {
  it('keeps valid items, drops junk and dedupes', () => {
    const raw = {
      challenges: [
        { level: 2, need: 'growth', text: 'Send the message you have been avoiding.' },
        { level: 2, need: 'growth', text: 'send the message you have been avoiding.' },
        { level: 9, need: 'growth', text: 'Level out of range so this is dropped.' },
        { level: 1, need: 'growth', text: 'short' },
        { level: 3, need: 'nonsense', text: 'Unknown need falls back to growth.' },
        { level: 4, need: 'connection', text: 'x'.repeat(301) },
        { level: 1, need: 'variety', text: 'Move your body for one full minute now.' },
        { level: 1, need: 'variety', text: 'A fourth valid one that must be cut off.' },
      ],
    };
    const out = cleanSuggestions(raw);
    expect(out).toHaveLength(4);
    expect(out[1]).toMatchObject({ level: 3, need: 'growth' });
  });
  it('survives garbage', () => {
    expect(cleanSuggestions(undefined)).toEqual([]);
    expect(cleanSuggestions({ challenges: 'nope' })).toEqual([]);
    expect(cleanSuggestions({ challenges: [null, 5, {}] })).toEqual([]);
  });
  it('tells the model to treat the transcript as data', () => {
    expect(SYSTEM_PROMPT).toMatch(/untrusted data/);
  });
});

describe('Suggester', () => {
  it('creates new suggestions and marks the video as done', async () => {
    const { dir, lib, s } = await setup(ok(2), [video('a')]);
    try {
      await s.kick();
      expect(s.list('new')).toHaveLength(2);
      expect(s.list('new')[0]).toMatchObject({ videoId: 'a', status: 'new' });
      expect(lib.get('a').suggested).toBe('done');
      expect(s.pending()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('waits for transcripts and skips ones that are too short without calling Claude', async () => {
    let calls = 0;
    const call = async () => (calls++, { challenges: [] });
    const { dir, lib, s } = await setup(call, [video('a', { transcript: undefined }), video('b')], { b: 'um' });
    try {
      await s.kick();
      expect(calls).toBe(0);
      expect(lib.get('b').suggested).toBe('done');
      expect(lib.get('a').suggested).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does nothing without a key', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sg-'));
    try {
      const lib = await new Library(dir).init();
      const s = await new Suggester(lib, { read: async () => ({ text: LONG }) }, {}).init();
      expect(s.status()).toMatchObject({ enabled: false, pending: 0 });
      expect(await s.kick()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('turns itself off on a rejected key', async () => {
    const call = async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); };
    const { dir, lib, s } = await setup(call, [video('a'), video('b')]);
    try {
      await s.kick();
      expect(s.enabled).toBe(false);
      expect(s.status().lastError).toContain('invalid x-api-key');
      expect(lib.get('a').suggested).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pauses on rate limits and retries later without losing the video', async () => {
    let n = 0;
    const call = async () => {
      if (n++ === 0) throw Object.assign(new Error('slow down'), { status: 429 });
      return { challenges: [{ level: 1, need: 'growth', text: 'Stand up and take ten deep breaths.' }] };
    };
    const { dir, lib, s } = await setup(call, [video('a'), video('b')]);
    try {
      await s.kick();
      expect(s.enabled).toBe(true);
      expect(lib.get('a').suggested).toBeUndefined();
      await s.kick();
      expect(lib.get('a').suggested).toBe('done');
      expect(lib.get('b').suggested).toBe('done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks a video skipped on refusal and failed after repeated errors', async () => {
    const call = async (text) => {
      if (text.includes('REFUSE')) throw Object.assign(new Error('declined'), { skip: true });
      throw new Error('bad json');
    };
    const { dir, lib, s } = await setup(call, [video('a'), video('b')], { a: `${LONG} REFUSE` });
    try {
      await s.kick();
      expect(lib.get('a').suggested).toBe('skipped');
      expect(lib.get('b').suggested).toBeUndefined();
      await s.kick();
      await s.kick();
      expect(lib.get('b').suggested).toBe('failed');
      expect(s.list('new')).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('accept, dismiss and the accepted list for the app', async () => {
    const { dir, s } = await setup(ok(2), [video('a')]);
    try {
      await s.kick();
      const [first, second] = s.list('new');
      expect(await s.accept(first.id)).toBe(true);
      expect(await s.dismiss(second.id)).toBe(true);
      expect(await s.accept('missing')).toBe(false);
      expect(s.list('new')).toHaveLength(0);
      const accepted = s.accepted();
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ id: `s-${first.id}`, level: 2, suggested: true, sourceVideoId: 'a' });
      // persists across restarts
      const again = await new Suggester(s.lib, s.transcriber, { call: ok() }).init();
      expect(again.accepted()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the video link once the source video is deleted', async () => {
    const { dir, lib, s } = await setup(ok(1), [video('a')]);
    try {
      await s.kick();
      await s.accept(s.list('new')[0].id);
      await lib.mutate(async (items) => void items.splice(0, 1));
      expect(s.accepted()[0].sourceVideoId).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const GOALS = { get: () => ({ goals: [
  { id: 'body', text: 'Fix my body', active: true, prompt: 'Use planks and bike work.' },
  { id: 'discomfort', text: 'Learn to love discomfort', active: true, prompt: 'Put me in the burn.' },
  { id: 'invest', text: 'Invest', active: false, prompt: '' },
] }) };

describe('buildGuidance', () => {
  const goals = GOALS.get().goals;
  it('includes the instructions of every tagged goal and only those', () => {
    const g = buildGuidance(goals, ['body', 'discomfort', 'invest']);
    expect(g).toContain('Use planks and bike work.');
    expect(g).toContain('Put me in the burn.');
    expect(g).not.toContain('Invest');
    expect(buildGuidance(goals, ['body'])).not.toContain('burn');
  });
  it('is empty when no tagged goal has instructions', () => {
    expect(buildGuidance(goals, ['invest'])).toBe('');
    expect(buildGuidance(goals, [])).toBe('');
    expect(buildGuidance(undefined, ['body'])).toBe('');
  });
  it('keeps the safety rules above the owner instructions', () => {
    expect(buildGuidance(goals, ['body'])).toMatch(/never override the safety/);
  });
});

describe('goal instructions in card writing', () => {
  it('waits for a video that has no goal tag yet', async () => {
    let calls = 0;
    const { dir, lib, s } = await setup(async () => (calls++, { challenges: [] }), [video('a', { tags: undefined }), video('b', { tags: [] })], {}, { goals: GOALS });
    try {
      expect(s.pending()).toHaveLength(0);
      await s.kick();
      expect(calls).toBe(0);
      expect(lib.get('a').suggested).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends the tagged goals instructions with the transcript', async () => {
    const seen = [];
    const call = async (text, guidance) => (seen.push(guidance), { challenges: [] });
    const { dir, s } = await setup(call, [video('a', { tags: ['body', 'discomfort'] })], {}, { goals: GOALS });
    try {
      await s.kick();
      expect(seen[0]).toContain('Use planks and bike work.');
      expect(seen[0]).toContain('Put me in the burn.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanRegen', () => {
  it('keeps only asked-for ids, once, with valid text', () => {
    const raw = { cards: [
      { id: 'a', level: 2, need: 'growth', text: 'Hold a wall sit until it burns, then 10 more seconds.' },
      { id: 'a', level: 2, need: 'growth', text: 'A duplicate id should be ignored entirely here.' },
      { id: 'zzz', level: 2, need: 'growth', text: 'An id we never asked about is dropped.' },
      { id: 'b', level: 9, need: 'growth', text: 'Level out of range is dropped.' },
    ] };
    const out = cleanRegen(raw, ['a', 'b']);
    expect([...out.keys()]).toEqual(['a']);
  });
});

describe('regenerate', () => {
  const NEWTXT = 'Hold a wall sit until it burns and stay ten seconds past the first urge to quit.';
  async function deck() {
    const regenCalls = [];
    const regen = async (req) => (regenCalls.push(req), { cards: [...req.user.matchAll(/"id":"([^"]+)"/g)].map((m) => ({ id: m[1], level: 2, need: 'growth', text: NEWTXT })) });
    const r = await setup(ok(2), [video('a', { tags: ['body', 'discomfort'] }), video('b')], {}, { goals: GOALS, regen });
    await r.s.kick();
    for (const x of r.s.list('new')) await r.s.accept(x.id);
    return { ...r, regenCalls };
  }

  it('rewrites all chosen cards in ONE call, with the goal instructions, as suggestions that replace the old card', async () => {
    const { dir, s, regenCalls } = await deck();
    try {
      const cards = s.accepted();
      expect(cards.length).toBeGreaterThan(1);
      const out = await s.regenerate(cards.map((c) => c.id));
      expect(regenCalls).toHaveLength(1);
      expect(regenCalls[0].system).toContain('Put me in the burn.');
      expect(out.created).toBe(cards.length);
      const fresh = s.list('new');
      expect(fresh).toHaveLength(cards.length);
      expect(fresh[0]).toMatchObject({ text: NEWTXT, status: 'new' });
      expect(fresh[0].replacesText).toBeTruthy();
      expect(s.accepted()).toHaveLength(cards.length); // deck unchanged until the user adds one
      await s.accept(fresh[0].id);
      const ids = s.accepted().map((c) => c.id);
      expect(ids).toContain(`s-${fresh[0].id}`);
      expect(ids).not.toContain(`s-${fresh[0].replaces}`);
      expect(s.accepted()).toHaveLength(cards.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the old card when the rewrite is dismissed, and keeps one pending rewrite per card', async () => {
    const { dir, s } = await deck();
    try {
      const [card] = s.accepted();
      await s.regenerate([card.id]);
      await s.regenerate([card.id]);
      expect(s.list('new')).toHaveLength(1);
      await s.dismiss(s.list('new')[0].id);
      expect(s.accepted().map((c) => c.id)).toContain(card.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses empty and oversized picks, and reports cards it cannot rewrite', async () => {
    const { dir, s } = await deck();
    try {
      await expect(s.regenerate([])).rejects.toMatchObject({ status: 400 });
      await expect(s.regenerate(Array.from({ length: MAX_REGEN_CARDS + 1 }, (_, i) => `x${i}`))).rejects.toMatchObject({ status: 400 });
      expect(await s.regenerate(['nope'])).toEqual({ created: 0, skipped: [{ id: 'nope', why: 'Not in your deck' }] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is unavailable without a key', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sg-'));
    try {
      const lib = await new Library(dir).init();
      const s = await new Suggester(lib, { read: async () => ({ text: LONG }) }, {}).init();
      await expect(s.regenerate(['a'])).rejects.toMatchObject({ status: 503 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanSuggestions cap', () => {
  it('lets one video return a full set per exercise, and no more than the cap', () => {
    const many = { challenges: Array.from({ length: MAX_CARDS_PER_VIDEO + 6 }, (_, i) => ({ level: 2, need: 'growth', text: `Do exercise number ${i} for the full count now.` })) };
    expect(MAX_CARDS_PER_VIDEO).toBeGreaterThanOrEqual(20);
    expect(cleanSuggestions(many)).toHaveLength(MAX_CARDS_PER_VIDEO);
  });
});

describe('captionOf', () => {
  it('drops the counts and the extension', () => {
    expect(captionOf('3.5K views · 71 reactions Single-leg eccentric fitball curls for hamstring strength.mp4')).toBe('Single-leg eccentric fitball curls for hamstring strength');
    expect(captionOf('Kill your laziness..mp4')).toBe('Kill your laziness.');
  });
  it('is empty when there is nothing useful', () => {
    expect(captionOf('2.8K views · 20 reactions Kata Banhegyi on Reels.mp4')).toBe('');
    expect(captionOf('a.mp4')).toBe('');
    expect(captionOf(undefined)).toBe('');
  });
});

describe('silent clips with a caption', () => {
  it('are written up from the caption instead of being skipped', async () => {
    const seen = [];
    const call = async (text, guidance, caption) => (seen.push({ text, caption }), { challenges: [] });
    const { dir, lib, s } = await setup(call, [video('a', { name: '3.5K views · 71 reactions Single-leg eccentric fitball curls for hamstring strength.mp4' }), video('b')], { a: '', b: '' }, { goals: GOALS });
    try {
      await s.kick();
      expect(seen).toEqual([{ text: '', caption: 'Single-leg eccentric fitball curls for hamstring strength' }]);
      expect(lib.get('a').suggested).toBe('done');
      expect(lib.get('b').suggested).toBe('done'); // no speech and no caption: skipped without a call
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cards follow their video', () => {
  it('dropVideo hides that video\'s deck and waiting cards and leaves others alone', async () => {
    const { dir, s } = await setup(ok(2), [video('a'), video('b')], {}, { goals: GOALS });
    try {
      await s.kick();
      const [first] = s.list('new');
      await s.accept(first.id);
      expect(s.accepted().length).toBe(1);
      expect(await s.dropVideo(first.videoId)).toBe(s.items.filter((x) => x.videoId === first.videoId).length);
      expect(s.accepted().filter((c) => c.sourceVideoId === first.videoId)).toHaveLength(0);
      expect(s.list('new').filter((c) => c.videoId === first.videoId)).toHaveLength(0);
      const other = ['a', 'b'].find((id) => id !== first.videoId);
      expect(s.list('new').filter((c) => c.videoId === other).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dropOrphans hides cards whose video is gone', async () => {
    const { dir, lib, s } = await setup(ok(2), [video('a'), video('b')], {}, { goals: GOALS });
    try {
      await s.kick();
      await lib.mutate(async (items) => void items.splice(items.findIndex((x) => x.id === 'a'), 1));
      const n = await s.dropOrphans();
      expect(n).toBe(2);
      expect(s.list('new').every((c) => c.videoId === 'b')).toBe(true);
      expect(await s.dropOrphans()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
