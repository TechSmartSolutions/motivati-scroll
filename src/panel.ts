import { h, formatBytes } from './dom';
import * as db from './db';
import { videoLabel, answerSuggestion, deleteMedia, getSuggestions, getTranscriberStatus, isMediaFile, listAcceptedChallenges, listDownloads, listMedia, regenerateCards, setTags, submitLinks, repairVideos, updateDownloader, uploadMedia, type DownloadJob, type MediaItem } from './library';
import { LEVEL_NAMES, MAX_LEVEL, dateKey, streak, type Progress } from './progress';
import type { GoalSet, Prompt } from './challenges';
import { ageLabel, counts, daysOld, overdueCount, type TodayList } from './today';

const MAX_GOALS = 10; // keep in sync with server/goals.mjs

export interface PanelCtx {
  settings(): db.Settings;
  progress(): Progress;
  custom(): Prompt[];
  today(): TodayList;
  completeToday(id: string): Promise<{ leveledUp: boolean; level: number }>;
  removeToday(id: string): Promise<void>;
  goals(): GoalSet;
  saveGoals(next: { goals: { id?: string; text: string; active: boolean; prompt: string }[] }): Promise<void>;
  updateSettings(patch: Partial<db.Settings>): Promise<void>;
  shiftLevel(delta: number): Promise<void>;
  resetToday(): Promise<void>;
  addCustom(text: string, level: number): Promise<void>;
  removeCustom(id: string): Promise<void>;
  close(): void;
}

