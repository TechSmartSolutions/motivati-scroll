import { dateKey } from './progress';
import type { Prompt } from './challenges';

/** A challenge the user committed to on "today's list". It stays until it is done or consciously dropped. */
export interface TodayItem {
  id: string;
  promptId: string;
  /** The exact text shown on the card (goal wording already filled in). */
  text: string;
  level: number;
  need?: string;
  done: boolean;
  addedAt: number;
  /** Local day the user committed to it, YYYY-MM-DD. Older than today means it carried over. */
  addedDate: string;
}

export interface TodayList {
  /** Local day this list was last rolled to, YYYY-MM-DD. */
  date: string;
  items: TodayItem[];
}

export const emptyToday = (now: Date = new Date()): TodayList => ({ date: dateKey(now), items: [] });

/**
 * Same object while it is still the same day. On a new day, finished items are cleared and
 * UNFINISHED ones carry over: you said you would do them, so they stay until you do or drop them.
 */
export function rollover(list: TodayList, now: Date = new Date()): TodayList {
  if (list.date === dateKey(now)) return list;
  return { date: dateKey(now), items: list.items.filter((i) => !i.done) };
}

/** Whole days between the day it was committed to and `now` (0 = today). */
export function daysOld(item: TodayItem, now: Date = new Date()): number {
  const [y, m, d] = (item.addedDate ?? dateKey(now)).split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

export function ageLabel(days: number): string {
  if (days <= 0) return '';
  return days === 1 ? 'from yesterday' : `from ${days} days ago`;
}

export const hasItem = (list: TodayList, p: Pick<Prompt, 'id' | 'text'>): boolean =>
  list.items.some((i) => i.promptId === p.id && i.text === p.text);

export function addItem(list: TodayList, p: Prompt, now: Date = new Date()): { list: TodayList; added: boolean } {
  if (hasItem(list, p)) return { list, added: false };
  const item: TodayItem = {
    id: `t-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    promptId: p.id,
    text: p.text,
    level: p.level,
    need: p.need,
    done: false,
    addedAt: now.getTime(),
    addedDate: dateKey(now),
  };
  return { list: { ...list, items: [...list.items, item] }, added: true };
}

export const markDone = (list: TodayList, id: string): TodayList => ({
  ...list,
  items: list.items.map((i) => (i.id === id ? { ...i, done: true } : i)),
});

/** When a card is completed directly, tick off the matching entry so it is never counted twice. */
export function markDoneForPrompt(list: TodayList, p: Pick<Prompt, 'id' | 'text'>): TodayList {
  return {
    ...list,
    items: list.items.map((i) => (i.promptId === p.id && i.text === p.text ? { ...i, done: true } : i)),
  };
}

export const removeItem = (list: TodayList, id: string): TodayList => ({
  ...list,
  items: list.items.filter((i) => i.id !== id),
});

export const counts = (list: TodayList): { done: number; total: number } => ({
  done: list.items.filter((i) => i.done).length,
  total: list.items.length,
});

/** How many unfinished items carried over from an earlier day. */
export const overdueCount = (list: TodayList, now: Date = new Date()): number =>
  list.items.filter((i) => !i.done && daysOld(i, now) > 0).length;
