import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { defaultProgress, type Progress } from './progress';
import type { Prompt } from './challenges';

export interface VideoMeta {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  seenCount: number;
}

export interface Settings {
  /** show a challenge card after this many videos */
  interval: number;
  /** completions needed at a level before moving up */
  levelThreshold: number;
  muted: boolean;
}

export const defaultSettings = (): Settings => ({ interval: 7, levelThreshold: 5, muted: true });

interface Schema extends DBSchema {
  videos: { key: string; value: VideoMeta };
  // Blobs live in their own store so listing the library never loads video data.
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

const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function listVideos(): Promise<VideoMeta[]> {
  return (await (await getDb()).getAll('videos')).sort((a, b) => a.addedAt - b.addedAt);
}

/** Returns false if an identical file (same name and size) is already stored. */
export async function addVideo(file: File): Promise<boolean> {
  const d = await getDb();
  const existing = await d.getAll('videos');
  if (existing.some((v) => v.name === file.name && v.size === file.size)) return false;
  const id = uid();
  const tx = d.transaction(['videos', 'blobs'], 'readwrite');
  await Promise.all([
    tx.objectStore('blobs').put(file, id),
    tx.objectStore('videos').put({ id, name: file.name, size: file.size, addedAt: Date.now(), seenCount: 0 }),
    tx.done,
  ]);
  return true;
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  return (await getDb()).get('blobs', id);
}

export async function deleteVideo(id: string): Promise<void> {
  const tx = (await getDb()).transaction(['videos', 'blobs'], 'readwrite');
  await Promise.all([tx.objectStore('videos').delete(id), tx.objectStore('blobs').delete(id), tx.done]);
}

export async function markSeen(id: string): Promise<void> {
  const d = await getDb();
  const v = await d.get('videos', id);
  if (v) await d.put('videos', { ...v, seenCount: v.seenCount + 1 });
}

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