export class Panel {
  readonly root = h('div', { class: 'panel', hidden: true });
  private status = '';
  private goalStatus = '';
  private todayStatus = '';
  /** The file list starts collapsed and stays as the user left it while the menu re-renders. */
  private filesOpen = false;
  /** Which files the list shows: everything, files with no goal yet, or one goal. Kept while the menu re-renders. */
  private tagFilter: string = 'all'; // 'all', 'untagged' or a goal id
  /** Goals to file the next uploads under. */
  private uploadGoals = new Set<string>();
  private linkStatus = '';
  /** Goals whose card-writing instructions box is open. Kept while the menu re-renders. */
  private promptOpen = new Set<string>();
  /** Deck cards ticked for regeneration, the deck's goal filter, and whether the list is open. */
  private cardSel = new Set<string>();
  private cardFilter = 'all';
  private cardsOpen = false;
  private cardStatus = '';
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
        }, [...this.uploadGoals]);
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

  /**
   * "Challenge cards": every card in the deck with a checkbox. Tick the ones to rewrite and press Regenerate;
   * Claude rewrites them all in one call, using the instructions of each card's video's goals. The rewrites arrive
   * under "Suggested challenges" to add or dismiss. Ticking updates in place so the list keeps its scroll position.
   */
  private cardsBlock(deck: Prompt[], items: MediaItem[], canRegen: boolean): HTMLElement {
    const goals = this.ctx.goals().goals;
    const byId = new Map(items.map((v) => [v.id, v]));
    const goalsOf = (c: Prompt) => (c.sourceVideoId ? byId.get(c.sourceVideoId)?.tags ?? [] : []);
    const filters: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      ...goals.map((g) => ({ id: g.id, label: g.active ? g.text : `${g.text} (parked)` })),
    ];
    if (!filters.some((f) => f.id === this.cardFilter)) this.cardFilter = 'all';
    const shown = (c: Prompt) => this.cardFilter === 'all' || goalsOf(c).includes(this.cardFilter);
    const countFor = (id: string) => deck.filter((c) => id === 'all' || goalsOf(c).includes(id)).length;
    const live = new Set(deck.map((c) => c.id));
    for (const id of [...this.cardSel]) if (!live.has(id)) this.cardSel.delete(id);

    const rows = new Map<string, HTMLElement>();
    const boxes = new Map<string, HTMLInputElement>();
    const filterBtns = new Map<string, HTMLButtonElement>();
    const status = h('div', { class: 'muted tag-status' }, this.cardStatus);
    const regenBtn = h('button', { class: 'btn small', disabled: true });

    const refresh = () => {
      regenBtn.textContent = `Regenerate selected (${this.cardSel.size})`;
      regenBtn.disabled = !canRegen || this.cardSel.size === 0;
      for (const f of filters) {
        const b = filterBtns.get(f.id)!;
        b.textContent = `${f.label} (${countFor(f.id)})`;
        b.classList.toggle('on', this.cardFilter === f.id);
      }
      for (const c of deck) rows.get(c.id)!.hidden = !shown(c);
    };
    const regenerate = async () => {
      const ids = [...this.cardSel];
      if (!ids.length) return;
      if (!confirm(`Rewrite ${ids.length} card${ids.length > 1 ? 's' : ''} with Claude? That is one call on your Anthropic key. The rewrites wait in "Suggested challenges" for you to add or dismiss.`)) return;
      regenBtn.disabled = true;
      this.cardStatus = '';
      status.textContent = `Rewriting ${ids.length} card${ids.length > 1 ? 's' : ''}… this can take a minute.`;
      try {
        const r = await regenerateCards(ids);
        this.cardSel.clear();
        this.cardStatus = `${r.created} rewrite${r.created === 1 ? '' : 's'} ready in "Suggested challenges".${r.skipped.length ? ` ${r.skipped.length} skipped (${r.skipped[0].why}).` : ''}`;
      } catch (e) {
        this.cardStatus = (e as Error).message;
      }
      await this.render();
    };
    regenBtn.addEventListener('click', () => void regenerate());

    const filterRow = h('div', { class: 'tag-filters' }, ...filters.map((f) => {
      const b = h('button', { class: 'tag-chip', onclick: () => { this.cardFilter = f.id; refresh(); } });
      filterBtns.set(f.id, b);
      return b;
    }));
    const list = h('ul', { class: 'list' }, ...deck.map((c) => {
      const box = h('input', {
        type: 'checkbox', 'aria-label': 'Select this card', checked: this.cardSel.has(c.id),
        onchange: () => { if (box.checked) this.cardSel.add(c.id); else this.cardSel.delete(c.id); refresh(); },
      });
      boxes.set(c.id, box);
      const names = goalsOf(c).map((id) => goals.find((g) => g.id === id)?.text).filter(Boolean).join(', ');
      const video = c.sourceVideoId ? byId.get(c.sourceVideoId) : undefined;
      const li = h('li', { class: 'card-row' },
        h('label', { class: 'card-pick' }, box, h('span', { class: 'name' }, c.text)),
        h('span', { class: 'muted' }, `Level ${c.level} · ${LEVEL_NAMES[c.level] ?? ''}${names ? ` · ${names}` : ''}${video ? ` · from ${video.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40)}` : ''}`));
      rows.set(c.id, li);
      return li;
    }));
    const selectShown = h('button', { class: 'btn ghost small', onclick: () => {
      for (const c of deck) if (shown(c)) { this.cardSel.add(c.id); boxes.get(c.id)!.checked = true; }
      refresh();
    } }, 'Select all shown');
    const clearSel = h('button', { class: 'btn ghost small', onclick: () => {
      this.cardSel.clear();
      for (const b of boxes.values()) b.checked = false;
      refresh();
    } }, 'Clear');

    const block = h('details', { class: 'acc', open: this.cardsOpen, ontoggle: (e: Event) => { this.cardsOpen = (e.target as HTMLDetailsElement).open; } },
      h('summary', {}, `Challenge cards (${deck.length})`),
      h('div', { class: 'muted' }, canRegen
        ? 'Tick the cards you want rewritten and press Regenerate. Claude rewrites them all in one call, following each goal\'s instructions below.'
        : 'Regenerating needs the Claude key (see Suggested challenges).'),
      filterRow,
      h('div', { class: 'row' }, selectShown, clearSel, regenBtn),
      status,
      list);
    refresh();
    return block;
  }

  /**
   * "Your files": filter by goal, tick the goals each file belongs to, or remove it. Tagging updates the
   * page in place (no menu re-render), so the list keeps its scroll position while you work through it.
   */
  private filesBlock(items: MediaItem[], trLabel: (v: MediaItem) => string): HTMLElement {
    const goalTags = this.ctx.goals().goals.map((g) => ({ id: g.id, label: g.active ? g.text : `${g.text} (parked)` }));
    if (this.tagFilter !== 'all' && this.tagFilter !== 'untagged' && !goalTags.some((t) => t.id === this.tagFilter)) this.tagFilter = 'all';
    const filters: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'untagged', label: 'Untagged' },
      ...goalTags,
    ];
    const countFor = (id: string) =>
      items.filter((v) => (id === 'all' ? true : id === 'untagged' ? !v.tags?.length : !!v.tags?.includes(id))).length;
    const shown = (v: MediaItem) => this.tagFilter === 'all' || (this.tagFilter === 'untagged' ? !v.tags?.length : !!v.tags?.includes(this.tagFilter));

    const rows = new Map<string, HTMLElement>();
    const chips = new Map<string, HTMLButtonElement>(); // key: `${fileId}:${tagId}`
    const filterBtns = new Map<string, HTMLButtonElement>();
    const tagStatus = h('div', { class: 'muted tag-status' });

    const refreshFilters = () => {
      for (const f of filters) {
        const b = filterBtns.get(f.id)!;
        b.textContent = `${f.label} (${countFor(f.id)})`;
        b.classList.toggle('on', this.tagFilter === f.id);
        b.setAttribute('aria-pressed', String(this.tagFilter === f.id));
      }
    };
    const refreshChips = (v: MediaItem) => {
      for (const t of goalTags) {
        const on = !!v.tags?.includes(t.id);
        const c = chips.get(`${v.id}:${t.id}`)!;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', String(on));
      }
    };
    const applyFilter = () => {
      for (const v of items) rows.get(v.id)!.hidden = !shown(v);
      refreshFilters();
    };

    const toggle = async (v: MediaItem, tag: string) => {
      const before = v.tags ?? [];
      v.tags = before.includes(tag) ? before.filter((t) => t !== tag) : [...before, tag];
      tagStatus.textContent = '';
      refreshChips(v);
      refreshFilters(); // the row stays where it is until you pick a filter again
      try {
        v.tags = await setTags(v.id, v.tags);
      } catch (e) {
        v.tags = before;
        tagStatus.textContent = `Could not save the goal for ${v.name}: ${(e as Error).message}`;
      }
      refreshChips(v);
      refreshFilters();
    };

    const filterRow = h('div', { class: 'tag-filters' }, ...filters.map((f) => {
      const b = h('button', { class: 'tag-chip', onclick: () => { this.tagFilter = f.id; applyFilter(); } });
      filterBtns.set(f.id, b);
      return b;
    }));

    const list = h('ul', { class: 'list' }, ...items.map((v) => {
      const tagRow = h('div', { class: 'tag-row' }, ...goalTags.map((t) => {
        const c = h('button', { class: 'tag-chip', onclick: () => void toggle(v, t.id) }, t.label);
        chips.set(`${v.id}:${t.id}`, c);
        return c;
      }));
      const li = h('li', {},
        h('span', { class: 'name' }, v.name),
        h('span', { class: 'muted' }, `${videoLabel(v.name).full} · ${v.kind === 'image' ? 'Image' : 'Video'} · ${formatBytes(v.size)}${v.favorite ? ' · ♥ favorite' : ''}${trLabel(v)}`),
        h('button', { class: 'btn ghost small', onclick: async () => {
          if (confirm(`Delete "${v.name}" from your server? It disappears on every device.`)) {
            try {
              await deleteMedia(v.id);
            } catch (e) {
              this.status = `Could not delete ${v.name}: ${(e as Error).message}`;
            }
            await this.render();
          }
        } }, 'Remove'),
        tagRow);
      rows.set(v.id, li);
      refreshChips(v);
      return li;
    }));

    const block = h('details', { class: 'acc', open: this.filesOpen, ontoggle: (e: Event) => { this.filesOpen = (e.target as HTMLDetailsElement).open; } },
      h('summary', {}, `Your files (${items.length})`),
      h('div', { class: 'muted' }, 'Tick the goals each file belongs to. Pick "Untagged" to work through the ones you haven\'t sorted.'),
      filterRow,
      tagStatus,
      list,
      h('button', { class: 'btn ghost small', onclick: () => this.exportList(items.map((v) => v.name)) }, 'Export list of file names'));
    applyFilter();
    return block;
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
    const tr = offline ? undefined : await getTranscriberStatus();
    const sug = offline ? undefined : await getSuggestions();
    const deck = offline ? [] : await listAcceptedChallenges();
    const sugIntro = !sug ? '' : !sug.status.enabled
      ? 'Off. To let Claude draft challenges from your video transcripts, add ANTHROPIC_API_KEY to the .env file next to docker-compose.yml, then run: docker compose up -d --build'
      : sug.status.pending
        ? `Claude is reading ${sug.status.pending} transcript${sug.status.pending > 1 ? 's' : ''}. Nothing joins your feed until you add it.`
        : 'Claude drafts these from your video transcripts. Nothing joins your feed until you add it.';
    const answer = (id: string, action: 'accept' | 'dismiss') => async () => {
      try {
        await answerSuggestion(id, action);
      } catch (e) {
        this.status = (e as Error).message;
      }
      await this.render();
    };
    const trLine = !tr?.enabled ? '' : tr.working || tr.pending
      ? `Transcribing videos: ${tr.done} done, ${tr.pending} waiting${tr.current ? ` (now: ${tr.current})` : ''}`
      : `Transcripts: ${tr.done} done${tr.failed ? `, ${tr.failed} failed` : ''}`;
    const trLabel = (v: MediaItem) => (v.transcript === 'done' ? ' · transcript ✓' : v.transcript === 'failed' ? ' · transcript failed' : v.transcript ? ' · transcript pending' : '');
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

    const td = this.ctx.today();
    const tc = counts(td);
    const overdue = overdueCount(td);
    // Unfinished first (oldest commitment first), finished at the bottom.
    const todayItems = [...td.items].sort((a, b) => Number(a.done) - Number(b.done) || a.addedAt - b.addedAt);
    const gs = this.ctx.goals();
    const addGoalInput = h('input', { type: 'text', class: 'goal-input', maxlength: 200, placeholder: gs.goals.length ? 'Add another goal' : 'e.g. Get fit and strong' });
    const saveGoals = async (goals: { id?: string; text: string; active: boolean; prompt: string }[]) => {
      try {
        await this.ctx.saveGoals({ goals });
        this.goalStatus = '';
      } catch (e) {
        this.goalStatus = (e as Error).message;
      }
      await this.render();
    };
    const textarea = h('textarea', { rows: 2, placeholder: 'Write your own challenge…' });
    const levelSel = h('select', {}, ...[1, 2, 3, 4].map((l) => h('option', { value: l }, `Level ${l} · ${LEVEL_NAMES[l]}`)));

    const sections = [
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Motivati-scroll'),
        h('button', { class: 'btn ghost', onclick: () => this.ctx.close() }, 'Close')),

      h('section', { class: 'today' },
        h('h3', {}, `Today (${tc.done}/${tc.total})`),
        tc.total === 0
          ? h('div', { class: 'muted' }, 'Tap "Do it today" on a challenge card to commit to it. Anything you don\'t finish stays here until you do it or drop it.')
          : tc.done === tc.total
            ? h('div', { class: 'levelup' }, 'All done. You kept your word.')
            : null,
        overdue ? h('div', { class: 'muted overdue' }, `${overdue} carried over from earlier. You said you'd do ${overdue > 1 ? 'these' : 'this'}.`) : null,
        this.todayStatus ? h('div', { class: 'logged' }, this.todayStatus) : null,
        ...todayItems.map((it) => {
          const days = daysOld(it);
          const age = ageLabel(days);
          return h('div', { class: `today-row${it.done ? ' done' : ''}${!it.done && days > 0 ? ' late' : ''}` },
            h('button', {
              class: 'check', disabled: it.done, 'aria-label': 'Mark done',
              onclick: async () => {
                const r = await this.ctx.completeToday(it.id);
                this.todayStatus = r.leveledUp ? `Level up: ${LEVEL_NAMES[r.level]}` : 'Done. Nice work.';
                await this.render();
              },
            }, it.done ? '✓' : ''),
            h('div', { class: 't' },
              h('div', { class: 'tt' }, it.text),
              h('div', { class: 'muted' }, `Level ${it.level} · ${LEVEL_NAMES[it.level] ?? ''}${age ? ` · ${age}` : ''}`)),
            h('button', {
              class: 'btn ghost small', 'aria-label': 'Remove from today',
              onclick: async () => {
                const msg = it.done ? 'Clear this finished item?' : days > 0
                  ? `You said you'd do this ${age}. Do you really want to drop it?`
                  : 'You committed to this today. Drop it?';
                if (!confirm(msg)) return;
                await this.ctx.removeToday(it.id);
                await this.render();
              },
            }, '✕'));
        })),

      h('section', {},
        h('h3', {}, `Library (${items.length})`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: offline, onclick: () => input.click() }, 'Add videos or images'),
          h('span', { class: 'muted' }, offline ? 'Server not reachable' : `${formatBytes(used)} on your server`)),
        input,
        gs.goals.length ? h('div', { class: 'tag-filters' },
          h('span', { class: 'muted' }, 'File new uploads under:'),
          ...gs.goals.map((g) => {
            const b = h('button', {
              class: `tag-chip${this.uploadGoals.has(g.id) ? ' on' : ''}${g.active ? '' : ' parked'}`,
              'aria-pressed': String(this.uploadGoals.has(g.id)),
              onclick: () => {
                if (this.uploadGoals.has(g.id)) this.uploadGoals.delete(g.id); else this.uploadGoals.add(g.id);
                b.classList.toggle('on', this.uploadGoals.has(g.id));
                b.setAttribute('aria-pressed', String(this.uploadGoals.has(g.id)));
              },
            }, g.text);
            return b;
          })) : null,
        h('div', { class: 'status muted' }, this.status),
        trLine ? h('div', { class: 'muted' }, trLine) : null,
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
          } }, 'Update downloader'),
          h('button', { class: 'btn ghost small', disabled: offline, onclick: async () => {
            try {
              const r = await repairVideos();
              this.linkStatus = r.started ? 'Checking downloaded videos for iPhone. Converting can take a few minutes; reload the feed afterwards.' : 'Already checking videos.';
            } catch (err) {
              this.linkStatus = (err as Error).message;
            }
            this.root.querySelector('.link-status')!.textContent = this.linkStatus;
          } }, 'Fix videos for iPhone')),
        h('div', { class: 'link-status muted' }, this.linkStatus),
        this.dlBox,
        h('div', { class: 'muted' }, 'Public Facebook reels only. The server is not logged in to Facebook, so private reels fail; upload those instead.'),
        items.length ? this.filesBlock(items, trLabel) : null),

      sug ? h('section', {},
        h('h3', {}, `Suggested challenges${sug.items.length ? ` (${sug.items.length})` : ''}`),
        h('div', { class: 'muted' }, sugIntro),
        sug.status.lastError && sug.status.enabled === false ? h('div', { class: 'muted' }, `Last error: ${sug.status.lastError}`) : null,
        h('ul', { class: 'list' }, ...sug.items.map((c) =>
          h('li', { class: 'sug' },
            h('span', { class: 'name' }, c.text),
            c.replacesText ? h('span', { class: 'muted was' }, `Replaces: ${c.replacesText}`) : null,
            h('span', { class: 'muted' }, `Level ${c.level} · ${LEVEL_NAMES[c.level] ?? ''} · ${c.need}`),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: answer(c.id, 'accept') }, c.replacesText ? 'Replace' : 'Add'),
              h('button', { class: 'btn ghost small', onclick: answer(c.id, 'dismiss') }, 'Dismiss')))))) : null,

      deck.length ? this.cardsBlock(deck, items, sug?.status.enabled ?? false) : null,

      h('section', {},
        h('h3', {}, `Your goals (${gs.goals.length}/${MAX_GOALS}, ${gs.goals.filter((g) => g.active).length} active)`),
        h('div', { class: 'muted' }, gs.goals.length
          ? 'Star the goals you are working on now. The feed shows videos filed under a starred goal (plus any with no goal yet), and challenges talk about them. Unstarred goals are parked, not lost. Clear a goal\'s text to remove it.'
          : 'Not sure yet? Leave this empty. You\'ll get challenges that help you find a goal. Start small, like "get fitter" or "stop wasting evenings".'),
        ...gs.goals.map((g) => h('div', { class: 'goal-block' }, h('div', { class: `goal-row${g.active ? '' : ' parked'}` },
          h('button', {
            class: `star${g.active ? ' on' : ''}`,
            title: g.active ? 'Active. Tap to park it' : 'Parked. Tap to make it active',
            'aria-label': g.active ? 'Active goal' : 'Parked goal',
            'aria-pressed': String(g.active),
            onclick: () => void saveGoals(gs.goals.map((x) => (x.id === g.id ? { ...x, active: !x.active } : x))),
          }, g.active ? '★' : '☆'),
          h('input', {
            type: 'text', class: 'goal-input', maxlength: 200, value: g.text,
            onchange: (e: Event) => {
              const text = (e.target as HTMLInputElement).value;
              if (!text.trim() && !confirm(`Remove "${g.text}"? Videos filed under it lose that goal.`)) return void this.render();
              void saveGoals(gs.goals.map((x) => (x.id === g.id ? { ...x, text } : x)));
            },
          }),
          h('button', {
            class: 'btn ghost small', 'aria-label': 'Remove goal',
            onclick: () => {
              if (confirm(`Remove "${g.text}"? Videos filed under it lose that goal.`)) void saveGoals(gs.goals.filter((x) => x.id !== g.id));
            },
          }, '✕')),
          h('details', {
            class: 'goal-prompt', open: this.promptOpen.has(g.id),
            ontoggle: (e: Event) => {
              if ((e.target as HTMLDetailsElement).open) this.promptOpen.add(g.id); else this.promptOpen.delete(g.id);
            },
          },
            h('summary', {}, g.prompt.trim() ? 'Instructions for card writing' : 'Instructions for card writing (none yet)'),
            h('textarea', {
              rows: 5, maxlength: 1500, class: 'goal-prompt-text', value: g.prompt,
              placeholder: 'Tell Claude how to turn a video into a card for this goal. For example: put me inside the discomfort, not just thinking about it.',
              onchange: (e: Event) => void saveGoals(gs.goals.map((x) => (x.id === g.id ? { ...x, prompt: (e.target as HTMLTextAreaElement).value } : x))),
            }),
            h('div', { class: 'muted' }, 'Used when Claude writes cards from videos filed under this goal, including "Regenerate selected" below. Safety and length rules still apply.')))),
        gs.goals.length < MAX_GOALS
          ? h('div', { class: 'goal-row' }, addGoalInput,
              h('button', { class: 'btn small', onclick: () => {
                const t = addGoalInput.value.trim();
                if (t) void saveGoals([...gs.goals, { text: t, active: true, prompt: '' }]);
              } }, 'Add'))
          : h('div', { class: 'muted' }, `That's the maximum of ${MAX_GOALS}. Remove one to add another.`),
        this.goalStatus ? h('div', { class: 'muted' }, this.goalStatus) : null),

      h('section', {},
        h('h3', {}, 'Your growth'),
        h('div', { class: 'stats' },
          stat(`${p.level}`, `Level today · ${LEVEL_NAMES[p.level]}`, p.level / MAX_LEVEL),
          stat(`${p.doneAtLevel}/${s.levelThreshold}`, p.level >= MAX_LEVEL ? 'At the top level today' : 'Today, to next level', p.doneAtLevel / s.levelThreshold),
          stat(`${streak(p)}`, 'Day streak', streak(p) / 7),
          stat(`${today}`, 'Done today', today / (s.levelThreshold * 2))),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', disabled: p.level <= 1, onclick: () => void this.ctx.shiftLevel(-1).then(() => this.render()) }, 'Easier'),
          h('button', {
            class: 'btn ghost small',
            onclick: () => {
              if (confirm('Reset today back to zero? Level 1, no cards counted, and "Done today" back to 0. Earlier days and your streak history stay.')) void this.ctx.resetToday().then(() => this.render());
            },
          }, 'Reset today')),
        h('div', { class: 'muted' }, `Every day starts at level 1. Finish ${s.levelThreshold} cards at a level to unlock the next one. The count starts over tomorrow.`)),

      h('section', {},
        h('h3', {}, 'Settings'),
        num('Challenge every N videos or images', s.interval, 2, 30, 'interval'),
        num('Cards per level, each day', s.levelThreshold, 1, 30, 'levelThreshold'),
        h('label', { class: 'row' }, h('span', {}, 'Play the next item automatically when a video ends'),
          h('input', { type: 'checkbox', checked: s.autoAdvance, onchange: (e: Event) => void this.ctx.updateSettings({ autoAdvance: (e.target as HTMLInputElement).checked }) })),
        h('label', { class: 'row' }, h('span', {}, 'Start videos muted (sound is on by default)'),
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
    this.root.replaceChildren(...sections.filter((s): s is HTMLElement => s !== null));
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

/** `glow` is how far along the widget is, 0 to 1: it lights up as it fills, and pulses once it is full. */
const stat = (value: string, label: string, glow = 0) => {
  const g = Math.max(0, Math.min(1, glow));
  return h('div', { class: `stat${g >= 1 ? ' full' : ''}`, style: `--glow: ${g.toFixed(2)}` }, h('b', {}, value), h('span', {}, label));
};
