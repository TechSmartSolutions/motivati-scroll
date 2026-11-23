import { h, formatBytes } from './dom';
import * as db from './db';
import { deleteMedia, isMediaFile, listDownloads, listMedia, submitLinks, updateDownloader, uploadMedia, type DownloadJob, type MediaItem } from './library';
import { LEVEL_NAMES, MAX_LEVEL, dateKey, streak, type Progress } from './progress';
import type { Prompt } from './challenges';

export interface PanelCtx {
  settings(): db.Settings;
  progress(): Progress;
  custom(): Prompt[];
  updateSettings(patch: Partial<db.Settings>): Promise<void>;
  shiftLevel(delta: number): Promise<void>;
  addCustom(text: string, level: number): Promise<void>;
  removeCustom(id: string): Promise<void>;
  close(): void;
}

export class Panel {
  readonly root = h('div', { class: 'panel', hidden: true });
  private status = '';
  private linkStatus = '';
  private poll?: number;
  private sawActive = false;
  private dlBox = h('ul', { class: 'list' });

  constructor(private ctx: PanelCtx) {}

  async open(): Promise<void> {
    this.root.hidden = false;
    await this.render();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private async importFiles(files: File[]): Promise<void> {
    const media = files.filter(isMediaFile);
    if (!media.length) return;
    let added = 0;
    let skipped = 0;
    for (let i = 0; i < media.length; i++) {
      const label = `Uploading ${i + 1} of ${media.length}`;
      this.status = `${label}…`;
      this.setStatus();
      try {
        const r = await uploadMedia(media[i], (f) => {
          this.status = `${label}: ${Math.round(f * 100)}%`;
          this.setStatus();
        });
        if (r === 'duplicate') skipped++;
        else added++;
      } catch (e) {
        this.status = `Could not upload ${media[i].name}: ${(e as Error).message}`;
        console.error(e);
        await this.render();
        return;
      }
    }
    this.status = `Added ${added}${skipped ? `, skipped ${skipped} duplicate${skipped > 1 ? 's' : ''}` : ''}.`;
    await this.render();
  }

  private paintDownloads(jobs: DownloadJob[]): void {
    const label = (j: DownloadJob) =>
      j.status === 'downloading' ? `Downloading ${Math.round(j.progress * 100)}%` : j.status === 'queued' ? 'Waiting' : j.message;
    this.dlBox.replaceChildren(...jobs.slice(-5).reverse().map((j) =>
      h('li', {}, h('span', { class: 'name' }, j.url.replace(/^https:\/\/(www\.)?/, '')), h('span', { class: 'muted' }, label(j)))));
  }

  /** Poll the server while any download is running; refresh the library list once they finish. */
  private async watchDownloads(): Promise<void> {
    window.clearTimeout(this.poll);
    let jobs: DownloadJob[];
    try {
      jobs = await listDownloads();
    } catch {
      return;
    }
    this.paintDownloads(jobs);
    if (jobs.some((j) => j.status === 'queued' || j.status === 'downloading')) {
      this.sawActive = true;
      this.poll = window.setTimeout(() => void this.watchDownloads(), 1500);
    } else if (this.sawActive && !this.root.hidden) {
      this.sawActive = false;
      this.linkStatus = '';
      await this.render();
    }
  }

  private async addLink(text: string, offline: boolean): Promise<void> {
    if (offline || !text.trim()) return;
    try {
      this.paintDownloads(await submitLinks(text));
      this.linkStatus = 'Started. Large reels can take a minute.';
      this.root.querySelector('.link-status')!.textContent = this.linkStatus;
      void this.watchDownloads();
    } catch (e) {
      this.linkStatus = (e as Error).message;
      this.root.querySelector('.link-status')!.textContent = this.linkStatus;
    }
  }

  private setStatus(): void {
    const el = this.root.querySelector('.status');
    if (el) el.textContent = this.status;
  }

  private async render(): Promise<void> {
    let items: MediaItem[] = [];
    let offline = false;
    try {
      items = await listMedia();
    } catch {
      offline = true;
    }
    const used = items.reduce((n, v) => n + v.size, 0);
    const p = this.ctx.progress();
    const s = this.ctx.settings();
    const today = p.days[dateKey()] ?? 0;

    const linkInput = h('input', { type: 'url', placeholder: 'Paste a public Facebook reel link', class: 'link-input', autocomplete: 'off' });
    const input = h('input', { type: 'file', accept: 'video/*,image/*', multiple: true, hidden: true });
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      void this.importFiles(files);
    });

    const num = (label: string, value: number, min: number, max: number, key: 'interval' | 'levelThreshold') =>
      h('label', { class: 'row' }, h('span', {}, label),
        h('input', { type: 'number', inputmode: 'numeric', min, max, value, onchange: (e: Event) => {
          const n = Math.min(max, Math.max(min, Number((e.target as HTMLInputElement).value) || value));
          void this.ctx.updateSettings({ [key]: n });
        } }));

