import { h } from './dom';
import { ShuffleBag } from './shuffle';
import * as db from './db';
import { deleteMedia, feedVisible, listMedia, setFavorite, setTags, videoLabel, type MediaItem } from './library';
import { LEVEL_HINTS, LEVEL_NAMES } from './progress';
import type { Goal, Prompt } from './challenges';

export interface FeedDeps {
  interval(): number;
  muted(): boolean;
  setMuted(m: boolean): void;
  /** `ok` lets the feed hide cards whose video belongs only to parked goals. */
  nextPrompt(excludeId?: string, ok?: (p: Prompt) => boolean): Prompt | undefined;
  currentLevel(): number;
  complete(p: Prompt): Promise<{ leveledUp: boolean; level: number }>;
  /** Park a challenge on today's list. Returns false if it was already there. */
  addToday(p: Prompt): boolean;
  isToday(p: Prompt): boolean;
  todayCount(): { done: number; total: number };
  autoAdvance(): boolean;
  openMenu(): void;
  goals(): Goal[];
  /** The one goal the feed is narrowed to on this device, or null for all active goals. */
  feedGoal(): string | null;
  setFeedGoal(id: string | null): Promise<void>;
}

interface Slide {
  kind: 'media' | 'challenge';
  el: HTMLElement;
  item?: MediaItem;
  video?: HTMLVideoElement;
  img?: HTMLImageElement;
  bar?: HTMLElement;
  wanted?: boolean;
  userPaused?: boolean;
  prompt?: Prompt;
  filled?: boolean;
  done?: boolean;
}

const BATCH = 6;
const FAVORITE_WEIGHT = 3;

export class Feed {
  readonly root: HTMLElement;
  private scroller = h('div', { class: 'scroller', tabindex: 0 });
  private todayPill = h('button', { class: 'today-pill', hidden: true, 'aria-label': "Open today's list", onclick: () => this.deps.openMenu() });
  private soundHint = h('div', { class: 'sound-hint', hidden: true }, '🔊 Tap anywhere for sound');
  private muteBtn = h('button', { class: 'fab mute', 'aria-label': 'Toggle sound', onclick: () => this.toggleMute() });
  private slides: Slide[] = [];
  // Favorites go through the shuffle FAVORITE_WEIGHT times per round, so they come up more often.
  private bag = new ShuffleBag<string>([], Math.random, (id) => (this.items.get(id)?.favorite ? FAVORITE_WEIGHT : 1));
  private favBtn = h('button', { class: 'fab fav', hidden: true, onclick: () => void this.toggleFavorite() });
  private delBtn = h('button', { class: 'fab del', hidden: true, 'aria-label': 'Delete this from your library', onclick: () => void this.deleteCurrent() }, '🗑');
  /** Shown over a video that has no goal yet, so it can be filed without opening the menu. */
  private tagPick = h('select', { class: 'tag-pick', hidden: true, 'aria-label': 'File this under a goal', onchange: () => void this.pickGoal() });
  /** Shows which goal the feed is narrowed to and opens the picker. */
  private goalPill = h('button', { class: 'goal-pill', hidden: true, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => this.toggleGoalMenu() });
  private goalMenu = h('div', { class: 'goal-menu', role: 'listbox', hidden: true });
  /** Which file this is (reactions count and the start of its title), to match it to the list in the menu. */
  private nameTag = h('div', { class: 'name-tag', hidden: true });
  private ids: string[] = [];
  private items = new Map<string, MediaItem>();
  /** Every file in the library, including ones the goal filter hides from the feed. */
  private everything = new Map<string, MediaItem>();
  private active = -1;
  private planned = 0;
  private observer: IntersectionObserver;

