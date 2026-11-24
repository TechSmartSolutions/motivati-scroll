import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { defaultProgress, type Progress } from './progress';
import type { Prompt } from './challenges';
import { emptyToday, type TodayList } from './today';

export interface Settings {
  /** show a challenge card after this many videos or images */
  interval: number;
  /** completions needed at a level before moving up */
  levelThreshold: number;
  muted: boolean;
  /** move to the next item automatically when a video ends */
  autoAdvance: boolean;
  /** Narrow the feed to this one goal (an active goal's id), or null for all active goals. Per device. */
  feedGoal: string | null;
}

export const defaultSettings = (): Settings => ({ interval: 7, levelThreshold: 5, muted: false, autoAdvance: true, feedGoal: null });

interface Schema extends DBSchema {
  // Media now lives on the home server. These two stores are left from the on-device version
  // so existing installs open cleanly; nothing reads or writes them any more.
  videos: { key: string; value: unknown };
  blobs: { key: string; value: Blob };
  kv: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | undefined;
const getDb = () =>
  (dbp ??= openDB<Schema>('motivati-scroll', 1, {
    upgrade(d) {
      d.createObjectStore('videos', { keyPath: 'id' });
      d.createObjectStore('blobs');
      d.createObjectStore('kv');
    },
  }));

async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const v = await (await getDb()).get('kv', key);
  return (v as T | undefined) ?? fallback;
}
const kvSet = async (key: string, value: unknown) => void (await (await getDb()).put('kv', value, key));

// Settings version 2: sound is on by default. Older saved settings had muted:true as the default,
// so a missing/older version ignores the stored value once. Turning it off again in the menu sticks.
const SETTINGS_VERSION = 2;
type StoredSettings = Partial<Settings> & { v?: number };

export const getSettings = async (): Promise<Settings> => {
  const { v, ...saved } = await kvGet<StoredSettings>('settings', {});
  if (v !== SETTINGS_VERSION) delete saved.muted;
  return { ...defaultSettings(), ...saved };
};
export const saveSettings = (s: Settings) => kvSet('settings', { ...s, v: SETTINGS_VERSION });
export const getProgress = async (): Promise<Progress> => ({ ...defaultProgress(), ...(await kvGet<Partial<Progress>>('progress', {})) });
export const saveProgress = (p: Progress) => kvSet('progress', p);
export const getToday = async (): Promise<TodayList> => ({ ...emptyToday(), ...(await kvGet<Partial<TodayList>>('today', {})) });
export const saveToday = (t: TodayList) => kvSet('today', t);
export const getGoal =() => kvGet<string>('goal', '');
export const saveGoal = (g: string) => kvSet('goal', g);
export const getCustomPrompts = () => kvGet<Prompt[]>('customPrompts', []);
export const saveCustomPrompts = (p: Prompt[]) => kvSet('customPrompts', p);
export const getSinceChallenge = () => kvGet<number>('sinceChallenge', 0);
export const saveSinceChallenge = (n: number) => kvSet('sinceChallenge', n);
