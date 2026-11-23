import { h } from './dom';
import { ShuffleBag } from './shuffle';
import * as db from './db';
import { listMedia, type MediaItem } from './library';
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

export class Feed {
  readonly root: HTMLElement;
  private scroller = h('div', { class: 'scroller', tabindex: 0 });
  private muteBtn = h('button', { class: 'fab mute', 'aria-label': 'Toggle sound', onclick: () => this.toggleMute() });
  private slides: Slide[] = [];
  private bag = new ShuffleBag<string>([]);
  private ids: string[] = [];
  private items = new Map<string, MediaItem>();
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
    let list: MediaItem[];
    try {
      list = await listMedia();
    } catch (e) {
      console.error(e);
      this.teardown();
      this.ids = [];
      this.showMessage('Can\'t reach your server', 'Make sure the Motivati-scroll container is running and this device is on your home Wi-Fi.', 'Try again', () => void this.refresh());
      return;
    }
    const ids = list.map((v) => v.id);
    this.items = new Map(list.map((v) => [v.id, v]));
    const same = ids.length === this.ids.length && ids.every((id) => this.ids.includes(id));
    if (same && this.slides.length) return;
    this.ids = ids;
    this.bag.setItems(ids);
    this.teardown();
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
    const v = h('video', { playsinline: true, loop: true, preload: 'auto', 'webkit-playsinline': true });
    v.muted = this.deps.muted();
    v.setAttribute('disableRemotePlayback', '');
    v.addEventListener('error', missing(v));
    v.src = s.item.url;
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
