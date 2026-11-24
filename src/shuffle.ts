/**
 * Shuffle-bag with optional weights. Each round every item is served `weight` times (default 1) in
 * random order before the bag is refilled, so a weight-3 item appears three times per round and
 * nothing is starved. The same item is never served twice in a row when another item exists,
 * including across a round boundary.
 */
export class ShuffleBag<T> {
  private items: T[] = [];
  private queue: T[] = [];
  private last: T | undefined;

  constructor(
    items: T[] = [],
    private rand: () => number = Math.random,
    private weight: (t: T) => number = () => 1,
  ) {
    this.setItems(items);
  }

  /**
   * Copies per round. Capped at (items - 1): any more and there are too few other items to put
   * between the copies, so back-to-back repeats would be unavoidable in a small library.
   */
  private copies(t: T): number {
    return Math.min(Math.max(1, Math.round(this.weight(t))), Math.max(1, this.items.length - 1));
  }

  /**
   * Replace the item set and re-read weights. Removed items leave the queue, new items join this
   * round, and an unplayed item whose weight changed gains or loses its extra copies. Items already
   * played this round pick up their new weight when the bag is next refilled.
   */
  setItems(items: T[]): void {
    const keep = new Set(items);
    const known = new Set(this.items);
    this.items = [...items];
    const counts = new Map<T, number>();
    for (const x of this.queue) if (keep.has(x)) counts.set(x, (counts.get(x) ?? 0) + 1);
    for (const it of items) {
      const want = this.copies(it);
      const have = counts.get(it) ?? 0;
      if (!known.has(it) || have > want || (have > 0 && have < want)) counts.set(it, want);
    }
    this.queue = this.arrange(counts);
  }

  get size(): number {
    return this.items.length;
  }

  next(): T | undefined {
    if (this.items.length === 0) return undefined;
    if (this.queue.length === 0) {
      this.queue = this.arrange(new Map(this.items.map((t) => [t, this.copies(t)])));
    }
    this.last = this.queue.shift();
    return this.last;
  }

  /**
   * Random order of the given copies with no item twice in a row (and the first one different from
   * the item served last). Each step picks randomly among the items that still leave a valid
   * ordering, so heavy items are spread out evenly instead of ending up bunched together.
   */
  private arrange(counts: Map<T, number>): T[] {
    const out: T[] = [];
    let rem = 0;
    for (const c of counts.values()) rem += c;
    let prev = this.last;

    // After placing `y`, can the remaining copies still be ordered without repeats?
    const feasible = (y: T): boolean => {
      const left = rem - 1;
      for (const [x, c] of counts) {
        const n = c - (x === y ? 1 : 0);
        if (n > (x === y ? Math.floor(left / 2) : Math.ceil(left / 2))) return false;
      }
      return true;
    };

    while (rem > 0) {
      const open = [...counts].filter(([, c]) => c > 0);
      let pool = open.filter(([x]) => x !== prev && feasible(x));
      if (!pool.length) pool = open.filter(([x]) => x !== prev);
      if (!pool.length) pool = open; // only one distinct item left: a repeat is unavoidable
      let r = this.rand() * pool.reduce((n, [, c]) => n + c, 0);
      let pick = pool[pool.length - 1][0];
      for (const [x, c] of pool) {
        r -= c;
        if (r < 0) {
          pick = x;
          break;
        }
      }
      out.push(pick);
      counts.set(pick, (counts.get(pick) ?? 1) - 1);
      rem--;
      prev = pick;
    }
    return out;
  }
}