    const textarea = h('textarea', { rows: 2, placeholder: 'Write your own challenge…' });
    const levelSel = h('select', {}, ...[1, 2, 3, 4].map((l) => h('option', { value: l }, `Level ${l} · ${LEVEL_NAMES[l]}`)));

    const sections = [
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Motivati-scroll'),
        h('button', { class: 'btn ghost', onclick: () => this.ctx.close() }, 'Close')),

      h('section', {},
        h('h3', {}, `Library (${items.length})`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: offline, onclick: () => input.click() }, 'Add videos or images'),
          h('span', { class: 'muted' }, offline ? 'Server not reachable' : `${formatBytes(used)} on your server`)),
        input,
        h('div', { class: 'status muted' }, this.status),
        linkInput,
        h('div', { class: 'row' },
          h('button', { class: 'btn small', disabled: offline, onclick: () => void this.addLink(linkInput.value, offline).then(() => (linkInput.value = '')) }, 'Download reel'),
          h('button', { class: 'btn ghost small', disabled: offline, onclick: async (e: Event) => {
            const b = e.target as HTMLButtonElement;
            b.disabled = true;
            b.textContent = 'Updating…';
            try {
              const r = await updateDownloader();
              this.linkStatus = !r.ok ? 'Update failed. Check the server logs.' : r.updated ? `Downloader updated to ${r.after}.` : `Downloader is up to date (${r.after}).`;
            } catch (err) {
              this.linkStatus = (err as Error).message;
            }
            this.root.querySelector('.link-status')!.textContent = this.linkStatus;
            b.disabled = false;
            b.textContent = 'Update downloader';
          } }, 'Update downloader')),
        h('div', { class: 'link-status muted' }, this.linkStatus),
        this.dlBox,
        h('div', { class: 'muted' }, 'Public Facebook reels only. The server is not logged in to Facebook, so private reels fail; upload those instead.'),
        h('ul', { class: 'list' }, ...items.map((v) =>
          h('li', {}, h('span', { class: 'name' }, v.name), h('span', { class: 'muted' }, `${v.kind === 'image' ? 'Image' : 'Video'} · ${formatBytes(v.size)}`),
            h('button', { class: 'btn ghost small', onclick: async () => {
              if (confirm(`Delete "${v.name}" from your server? It disappears on every device.`)) {
                try {
                  await deleteMedia(v.id);
                } catch (e) {
                  this.status = `Could not delete ${v.name}: ${(e as Error).message}`;
                }
                await this.render();
              }
            } }, 'Remove')))),
        items.length
          ? h('button', { class: 'btn ghost small', onclick: () => this.exportList(items.map((v) => v.name)) }, 'Export list of file names')
          : null),

      h('section', {},
        h('h3', {}, 'Your growth'),
        h('div', { class: 'stats' },
          stat(`${p.level}`, `Level · ${LEVEL_NAMES[p.level]}`),
          stat(`${p.doneAtLevel}/${s.levelThreshold}`, 'To next level'),
          stat(`${streak(p)}`, 'Day streak'),
          stat(`${today}`, 'Done today'),
          stat(`${p.totalDone}`, 'Total done')),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', disabled: p.level <= 1, onclick: () => void this.ctx.shiftLevel(-1).then(() => this.render()) }, 'Easier'),
          h('button', { class: 'btn small', disabled: p.level >= MAX_LEVEL, onclick: () => void this.ctx.shiftLevel(1).then(() => this.render()) }, 'Harder'))),

      h('section', {},
        h('h3', {}, 'Settings'),
        num('Challenge every N videos or images', s.interval, 2, 30, 'interval'),
        num('Completions to level up', s.levelThreshold, 1, 30, 'levelThreshold'),
        h('label', { class: 'row' }, h('span', {}, 'Start videos muted'),
          h('input', { type: 'checkbox', checked: s.muted, onchange: (e: Event) => void this.ctx.updateSettings({ muted: (e.target as HTMLInputElement).checked }) }))),

      h('section', {},
        h('h3', {}, 'Your own challenges'),
        textarea,
        h('div', { class: 'row' }, levelSel,
          h('button', { class: 'btn small', onclick: async () => {
            const t = textarea.value.trim();
            if (!t) return;
            await this.ctx.addCustom(t, Number(levelSel.value));
            await this.render();
          } }, 'Add')),
        h('ul', { class: 'list' }, ...this.ctx.custom().map((c) =>
          h('li', {}, h('span', { class: 'name' }, c.text), h('span', { class: 'muted' }, `Level ${c.level}`),
            h('button', { class: 'btn ghost small', onclick: async () => { await this.ctx.removeCustom(c.id); await this.render(); } }, 'Delete'))))),
    ];
    const top = this.root.scrollTop;
    this.root.replaceChildren(...sections);
    this.root.scrollTop = top;
    void this.watchDownloads();
  }

  private exportList(names: string[]): void {
    const url = URL.createObjectURL(new Blob([names.join('\n')], { type: 'text/plain' }));
    const a = h('a', { href: url, download: 'motivati-scroll-library.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

const stat = (value: string, label: string) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