  constructor(private deps: FeedDeps) {
    this.root = h(
      'div',
      { class: 'feed' },
      this.scroller,
      h('button', { class: 'fab menu', 'aria-label': 'Menu', onclick: () => deps.openMenu() }, '☰'),
      this.muteBtn,
      this.favBtn,
      this.delBtn,
      this.tagPick,
      this.nameTag,
      this.goalPill,
      this.goalMenu,
      this.todayPill,
      this.soundHint,
    );
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = this.slides.findIndex((s) => s.el === e.target);
          if (i >= 0 && i !== this.active) void this.setActive(i);
        }
      },
      { root: this.scroller, threshold: 0.65 },
    );
    document.addEventListener('visibilitychange', () => {
      const s = this.slides[this.active];
      if (!s?.video) return;
      if (document.hidden) s.video.pause();
      else if (!s.userPaused) void this.play(s.video);
    });
    // touchend/click count as user activation on iOS; pointerdown does not.
    for (const type of ['touchend', 'click'] as const) {
      document.addEventListener(type, (e) => {
        // The mute button has its own handler; don't let it unlock then immediately re-toggle.
        if (this.soundBlocked && !(e.target as Element | null)?.closest?.('.fab.mute')) this.unlockSound();
      }, { capture: true, passive: true });
    }
    this.updateMuteIcon();
    this.refreshToday();
  }

  /** The heart shows for photos and videos (not challenge cards) and reflects the item on screen. */
  private updateFavButton(): void {
    const id = this.slides[this.active]?.item?.id;
    const item = id ? this.items.get(id) : undefined;
    this.favBtn.hidden = !item;
    this.delBtn.hidden = !item;
    this.updateTagPick(item);
    this.nameTag.hidden = !item;
    if (item) this.nameTag.textContent = videoLabel(item.name).full;
    const on = !!item?.favorite;
    this.favBtn.textContent = on ? '♥' : '♡';
    this.favBtn.classList.toggle('on', on);
    this.favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    this.favBtn.setAttribute('aria-pressed', String(on));
  }

  private updateTagPick(item: MediaItem | undefined): void {
    const goals = this.deps.goals();
    const show = !!item && !item.tags?.length && goals.length > 0;
    this.tagPick.hidden = !show;
    if (!show) return;
    const opt = (value: string, label: string) => h('option', { value }, label);
    this.tagPick.replaceChildren(
      opt('', 'File under a goal…'),
      ...goals.filter((g) => g.active).map((g) => opt(g.id, g.text)),
      ...goals.filter((g) => !g.active).map((g) => opt(g.id, `${g.text} (parked)`)),
    );
    this.tagPick.value = '';
  }

  private async pickGoal(): Promise<void> {
    const id = this.slides[this.active]?.item?.id;
    const item = id ? this.items.get(id) : undefined;
    const goal = this.tagPick.value;
    if (!item || !goal) return;
    this.tagPick.disabled = true;
    try {
      item.tags = await setTags(item.id, [goal]);
    } catch (e) {
      console.error(e);
      alert(`Could not save the goal: ${(e as Error).message}`);
    }
    this.tagPick.disabled = false;
    this.updateTagPick(item);
  }

  private async toggleFavorite(): Promise<void> {
    const id = this.slides[this.active]?.item?.id;
    const item = id ? this.items.get(id) : undefined;
    if (!id || !item) return;
    const apply = (favorite: boolean) => {
      item.favorite = favorite;
      this.bag.setItems(this.ids);
      this.updateFavButton();
    };
    const next = !item.favorite;
    apply(next); // update right away; undo if the server can't be reached
    try {
      await setFavorite(id, next);
    } catch (e) {
      console.error(e);
      apply(!next);
    }
  }

  /** Delete the video or photo on screen from the server, after asking. The feed then rebuilds without it. */
  private async deleteCurrent(): Promise<void> {
    const item = this.slides[this.active]?.item;
    if (!item) return;
    const what = item.kind === 'image' ? 'photo' : 'video';
    if (!confirm(`Delete this ${what} from your server?\n\nIt disappears on every device and can't be undone.`)) return;
    try {
      await deleteMedia(item.id);
    } catch (e) {
      console.error(e);
      alert(`Could not delete it: ${(e as Error).message}`);
      return;
    }
    await this.refresh();
  }

  /** Update the "Today 1/3" pill. Hidden when nothing is on today's list. */
  refreshToday(): void {
    const { done, total } = this.deps.todayCount();
    this.todayPill.hidden = total === 0;
    this.todayPill.textContent = `Today ${done === total ? '✓ ' : ''}${done}/${total}`;
    this.todayPill.classList.toggle('complete', total > 0 && done === total);
  }

  /** Call whenever the library may have changed. Rebuilds only if the set of videos changed. */
  async refresh(): Promise<void> {
    let list: MediaItem[];
    try {
      const all = await listMedia();
      this.everything = new Map(all.map((v) => [v.id, v]));
      list = feedVisible(all, this.deps.goals(), this.currentGoal());
    } catch (e) {
      console.error(e);
      this.teardown();
      this.ids = [];
      this.showMessage('Can\'t reach your server', 'Make sure the Motivati-scroll container is running and this device is on your home Wi-Fi.', 'Try again', () => void this.refresh());
      return;
    }
    this.updateGoalPill();
    const ids = list.map((v) => v.id);
    this.items = new Map(list.map((v) => [v.id, v]));
    this.bag.setItems(ids); // also re-reads favorites, which may have changed on another device
    const same = ids.length === this.ids.length && ids.every((id) => this.ids.includes(id));
    if (same && this.slides.length) return;
    this.ids = ids;
    this.bag.setItems(ids);
    this.teardown();
    if (!ids.length && this.everything.size) {
      const goal = this.currentGoal();
      const name = goal ? this.deps.goals().find((g) => g.id === goal)?.text : undefined;
      if (name) {
        this.showMessage(`No videos filed under "${name}" yet`, 'File videos under this goal in the menu (Library > Your files), or look at all your active goals.', 'Show all active goals', () => void this.chooseGoal(null));
      } else {
        this.showMessage('No videos for your active goals', 'Everything in your library is filed under goals you have parked. Star a goal in the menu, or file a video under an active one.', 'Open menu', () => this.deps.openMenu());
      }
      return;
    }
    if (!ids.length) {
      this.showMessage('Nothing here yet', 'Add the videos and images that motivate you. They live on your home server, so every device shows the same feed in random order.', 'Add videos or images', () => this.deps.openMenu());
      return;
    }
    this.planned = await db.getSinceChallenge();
    this.scroller.replaceChildren();
    this.appendBatch();
    this.scroller.scrollTop = 0;
    await this.setActive(0);
  }

  private showMessage(title: string, body: string, action: string, onclick: () => void): void {
    this.scroller.replaceChildren(
      h('section', { class: 'slide empty' },
        h('div', { class: 'empty-card' },
          h('h1', {}, title),
          h('p', {}, body),
          h('button', { class: 'btn primary', onclick }, action),
        ),
      ),
    );
  }

  applyMute(): void {
    for (const s of this.slides) if (s.video) s.video.muted = this.effectiveMuted();
    this.updateMuteIcon();
  }

  /**
   * The user's preference is unmuted by default, but a browser may refuse sound before the first
   * touch (e.g. launching from the home screen). `soundBlocked` plays muted until the first
   * gesture, then restores the preference, without ever changing the saved setting.
   */
  private soundBlocked = false;
  private justUnlocked = false;

  private effectiveMuted(): boolean {
    return this.deps.muted() || this.soundBlocked;
  }

  private unlockSound(): void {
    if (!this.soundBlocked) return;
    this.soundBlocked = false;
    this.justUnlocked = true;
    setTimeout(() => (this.justUnlocked = false), 500);
    this.applyMute();
    const s = this.slides[this.active];
    if (s?.video && !s.userPaused) void this.play(s.video);
  }

  private teardown(): void {
    this.observer.disconnect();
    for (const s of this.slides) this.release(s);
    this.slides = [];
    this.active = -1;
  }

  private appendBatch(): void {
    for (let n = 0; n < BATCH; n++) {
      if (this.slides.length > 0 && this.planned >= this.deps.interval()) {
        this.addSlide({ kind: 'challenge', el: h('section', { class: 'slide challenge' }) });
        this.planned = 0;
        continue;
      }
      const id = this.bag.next();
      const item = id && this.items.get(id);
      if (!item) return;
      this.addSlide({ kind: 'media', item, el: h('section', { class: `slide ${item.kind}` }) });
      this.planned++;
    }
  }

  private addSlide(s: Slide): void {
    this.slides.push(s);
    this.scroller.append(s.el);
    this.observer.observe(s.el);
    if (s.item?.kind === 'video') {
      s.el.addEventListener('click', () => this.togglePause(s));
    }
  }

  private async setActive(i: number): Promise<void> {
    const changed = i !== this.active;
    this.active = i;
    this.slides.forEach((s, j) => {
      s.wanted = Math.abs(j - i) <= 1;
      if (s.wanted) this.ensure(s, j === i);
      else this.release(s);
    });
    this.updateFavButton();
    if (!changed) return;
    const cur = this.slides[i];
    if (cur.kind === 'media') {
      void db.saveSinceChallenge(await db.getSinceChallenge().then((n) => n + 1));
    } else if (cur.kind === 'challenge') {
      void db.saveSinceChallenge(0);
    }
    if (i >= this.slides.length - 3) this.appendBatch();
  }

  private ensure(s: Slide, isActive: boolean): void {
    if (s.kind === 'challenge') {
      if (!s.filled) this.fillChallenge(s);
      return;
    }
    if (s.video) {
      if (isActive) {
        if (!s.userPaused) void this.play(s.video);
      } else s.video.pause();
      return;
    }
    if (s.img || !s.item) return;
    const missing = (el: HTMLElement) => () => {
      // Ignore errors from elements this slide has already released.
      if (s.img !== el && s.video !== el) return;
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4) means the file is there but this device cannot decode it.
      const unsupported = el instanceof HTMLVideoElement && el.error?.code === 4;
      const why = unsupported
        ? 'This device cannot play its video format. Re-add it, or run "Fix videos for iPhone" in the menu.'
        : 'It may have been removed, or the server is offline.';
      s.el.replaceChildren(h('div', { class: 'missing' }, `Could not play "${s.item?.name}". ${why}`));
    };
    if (s.item.kind === 'image') {
      const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', missing(img));
      img.src = s.item.url;
      s.img = img;
      s.el.replaceChildren(img);
      return;
    }
    const v = h('video', { playsinline: true, preload: 'auto', 'webkit-playsinline': true });
    v.loop = !this.deps.autoAdvance();
    v.muted = this.effectiveMuted();
    v.setAttribute('disableRemotePlayback', '');
    v.addEventListener('error', missing(v));
    v.addEventListener('ended', () => {
      // Only the video on screen moves the feed along; with auto-advance off, `loop` replays it instead.
      if (this.deps.autoAdvance() && this.slides[this.active] === s) this.advance(s, v);
    });
    v.src = s.item.url;
    s.el.replaceChildren(v, this.makeScrubber(s, v), h('div', { class: 'pause-icon' }, '❚❚'));
    s.video = v;
    if (this.slides[this.active] === s) void this.play(v);
  }

  /** Go to the next slide when a video finishes (or replay it if there is nothing after it). */
  private advance(s: Slide, v: HTMLVideoElement): void {
    if (this.slides.indexOf(s) < this.slides.length - 1) this.goNext(s);
    else {
      v.currentTime = 0;
      void this.play(v);
    }
  }

  /** Apply the auto-advance setting to videos already on screen. */
  applyPlayback(): void {
    for (const s of this.slides) if (s.video) s.video.loop = !this.deps.autoAdvance();
  }

  /** Progress bar you can drag to scrub. Pauses while dragging and resumes on release. */
  private makeScrubber(s: Slide, v: HTMLVideoElement): HTMLElement {
    const fill = h('i');
    const track = h('div', { class: 'track' }, fill);
    const label = h('span', { class: 'time' });
    const bar = h('div', { class: 'bar' }, track, label);
    s.bar = fill;
    const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    let scrubbing = false;
    let wasPlaying = false;

    const seek = (clientX: number) => {
      if (!v.duration) return;
      const r = track.getBoundingClientRect();
      // Stop just short of the end so scrubbing there doesn't instantly count as "finished".
      const f = Math.min(0.999, Math.max(0, (clientX - r.left) / r.width));
      v.currentTime = f * v.duration;
      fill.style.width = `${f * 100}%`;
      label.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
    };
    const finish = () => {
      if (!scrubbing) return;
      scrubbing = false;
      s.el.classList.remove('scrubbing');
      if (wasPlaying && !s.userPaused) void this.play(v);
    };

    bar.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      wasPlaying = !v.paused;
      v.pause();
      bar.setPointerCapture(e.pointerId);
      s.el.classList.add('scrubbing');
      seek(e.clientX);
      e.stopPropagation();
    });
    bar.addEventListener('pointermove', (e) => scrubbing && seek(e.clientX));
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', finish);
    // The tap that ends a drag must not also pause/unpause the video underneath.
    bar.addEventListener('click', (e) => e.stopPropagation());
    v.addEventListener('timeupdate', () => {
      if (!scrubbing && v.duration) fill.style.width = `${(v.currentTime / v.duration) * 100}%`;
    });
    return bar;
  }

  private release(s: Slide): void {
    s.wanted = false;
    if (s.video) {
      s.video.pause();
      s.video.removeAttribute('src');
      s.video.load();
      s.video = undefined;
      s.el.replaceChildren();
    }
    if (s.img) {
      s.img = undefined;
      s.el.replaceChildren();
    }
    s.userPaused = false;
  }

  private async play(v: HTMLVideoElement): Promise<void> {
    try {
      await v.play();
    } catch {
      // Browsers can refuse unmuted autoplay; play muted until the first touch, then unmute.
      if (!v.muted) {
        this.soundBlocked = true;
        this.applyMute();
        try {
          await v.play();
        } catch {
          /* needs a tap */
        }
      }
    }
  }

  private togglePause(s: Slide): void {
    if (!s.video || this.justUnlocked) return; // the tap that restored sound shouldn't also pause
    if (s.video.paused) {
      s.userPaused = false;
      void this.play(s.video);
      s.el.classList.remove('paused');
    } else {
      s.userPaused = true;
      s.video.pause();
      s.el.classList.add('paused');
    }
  }

  private toggleMute(): void {
    if (this.soundBlocked) return this.unlockSound();
    this.deps.setMuted(!this.deps.muted());
    const s = this.slides[this.active];
    // The tap is a user gesture, so unmuting here is allowed on iOS.
    if (s?.video && !s.userPaused) void this.play(s.video);
  }

  private updateMuteIcon(): void {
    this.muteBtn.textContent = this.effectiveMuted() ? '🔇' : '🔊';
    // Pulse when only the browser's autoplay rule is silencing us, so one tap on the screen restores sound.
    const blocked = this.soundBlocked && !this.deps.muted();
    this.muteBtn.classList.toggle('blocked', blocked);
    this.soundHint.hidden = !blocked;
  }

  private goNext(s: Slide): void {
    const i = this.slides.indexOf(s);
    const next = this.slides[i + 1];
    // iOS only lets a video start with sound while handling a tap. Done/Later/Keep scrolling are taps,
    // so start the next video right here instead of waiting for the scroll to finish.
    if (next?.video && !next.userPaused) {
      next.video.muted = this.effectiveMuted();
      void this.play(next.video);
    }
    next?.el.scrollIntoView({ behavior: 'smooth' });
  }

  /** A card takes its goals from the video it was written from: hidden when that video is only filed under parked goals. */
  private promptOk = (p: Prompt): boolean => {
    const v = p.sourceVideoId ? this.everything.get(p.sourceVideoId) : undefined;
    const goal = this.currentGoal();
    // With one goal picked, only cards written from a video filed under it (the user's own cards have no video, so they wait).
    if (goal) return !!v && feedVisible([v], this.deps.goals(), goal).length > 0;
    return !v || feedVisible([v], this.deps.goals()).length > 0;
  };

  /** The picked goal, or null when none is picked or it has been parked or removed since. */
  private currentGoal(): string | null {
    const id = this.deps.feedGoal();
    return id && this.deps.goals().some((g) => g.id === id && g.active) ? id : null;
  }

  private updateGoalPill(): void {
    const active = this.deps.goals().filter((g) => g.active);
    this.goalPill.hidden = active.length === 0;
    const goal = this.currentGoal();
    if (this.deps.feedGoal() && !goal) void this.deps.setFeedGoal(null); // that goal is no longer active: forget it
    this.goalPill.textContent = `${goal ? active.find((g) => g.id === goal)?.text : 'All active goals'} ▾`;
    this.goalPill.classList.toggle('narrowed', !!goal);
    if (!active.length) this.closeGoalMenu();
  }

  private closeGoalMenu(): void {
    this.goalMenu.hidden = true;
    this.goalPill.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.outsideGoalMenu, true);
    document.removeEventListener('keydown', this.escGoalMenu, true);
  }

  private outsideGoalMenu = (e: Event): void => {
    const t = e.target as Node;
    if (!this.goalMenu.contains(t) && !this.goalPill.contains(t)) this.closeGoalMenu();
  };

  private escGoalMenu = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.closeGoalMenu();
  };

  private toggleGoalMenu(): void {
    if (!this.goalMenu.hidden) return this.closeGoalMenu();
    const goals = this.deps.goals().filter((g) => g.active);
    const all = [...this.everything.values()];
    const current = this.currentGoal();
    const option = (id: string | null, label: string, count: number) =>
      h('button', {
        class: `goal-opt${id === current ? ' on' : ''}`, role: 'option', 'aria-selected': String(id === current),
        onclick: () => void this.chooseGoal(id),
      }, h('span', {}, label), h('span', { class: 'count' }, String(count)));
    this.goalMenu.replaceChildren(
      option(null, 'All active goals', feedVisible(all, this.deps.goals()).length),
      ...goals.map((g) => option(g.id, g.text, feedVisible(all, this.deps.goals(), g.id).length)),
    );
    this.goalMenu.hidden = false;
    this.goalPill.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.outsideGoalMenu, true);
    document.addEventListener('keydown', this.escGoalMenu, true);
  }

  private async chooseGoal(id: string | null): Promise<void> {
    this.closeGoalMenu();
    await this.deps.setFeedGoal(id);
    await this.refresh();
  }

  private fillChallenge(s: Slide): void {
    s.filled = true;
    s.prompt = this.deps.nextPrompt(undefined, this.promptOk);
    this.renderChallenge(s);
  }

  private renderChallenge(s: Slide): void {
    const p = s.prompt;
    const level = p?.level ?? this.deps.currentLevel();
    const card = h('div', { class: 'card' },
      h('div', { class: 'badge' }, `Level ${level} · ${LEVEL_NAMES[level] ?? ''}`),
      h('div', { class: 'hint' }, LEVEL_HINTS[level] ?? ''),
      h('p', { class: 'prompt' }, p ? p.text : 'Add a challenge in the menu to see it here.'),
      p?.need ? h('div', { class: 'chip' }, p.need) : null,
    );
    const source = p?.sourceVideoId ? this.items.get(p.sourceVideoId) : undefined;
    if (source) {
      card.append(h('button', { class: 'btn ghost small source', onclick: () => this.openSource(source) }, '▶ Watch the video this came from'));
    }
    if (p) {
      card.append(
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => void this.finishChallenge(s, card) }, 'Done ✓'),
          h('button', {
            class: 'btn', disabled: this.deps.isToday(p),
            onclick: () => {
              this.deps.addToday(p);
              this.renderChallenge(s);
            },
          }, this.deps.isToday(p) ? "On today's list ✓" : 'Do it today'),
          h('button', { class: 'btn', onclick: () => {
            s.prompt = this.deps.nextPrompt(p.id, this.promptOk);
            this.renderChallenge(s);
          } }, 'Swap'),
          h('button', { class: 'btn ghost', onclick: () => this.goNext(s) }, 'Later'),
        ),
      );
    } else {
      card.append(h('button', { class: 'btn ghost', onclick: () => this.goNext(s) }, 'Keep scrolling'));
    }
    s.el.replaceChildren(card);
  }

  /** Play the video a suggested challenge came from, in a full-screen overlay, then return to the feed. */
  private openSource(item: MediaItem): void {
    const feedVideo = this.slides[this.active]?.video;
    feedVideo?.pause();
    const v = h('video', { playsinline: true, controls: true, autoplay: true, 'webkit-playsinline': true });
    v.src = item.url;
    const close = () => {
      v.pause();
      v.removeAttribute('src');
      v.load();
      overlay.remove();
    };
    const overlay = h('div', { class: 'source-overlay' }, v, h('button', { class: 'btn small source-close', onclick: close }, 'Close'));
    this.root.append(overlay);
    // This runs inside the tap on the link, so playing with sound is allowed.
    void v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => {});
    });
  }

  private async finishChallenge(s: Slide, card: HTMLElement): Promise<void> {
    if (!s.prompt || s.done) return;
    s.done = true;
    const r = await this.deps.complete(s.prompt);
    card.querySelector('.actions')?.remove();
    card.append(h('div', { class: 'logged' }, 'Logged. That is how it compounds.'));
    if (r.leveledUp) card.append(h('div', { class: 'levelup' }, `Level up: ${LEVEL_NAMES[r.level]}`));
    card.append(h('button', { class: 'btn ghost', onclick: () => this.goNext(s) }, 'Keep scrolling ↓'));
  }
}
