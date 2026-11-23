// Client for the home-server media library (served from the same origin as the app).

export interface MediaItem {
  id: string;
  name: string;
  kind: 'video' | 'image';
  size: number;
  addedAt: number;
  url: string;
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
export function uploadMedia(file: File, onProgress?: (fraction: number) => void): Promise<MediaItem | 'duplicate'> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/media?name=${encodeURIComponent(file.name)}`);
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

export async function downloaderVersion(): Promise<string | null> {
  return (await jsonOrThrow<{ version: string | null }>(await fetch('/api/downloader', { cache: 'no-store' }), 'Version check failed')).version;
}
