// The user's goals (up to 10, each active or parked), stored on the server so every device shares them.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_GOALS = 10;
const MAX_TEXT = 200;
const MAX_PROMPT = 1500;

/** The goals the app started with. Old installs (one starred focus goal, no `active` flags) are moved onto these. */
export const STARTER_GOALS = [
  {
    id: 'discomfort', text: 'Learn to love discomfort', active: true,
    prompt: 'Write cards that put the user INSIDE an uncomfortable or painful experience, not cards about thinking or planning. Use things like: holding an exercise past the burn and staying 10 more seconds, cold water (a cold finish to the shower, hands in cold water), doing the task they have been avoiding for a set time, sitting still with a craving, getting up uncomfortable on purpose. Name the discomfort, tell them to stay in it a little longer than they want to, and tie it to what the speaker said. Effort and burn are the goal; injury is not, so say to stop on sharp pain.',
  },
  {
    id: 'body', text: 'Fix my body', active: true,
    prompt: 'Cards about actually training the body: planks, core work, back stability, upper body, bodyweight squats and push-ups (wall or knee versions are fine), cardio on a bike or brisk walking and stairs. Solo, no training partner, no boxing. Give specific sets, reps or times, and make the hard part clear.',
  },
  {
    id: 'invest', text: 'Learn to invest / grow business', active: false,
    prompt: 'The user is starting from zero with little money. Cards should be small, real first steps: look at one number, find out one fact, talk to one person who earns from investing or a business. Never give financial advice or name products.',
  },
  {
    id: 'study', text: 'Study / skill up', active: false,
    prompt: 'The user hates studying and has certifications to pass. Cards should be short, focused study actions: a 20 to 25 minute block with the phone away, on one specific topic. Make the discomfort of starting part of the card.',
  },
];

/** Validate whatever the client sent. Keeps well-formed goals only, assigns ids, and keeps the active flag (new goals start active). */
export function cleanGoals(input, newId = randomUUID) {
  const list = Array.isArray(input?.goals) ? input.goals : [];
  const used = new Set();
  const goals = [];
  for (const g of list) {
    const text = typeof g?.text === 'string' ? g.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
    if (!text) continue;
    const keep = typeof g?.id === 'string' && /^[\w-]{1,64}$/.test(g.id) && !used.has(g.id);
    const id = keep ? g.id : newId();
    used.add(id);
    const prompt = typeof g?.prompt === 'string' ? g.prompt.replace(/\r\n/g, '\n').trim().slice(0, MAX_PROMPT) : '';
    goals.push({ id, text, active: g?.active !== false, prompt });
    if (goals.length === MAX_GOALS) break;
  }
  return { goals };
}

/** True for the pre-"active" format, which stored a `focusId` and no active flags. */
const isOldShape = (v) => !!v && Array.isArray(v.goals) && 'focusId' in v;

/** Goals saved before they had instructions: fill in the starter text for the four known goals. */
function addStarterPrompts(raw) {
  let changed = false;
  const goals = raw.goals.map((g) => {
    if (typeof g?.prompt === 'string') return g;
    const starter = STARTER_GOALS.find((s) => s.id === g?.id);
    if (!starter) return g;
    changed = true;
    return { ...g, prompt: starter.prompt };
  });
  return changed ? { ...raw, goals } : raw;
}

export class Goals {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'goals.json');
    this.value = { goals: [] };
    this.saving = Promise.resolve();
  }

  async init() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (isOldShape(raw)) {
        await fs.copyFile(this.file, `${this.file}.before-active`);
        this.value = cleanGoals({ goals: STARTER_GOALS });
        await this.write();
      } else {
        const filled = addStarterPrompts(raw);
        this.value = cleanGoals(filled);
        if (filled !== raw) await this.write();
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return this;
  }

  get() {
    return this.value;
  }

  async set(input) {
    this.value = cleanGoals(input);
    await this.write();
    return this.value;
  }

  async write() {
    const snapshot = JSON.stringify(this.value, null, 2);
    const run = this.saving.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, this.file);
    });
    this.saving = run.catch(() => {});
    await run;
  }
}
