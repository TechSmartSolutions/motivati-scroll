import './styles.css';
import { h } from './dom';
import * as db from './db';
import { Feed } from './feed';
import { Panel } from './panel';
import { builtinPrompts, pickPrompt, type Prompt } from './challenges';
import { recordDone, stepLevel, type Progress } from './progress';

async function boot(): Promise<void> {
  let settings = await db.getSettings();
  let progress: Progress = await db.getProgress();
  let custom = await db.getCustomPrompts();
  // Session mute state starts from the saved preference; the speaker button changes it for this session.
  let muted = settings.muted;

  const allPrompts = (): Prompt[] => [...builtinPrompts, ...custom];

  const feed: Feed = new Feed({
    interval: () => settings.interval,
    muted: () => muted,
    setMuted: (m) => {
      muted = m;
      feed.applyMute();
    },
    nextPrompt: (excludeId) => pickPrompt(allPrompts(), progress.level, excludeId),
    currentLevel: () => progress.level,
    complete: async () => {
      const r = recordDone(progress, settings.levelThreshold);
      progress = r.progress;
      await db.saveProgress(progress);
      return { leveledUp: r.leveledUp, level: progress.level };
    },
    openMenu: () => void panel.open(),
  });

  const panel: Panel = new Panel({
    settings: () => settings,
    progress: () => progress,
    custom: () => custom,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      if ('muted' in patch) muted = settings.muted;
      await db.saveSettings(settings);
      feed.applyMute();
    },
    shiftLevel: async (d) => {
      progress = stepLevel(progress, d);
      await db.saveProgress(progress);
    },
    addCustom: async (text, level) => {
      custom = [...custom, { id: `c-${Date.now()}`, level, text, custom: true }];
      await db.saveCustomPrompts(custom);
    },
    removeCustom: async (id) => {
      custom = custom.filter((c) => c.id !== id);
      await db.saveCustomPrompts(custom);
    },
    close: () => {
      panel.hide();
      void feed.refresh();
    },
  });

  const app = document.getElementById('app')!;
  app.append(feed.root, panel.root);
  maybeShowInstallBanner(app);
  await feed.refresh();
  keepScreenAwake();
}

function maybeShowInstallBanner(app: HTMLElement): void {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!isIos || standalone || localStorage.getItem('installBannerDismissed')) return;
  const banner = h('div', { class: 'install' },
    h('span', {}, 'For full screen: tap Share, then "Add to Home Screen", and open the app from that icon.'),
    h('button', { class: 'btn small', onclick: () => {
      localStorage.setItem('installBannerDismissed', '1');
      banner.remove();
    } }, 'Got it'));
  app.append(banner);
}

function keepScreenAwake(): void {
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<unknown> } }).wakeLock;
  if (!wl) return;
  const acquire = async () => {
    try {
      await wl.request('screen');
    } catch {
      /* not allowed right now */
    }
  };
  void acquire();
  // The lock is released whenever the page is hidden, so re-request on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void acquire();
  });
}

void boot();
