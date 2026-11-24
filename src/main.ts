import './styles.css';
import { h } from './dom';
import * as db from './db';
import { Feed } from './feed';
import { Panel } from './panel';
import { getGoals, listAcceptedChallenges, saveGoals } from './library';
import { availablePrompts, builtinPrompts, pickGoal, pickPrompt, withGoal, type GoalSet, type Prompt } from './challenges';
import { recordDone, stepLevel, type Progress } from './progress';
import { addItem, counts, hasItem, markDone, markDoneForPrompt, removeItem, rollover, type TodayList } from './today';

async function boot(): Promise<void> {
  let settings = await db.getSettings();
  let progress: Progress = await db.getProgress();
  let custom = await db.getCustomPrompts();
  // Session mute state starts from the saved preference; the speaker button changes it for this session.
  let muted = settings.muted;

  // Up to 10 goals, each active or parked, stored on the server so every device shares them.
  const fetchedGoals = await getGoals();
  let goalSet: GoalSet = fetchedGoals ?? { goals: [] };
  // One-time move of the old single per-device goal onto the server.
  const legacyGoal = (await db.getGoal()).trim();
  if (fetchedGoals && legacyGoal) {
    try {
      if (!goalSet.goals.length) goalSet = await saveGoals({ goals: [{ text: legacyGoal, active: true, prompt: '' }] });
      await db.saveGoal('');
    } catch (e) {
      console.error('could not move your goal to the server', e);
    }
  }

  // Claude-suggested challenges the user approved. Stored on the server so every device shares them.
  let approved: Prompt[] = await listAcceptedChallenges();

  const allPrompts = (): Prompt[] => availablePrompts([...builtinPrompts, ...approved, ...custom], goalSet.goals.length > 0);

  // Today's list: challenges the user committed to doing later. Unfinished ones carry over to the next day.
  let today = rollover(await db.getToday());
  void db.saveToday(today);
  const currentToday = (): TodayList => {
    const next = rollover(today); // also handles the app staying open past midnight
    if (next !== today) {
      today = next;
      void db.saveToday(today);
      feed.refreshToday();
    }
    return today;
  };
  const setToday = async (next: TodayList): Promise<void> => {
    today = next;
    await db.saveToday(today);
    feed.refreshToday();
  };

  const feed: Feed = new Feed({
    interval: () => settings.interval,
    muted: () => muted,
    setMuted: (m) => {
      muted = m;
      feed.applyMute();
    },
    nextPrompt: (excludeId, ok) => {
      const p = pickPrompt(ok ? allPrompts().filter(ok) : allPrompts(), progress.level, excludeId);
      return p && withGoal(p, pickGoal(goalSet) ?? '');
    },
    currentLevel: () => progress.level,
    complete: async (p) => {
      const r = recordDone(progress, settings.levelThreshold);
      progress = r.progress;
      await db.saveProgress(progress);
      // If this card was also on today's list, tick it off so it is never counted twice.
      await setToday(markDoneForPrompt(currentToday(), p));
      return { leveledUp: r.leveledUp, level: progress.level };
    },
    addToday: (p) => {
      const r = addItem(currentToday(), p);
      if (r.added) void setToday(r.list);
      return r.added;
    },
    isToday: (p) => hasItem(currentToday(), p),
    todayCount: () => counts(currentToday()),
    autoAdvance: () => settings.autoAdvance,
    openMenu: () => void panel.open(),
    goals: () => goalSet.goals,
    feedGoal: () => settings.feedGoal,
    setFeedGoal: async (id) => {
      settings = { ...settings, feedGoal: id };
      await db.saveSettings(settings);
    },
  });

  const panel: Panel = new Panel({
    settings: () => settings,
    progress: () => progress,
    custom: () => custom,
    today: () => currentToday(),
    completeToday: async (id) => {
      const list = currentToday();
      if (!list.items.some((i) => i.id === id && !i.done)) return { leveledUp: false, level: progress.level };
      const r = recordDone(progress, settings.levelThreshold);
      progress = r.progress;
      await db.saveProgress(progress);
      await setToday(markDone(list, id));
      return { leveledUp: r.leveledUp, level: progress.level };
    },
    removeToday: (id) => setToday(removeItem(currentToday(), id)),
    goals: () => goalSet,
    saveGoals: async (next) => {
      goalSet = await saveGoals(next);
    },
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      if ('muted' in patch) muted = settings.muted;
      await db.saveSettings(settings);
      feed.applyMute();
      feed.applyPlayback();
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
      void listAcceptedChallenges().then((list) => (approved = list));
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
