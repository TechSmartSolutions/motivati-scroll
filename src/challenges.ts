import builtin from './prompts.json';

export interface Prompt {
  id: string;
  level: number;
  need?: string;
  /** May contain {goal}, replaced with the user's goal. Such prompts are hidden until a goal is set. */
  text: string;
  /** Helps the user find a goal. Only shown while no goal is set. */
  discovery?: boolean;
  custom?: boolean;
  /** Drafted by Claude from a saved video and approved by the user. */
  suggested?: boolean;
  /** The library video this challenge came from, if it still exists. */
  sourceVideoId?: string;
}

export const builtinPrompts: Prompt[] = builtin as Prompt[];

export const usesGoal = (p: Prompt): boolean => p.text.includes('{goal}');

export interface Goal {
  id: string;
  text: string;
  /** Active goals (starred) drive the feed and the challenges. Parked goals are kept but ignored. */
  active: boolean;
  /** The owner's instructions to Claude for writing cards under this goal. */
  prompt: string;
}

export interface GoalSet {
  goals: Goal[];
}

/** Prompts that make sense for the current goal state. */
export function availablePrompts(all: Prompt[], hasGoal: boolean): Prompt[] {
  return all.filter((p) => (hasGoal ? !p.discovery : !usesGoal(p)));
}

export const withGoal = (p: Prompt, goal: string): Prompt => ({ ...p, text: p.text.replaceAll('{goal}', goal.trim()) });

/** Choose which goal a challenge talks about: one of the active goals, evenly. With none active, any goal (so cards never go blank). */
export function pickGoal(set: GoalSet, rand: () => number = Math.random): string | undefined {
  const active = set.goals.filter((g) => g.active);
  const pool = active.length ? active : set.goals;
  if (!pool.length) return undefined;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))].text;
}

/** Pick a random prompt at `level`, avoiding `excludeId` when alternatives exist. Falls back to nearby levels. */
export function pickPrompt(
  all: Prompt[],
  level: number,
  excludeId?: string,
  rand: () => number = Math.random,
): Prompt | undefined {
  for (const lv of [level, level - 1, level + 1, level - 2, level + 2]) {
    const pool = all.filter((p) => p.level === lv);
    if (!pool.length) continue;
    const choices = pool.length > 1 ? pool.filter((p) => p.id !== excludeId) : pool;
    return choices[Math.floor(rand() * choices.length)];
  }
  return undefined;
}
