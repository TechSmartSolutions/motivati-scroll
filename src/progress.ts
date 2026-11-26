export const MAX_LEVEL = 4;
export const LEVEL_NAMES = ['', 'Spark', 'Nudge', 'Stretch', 'Leap'] as const;
export const LEVEL_HINTS = [
  '',
  'Under 2 minutes. Change your state.',
  'Small discomfort. Do the thing you avoid.',
  'A real stretch. One new action today.',
  'Massive action. The scary, important step.',
] as const;

export interface Progress {
  /** Today's level. It starts every day at 1 and only goes up by finishing cards today. */
  level: number;
  /** Cards finished at today's level. Starts at 0 every day. */
  doneAtLevel: number;
  /** The day (YYYY-MM-DD) that `level` and `doneAtLevel` belong to. */
  levelDay: string;
  totalDone: number;
  /** completions per local day, keyed YYYY-MM-DD */
  days: Record<string, number>;
}

export const defaultProgress = (): Progress => ({ level: 1, doneAtLevel: 0, levelDay: dateKey(), totalDone: 0, days: {} });

export function dateKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Every day starts again at level 1 with the counter at zero: if you cannot get through the level 1 cards
 * today you should not be on level 2. Returns the same object when it is already today's.
 */
export function rollDay(p: Progress, now: Date = new Date()): Progress {
  const key = dateKey(now);
  return p.levelDay === key ? p : { ...p, level: 1, doneAtLevel: 0, levelDay: key };
}

/** Log one completed challenge. Levels up after `threshold` completions at today's level; a new day starts over at level 1. */
export function recordDone(
  prev: Progress,
  threshold: number,
  now: Date = new Date(),
): { progress: Progress; leveledUp: boolean } {
  const p = rollDay(prev, now);
  const key = dateKey(now);
  const next: Progress = {
    ...p,
    totalDone: p.totalDone + 1,
    doneAtLevel: p.doneAtLevel + 1,
    days: { ...p.days, [key]: (p.days[key] ?? 0) + 1 },
  };
  let leveledUp = false;
  if (next.doneAtLevel >= threshold && next.level < MAX_LEVEL) {
    next.level += 1;
    next.doneAtLevel = 0;
    leveledUp = true;
  }
  return { progress: next, leveledUp };
}

export function stepLevel(p: Progress, delta: number): Progress {
  const level = Math.min(MAX_LEVEL, Math.max(1, p.level + delta));
  return level === p.level ? p : { ...p, level, doneAtLevel: 0 };
}

/** Consecutive days with at least one completion, ending today (or yesterday if today has none yet). */
export function streak(p: Progress, now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!p.days[dateKey(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (p.days[dateKey(d)]) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
