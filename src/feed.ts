import { h } from './dom';
import { ShuffleBag } from './shuffle';
import * as db from './db';
import { LEVEL_HINTS, LEVEL_NAMES } from './progress';
import type { Prompt } from './challenges';

export interface FeedDeps {
  interval(): number;
  muted(): boolean;
  setMuted(m: boolean): void;
  nextPrompt(excludeId?: string): Prompt | undefined;
  currentLevel(): number;
  complete(p: Prompt): Promise<{ leveledUp: boolean; level: number }>;
  openMenu(): void;
}

interface Slide {
  kind: 'video' | 'challenge';
  el: HTMLElement;
  videoId?: string;
  video?: HTMLVideoElement;
  url?: string;
  bar?: HTMLElement;
  loading?: boolean;
  wanted?: boolean;
  userPaused?: boolean;
  prompt?: Prompt;
  filled?: boolean;
  done?: boolean;
}

const BATCH = 6;

export class Feed {
  readonly root: HTMLElement;
  private scroller = h('div', { class: 'scroller', tabindex: 0 });
  private muteBtn = h('button', { class: 'fab mute', 'aria-label': 'Toggle sound', onclick: () => this.toggleMute() });
  private slides: Slide[] = [];
  private bag = new ShuffleBag<string>([]);
  private ids: string[] = [];
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
    this.updateMuteIcon();
  }

  /** Call whenever the library may have changed. Rebuilds only if the set of videos changed. */
  async refresh(): Promise<void> {
    const ids = (await db.listVideos()).map((v) => v.id);
    const same = ids.length === this.ids.length && ids.every((id) => this.ids.includes(id));
    if (same && this.slides.length) return;
    this.ids = ids;
    this.bag.setItems(ids);
    this.teardown();
    if (!ids.length) {
      this.scroller.replaceChildren(
        h(
          'section',
          { class: 'slide empty' },
          h('div', { class: 'empty-card' },
            h('h1', {}, 'No videos yet'),
            h('p', {}, 'Add the videos that motivate you. They stay on this device and play in random order.'),
            h('button', { class: 'btn primary', onclick: () => this.deps.openMenu() }, 'Add videos'),
          ),
        ),
      );
      return;
    }
    this.planned = await db.getSinceChallenge();
    this.scroller.replaceChildren();
    this.appendBatch();
    this.scroller.scrollTop = 0;
    await this.setActive(0);
  }

  applyMute(): void {
    for (const s of this.slides) if (s.video) s.video.muted = this.deps.muted();
    this.updateMuteIcon();
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
      if (!id) return;
      this.addSlide({ kind: 'video', videoId: id, el: h('section', { class: 'slide video' }) });
      this.planned++;
    }
  }

  private addSlide(s: Slide): void {
    this.slides.push(s);
    this.scroller.append(s.el);
    this.observer.observe(s.el);
    if (s.kind === 'video') {
      s.el.addEventListener('click', () => this.togglePause(s));
    }
  }

  private async setActive(i: number): Promise<void> {
    const changed = i !== this.active;
    this.active = i;
    this.slides.forEach((s, j) => {
      s.wanted = Math.abs(j - i) <= 1;
      if (s.wanted) void this.ensure(s, j === i);
      else this.release(s);
    });
    if (!changed) return;
    const cur = this.slides[i];
    if (cur.kind === 'video' && cur.videoId) {
      void db.markSeen(cur.videoId);
      void db.saveSinceChallenge(await db.getSinceChallenge().then((n) => n + 1));
    } else if (cur.kind === 'challenge') {
      void db.saveSinceChallenge(0);
    }
    if (i >= this.slides.length - 3) this.appendBatch();
  }

  private async ensure(s: Slide, isActive: boolean): Promise<void> {
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
    if (s.loading || !s.videoId) return;
    s.loading = true;
    const blob = await db.getBlob(s.videoId);
    s.loading = false;
    if (!blob || !s.wanted) {
      if (!blob) s.el.append(h('div', { class: 'missing' }, 'Video missing. Re-import it from the menu.'));
      return;
    }
    s.url = URL.createObjectURL(blob);
    const v = h('video', { playsinline: true, loop: true, preload: 'auto', 'webkit-playsinline': true });
    v.muted = this.deps.muted();
    v.setAttribute('disableRemotePlayback', '');
    v.src = s.url;
    s.bar = h('i');
    v.addEventListener('timeupdate', () => {
      if (v.duration && s.bar) s.bar.style.width = `${(v.currentTime / v.duration) * 100}%`;
    });
    s.el.replaceChildren(v, h('div', { class: 'bar' }, s.bar), h('div', { class: 'pause-icon' }, '❚❚'));
    s.video = v;
    if (this.slides[this.active] === s) void this.play(v);
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
    if (s.url) {
      URL.revokeObjectURL(s.url);
      s.url = undefined;
    }
    s.userPaused = false;
  }

  private async play(v: HTMLVideoElement): Promise<void> {
    try {
      await v.play();
    } catch {
      // Browsers can refuse unmuted autoplay; fall back to muted playback.
      if (!v.muted) {
        this.deps.setMuted(true);
        try {
          await v.play();
        } catch {
          /* needs a tap */
        }
      }
    }
  }

  private togglePause(s: Slide): void {
    if (!s.video) return;
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
    this.deps.setMuted(!this.deps.muted());
    const s = this.slides[this.active];
    // The tap is a user gesture, so unmuting here is allowed on iOS.
    if (s?.video && !s.userPaused) void this.play(s.video);
  }

  private updateMuteIcon(): void {
    this.muteBtn.textContent = this.deps.muted() ? '🔇' : '🔊';
  }

  private goNext(s: Slide): void {
    const i = this.slides.indexOf(s);
    this.slides[i + 1]?.el.scrollIntoView({ behavior: 'smooth' });
  }

  private fillChallenge(s: Slide): void {
    s.filled = true;
    s.prompt = this.deps.nextPrompt();
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
    if (p) {
      card.append(
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => void this.finishChallenge(s, card) }, 'Done ✓'),
          h('button', { class: 'btn', onclick: () => {
            s.prompt = this.deps.nextPrompt(p.id);
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
