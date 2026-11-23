import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { defaultProgress, type Progress } from './progress';
import type { Prompt } from './challenges';

export interface Settings {
  /** show a challenge card after this many videos or images */
  interval: number;
  /** completions needed at a level before moving up */
  levelThreshold: number;
  muted: boolean;
}

export const defaultSettings = (): Settings => ({ interval: 7, levelThreshold: 5, muted: true });

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

export const getSettings = async (): Promise<Settings> => ({ ...defaultSettings(), ...(await kvGet<Partial<Settings>>('settings', {})) });
export const saveSettings = (s: Settings) => kvSet('settings', s);
export const getProgress = async (): Promise<Progress> => ({ ...defaultProgress(), ...(await kvGet<Partial<Progress>>('progress', {})) });
export const saveProgress = (p: Progress) => kvSet('progress', p);
export const getCustomPrompts = () => kvGet<Prompt[]>('customPrompts', []);
export const saveCustomPrompts = (p: Prompt[]) => kvSet('customPrompts', p);
export const getSinceChallenge = () => kvGet<number>('sinceChallenge', 0);
export const saveSinceChallenge = (n: number) => kvSet('sinceChallenge', n);
