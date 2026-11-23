import { h, formatBytes } from './dom';
import * as db from './db';
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

const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name);

export class Panel {
  readonly root = h('div', { class: 'panel', hidden: true });
  private status = '';

  constructor(private ctx: PanelCtx) {}

  async open(): Promise<void> {
    this.root.hidden = false;
    await this.render();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private async importFiles(files: File[]): Promise<void> {
    const vids = files.filter(isVideoFile);
    if (!vids.length) return;
    void navigator.storage?.persist?.();
    let added = 0;
    let skipped = 0;
    for (let i = 0; i < vids.length; i++) {
      this.status = `Importing ${i + 1} of ${vids.length}…`;
      this.setStatus();
      try {
        if (await db.addVideo(vids[i])) added++;
        else skipped++;
      } catch (e) {
        this.status = `Could not store ${vids[i].name}: storage may be full.`;
        this.setStatus();
        console.error(e);
        await this.render();
        return;
      }
    }
    this.status = `Added ${added}${skipped ? `, skipped ${skipped} duplicate${skipped > 1 ? 's' : ''}` : ''}.`;
    await this.render();
  }

  private setStatus(): void {
    const el = this.root.querySelector('.status');
    if (el) el.textContent = this.status;
  }

  private async render(): Promise<void> {
    const videos = await db.listVideos();
    const used = videos.reduce((n, v) => n + v.size, 0);
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    const p = this.ctx.progress();
    const s = this.ctx.settings();
    const today = p.days[dateKey()] ?? 0;

    const input = h('input', { type: 'file', accept: 'video/*', multiple: true, hidden: true });
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
        h('h3', {}, `Library (${videos.length})`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => input.click() }, 'Add videos'),
          h('span', { class: 'muted' }, `${formatBytes(used)} used${est?.quota ? ` of ~${formatBytes(est.quota)} available` : ''}`)),
        input,
        h('div', { class: 'status muted' }, this.status),
        h('ul', { class: 'list' }, ...videos.map((v) =>
          h('li', {}, h('span', { class: 'name' }, v.name), h('span', { class: 'muted' }, `${formatBytes(v.size)} · seen ${v.seenCount}×`),
            h('button', { class: 'btn ghost small', onclick: async () => {
              if (confirm(`Remove "${v.name}" from the app? Your original file is not touched.`)) {
                await db.deleteVideo(v.id);
                await this.render();
              }
            } }, 'Remove')))),
        videos.length
          ? h('button', { class: 'btn ghost small', onclick: () => this.exportList(videos.map((v) => v.name)) }, 'Export list of video names')
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
        num('Challenge every N videos', s.interval, 2, 30, 'interval'),
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
  }

  private exportList(names: string[]): void {
    const url = URL.createObjectURL(new Blob([names.join('\n')], { type: 'text/plain' }));
    const a = h('a', { href: url, download: 'motivati-scroll-videos.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

const stat = (value: string, label: string) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
