import builtin from './prompts.json';

export interface Prompt {
  id: string;
  level: number;
  need?: string;
  text: string;
  custom?: boolean;
}

export const builtinPrompts: Prompt[] = builtin as Prompt[];

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
