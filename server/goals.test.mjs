import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Goals, cleanGoals, MAX_GOALS, STARTER_GOALS } from './goals.mjs';

let n = 0;
const id = () => `new-${++n}`;

describe('cleanGoals', () => {
  it('assigns ids to new goals and keeps existing ids', () => {
    const out = cleanGoals({ goals: [{ id: 'keep', text: 'Get fit', active: false }, { text: 'Save money' }] }, id);
    expect(out.goals[0]).toEqual({ id: 'keep', text: 'Get fit', active: false, prompt: '' });
    expect(out.goals[1].id).toMatch(/^new-/);
    expect(out.goals[1].active).toBe(true);
  });

  it('allows up to 10 goals and drops the rest', () => {
    expect(MAX_GOALS).toBe(10);
    const out = cleanGoals({ goals: Array.from({ length: 12 }, (_, i) => ({ text: `g${i}` })) }, id);
    expect(out.goals).toHaveLength(10);
    expect(out.goals[9].text).toBe('g9');
  });

  it('drops blanks, trims, collapses spaces and limits length', () => {
    const out = cleanGoals({ goals: [{ text: '   ' }, { text: '  Get   strong  ' }, { text: 5 }, { text: 'x'.repeat(500) }] }, id);
    expect(out.goals).toHaveLength(2);
    expect(out.goals[0].text).toBe('Get strong');
    expect(out.goals[1].text).toHaveLength(200);
  });

  it('replaces duplicate or malformed ids', () => {
    const out = cleanGoals({ goals: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }, { id: '../x', text: 'three' }] }, id);
    expect(new Set(out.goals.map((g) => g.id)).size).toBe(3);
    expect(out.goals.map((g) => g.id)).not.toContain('../x');
  });

  it('returns an empty list for anything unusable', () => {
    expect(cleanGoals({ goals: [] }, id)).toEqual({ goals: [] });
    expect(cleanGoals(undefined, id)).toEqual({ goals: [] });
  });
});

describe('Goals store', () => {
  it('persists across restarts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goals-'));
    try {
      const g = await new Goals(dir).init();
      expect(g.get()).toEqual({ goals: [] });
      const saved = await g.set({ goals: [{ text: 'Get fit' }, { text: 'Earn more', active: false }] });
      const again = await new Goals(dir).init();
      expect(again.get()).toEqual(saved);
      expect(again.get().goals).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('moves the old focus-goal format onto the four starter goals, keeping a backup', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goals-'));
    try {
      await fsp.writeFile(path.join(dir, 'goals.json'), JSON.stringify({ goals: [{ id: 'x', text: 'Get fitter' }], focusId: 'x' }));
      const g = await new Goals(dir).init();
      expect(g.get().goals.map((x) => [x.id, x.active])).toEqual([['discomfort', true], ['body', true], ['invest', false], ['study', false]]);
      expect(JSON.parse(await fsp.readFile(path.join(dir, 'goals.json.before-active'), 'utf8')).focusId).toBe('x');
      const again = await new Goals(dir).init();
      expect(again.get()).toEqual(g.get());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not bring the starter goals back after you clear them all', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goals-'));
    try {
      const g = await new Goals(dir).init();
      await g.set({ goals: [] });
      expect((await new Goals(dir).init()).get()).toEqual({ goals: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('goal instructions (prompt)', () => {
  it('keeps and trims the prompt, caps its length, and defaults to empty', () => {
    const out = cleanGoals({ goals: [{ text: 'a', prompt: '  Put me in the burn.  ' }, { text: 'b' }, { text: 'c', prompt: 'x'.repeat(5000) }] }, id);
    expect(out.goals[0].prompt).toBe('Put me in the burn.');
    expect(out.goals[1].prompt).toBe('');
    expect(out.goals[2].prompt).toHaveLength(1500);
  });

  it('fills starter instructions for the four known goals saved without any', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goals-'));
    try {
      await fsp.writeFile(path.join(dir, 'goals.json'), JSON.stringify({ goals: [{ id: 'body', text: 'Fix my body', active: true }, { id: 'mine', text: 'Mine', active: true }] }));
      const g = await new Goals(dir).init();
      expect(g.get().goals[0].prompt).toBe(STARTER_GOALS.find((s) => s.id === 'body').prompt);
      expect(g.get().goals[1].prompt).toBe('');
      expect(JSON.parse(await fsp.readFile(path.join(dir, 'goals.json'), 'utf8')).goals[0].prompt).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite instructions the user already edited, even empty ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goals-'));
    try {
      await fsp.writeFile(path.join(dir, 'goals.json'), JSON.stringify({ goals: [{ id: 'body', text: 'Fix my body', active: true, prompt: '' }] }));
      expect((await new Goals(dir).init()).get().goals[0].prompt).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
