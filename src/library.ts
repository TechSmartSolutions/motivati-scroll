// Client for the home-server media library (served from the same origin as the app).
import type { GoalSet, Prompt } from './challenges';

export interface MediaItem {
  id: string;
  name: string;
  kind: 'video' | 'image';
  size: number;
  addedAt: number;
  url: string;
  /** Favorites come up more often in the feed. Shared across devices. */
  favorite?: boolean;
  /** Goals this file is filed under (goal ids). Empty or missing means untagged. */
  tags?: string[];
  /** videos only: server-side speech-to-text state */
  transcript?: 'pending' | 'done' | 'failed';
}

export interface TranscriberStatus {
  enabled: boolean;
  model: string;
  working: boolean;
  current: string | null;
  pending: number;
  done: number;
  failed: number;
  lastError: string | null;
}

/** Goals live on the server so every device shares them. Returns undefined when the server can't be reached. */
export async function getGoals(): Promise<GoalSet | undefined> {
  try {
    const res = await fetch('/api/goals', { cache: 'no-store' });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export async function saveGoals(input: { goals: { id?: string; text: string; active: boolean; prompt: string }[] }): Promise<GoalSet> {
  const res = await fetch('/api/goals', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ServerError(`Could not save goals (${res.status})`, res.status);
  return res.json();
}

export interface Suggestion {
  id: string;
  videoId: string;
  videoName: string;
  level: number;
  need: string;
  text: string;
  /** Set when this is a rewrite of a card already in the deck: that card's current text. */
  replacesText?: string;
}

export interface SuggestionsResponse {
  status: { enabled: boolean; model: string; pending: number; new: number; lastError: string | null };
  items: Suggestion[];
}

export async function getSuggestions(): Promise<SuggestionsResponse | undefined> {
  try {
    const res = await fetch('/api/suggestions', { cache: 'no-store' });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export async function answerSuggestion(id: string, action: 'accept' | 'dismiss'): Promise<void> {
  const res = await fetch(`/api/suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  if (!res.ok && res.status !== 404) throw new ServerError(`Could not ${action} (${res.status})`, res.status);
}

/** Rewrite the chosen deck cards with Claude in one call. The rewrites arrive as suggestions to approve. */
export async function regenerateCards(ids: string[]): Promise<{ created: number; skipped: { id: string; why: string }[] }> {
  const res = await fetch('/api/challenges/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    let msg = `Could not rewrite the cards (${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* keep default */
    }
    throw new ServerError(msg, res.status);
  }
  return res.json();
}

/** Challenges the user approved from Claude's suggestions, shared by every device. Empty when offline. */
export async function listAcceptedChallenges(): Promise<Prompt[]> {
  try {
    const res = await fetch('/api/challenges', { cache: 'no-store' });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function getTranscriberStatus(): Promise<TranscriberStatus | undefined> {
  try {
    const res = await fetch('/api/transcriber', { cache: 'no-store' });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export class ServerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function listMedia(): Promise<MediaItem[]> {
  const res = await fetch('/api/library', { cache: 'no-store' });
  if (!res.ok) throw new ServerError(`Library request failed (${res.status})`, res.status);
  return res.json();
}

export const isMediaFile = (f: File) =>
  f.type.startsWith('video/') || f.type.startsWith('image/') || /\.(mp4|m4v|mov|webm|jpe?g|png|gif|webp|avif|heic)$/i.test(f.name);

/**
 * Upload one file. Uses XHR because fetch has no upload progress.
 * Resolves to the new item, or 'duplicate' if the same name and size is already stored.
 */
export function uploadMedia(file: File, onProgress?: (fraction: number) => void, tags: string[] = []): Promise<MediaItem | 'duplicate'> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/media?name=${encodeURIComponent(file.name)}${tags.length ? `&tags=${encodeURIComponent(tags.join(','))}` : ''}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 201) return resolve(JSON.parse(xhr.responseText));
      if (xhr.status === 409) return resolve('duplicate');
      let msg = `Upload failed (${xhr.status})`;
      try {
        msg = JSON.parse(xhr.responseText).error ?? msg;
      } catch {
        /* keep default */
      }
      reject(new ServerError(msg, xhr.status));
    };
    xhr.onerror = () => reject(new ServerError('Could not reach the server', 0));
    xhr.send(file);
  });
}

export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/favorite`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite }),
  });
  if (!res.ok) throw new ServerError(`Could not save favorite (${res.status})`, res.status);
}

export async function setTags(id: string, tags: string[]): Promise<string[]> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) throw new ServerError(`Could not save tags (${res.status})`, res.status);
  return (await res.json()).tags;
}

export async function deleteMedia(id: string): Promise<void> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new ServerError(`Delete failed (${res.status})`, res.status);
}

export interface DownloadJob {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'done' | 'duplicate' | 'error';
  progress: number;
  message: string;
}

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return res.json();
  let msg = `${fallback} (${res.status})`;
  try {
    msg = (await res.json()).error ?? msg;
  } catch {
    /* keep default */
  }
  throw new ServerError(msg, res.status);
}

/** Ask the server to download the public Facebook reel link(s) in `text` into the library. */
export async function submitLinks(text: string): Promise<DownloadJob[]> {
  const res = await fetch('/api/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  return jsonOrThrow(res, 'Could not start the download');
}

export async function listDownloads(): Promise<DownloadJob[]> {
  return jsonOrThrow(await fetch('/api/downloads', { cache: 'no-store' }), 'Could not read downloads');
}

export async function updateDownloader(): Promise<{ ok: boolean; before: string | null; after: string | null; updated: boolean }> {
  return jsonOrThrow(await fetch('/api/downloader/update', { method: 'POST' }), 'Update failed');
}

export async function repairVideos(): Promise<{ started: boolean }> {
  return jsonOrThrow(await fetch('/api/library/repair', { method: 'POST' }), 'Could not start the fix');
}

export async function downloaderVersion(): Promise<string | null> {
  return (await jsonOrThrow<{ version: string | null }>(await fetch('/api/downloader', { cache: 'no-store' }), 'Version check failed')).version;
}

/**
 * What the feed may show: files with no goal yet, or filed under at least one active goal.
 * With `onlyGoal`, just the files filed under that one goal (files with no goal are hidden).
 */
export function feedVisible(items: MediaItem[], goals: { id: string; active: boolean }[], onlyGoal?: string | null): MediaItem[] {
  if (onlyGoal) return items.filter((v) => v.tags?.includes(onlyGoal));
  const active = new Set(goals.filter((g) => g.active).map((g) => g.id));
  return items.filter((v) => !v.tags?.length || v.tags.some((t) => active.has(t)));
}

const STATS_PREFIX = /^((?:[\d.,]+[KM]?\s*(?:views|reactions|shares|comments)(?:\s*·\s*)?)+)\s*/i;
const LABEL_CHARS = 14;

/**
 * A short label to tell videos apart: the reactions count from the file name (or views, or shares) and the first
 * few characters of the title. The same label is shown on the feed and in the settings list.
 */
export function videoLabel(name: string): { count: string; text: string; full: string } {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/\s+/g, ' ').trim();
  const m = STATS_PREFIX.exec(base);
  const prefix = m?.[1] ?? '';
  const rest = base.slice(m?.[0].length ?? 0).trim();
  const num = (word: string) => new RegExp(`([\\d.,]+[KM]?)\\s*${word}`, 'i').exec(prefix)?.[1];
  const reactions = num('reactions');
  const views = num('views');
  const shares = num('shares');
  const count = reactions ? `👍 ${reactions}` : views ? `▶ ${views}` : shares ? `↗ ${shares}` : '';
  // Hashtags make poor labels; use them only when the title is nothing but hashtags.
  const words = rest.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim() || rest.replace(/#/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(words);
  const text = chars.length > LABEL_CHARS ? `${chars.slice(0, LABEL_CHARS).join('').trimEnd()}…` : words;
  return { count, text, full: [count, text].filter(Boolean).join(' · ') };
}
