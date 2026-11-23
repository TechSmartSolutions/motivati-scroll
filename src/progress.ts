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
  level: number;
  doneAtLevel: number;
  totalDone: number;
  /** completions per local day, keyed YYYY-MM-DD */
  days: Record<string, number>;
}

export const defaultProgress = (): Progress => ({ level: 1, doneAtLevel: 0, totalDone: 0, days: {} });

export function dateKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Log one completed challenge. Levels up after `threshold` completions at the current level. */
export function recordDone(
  p: Progress,
  threshold: number,
  now: Date = new Date(),
): { progress: Progress; leveledUp: boolean } {
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
