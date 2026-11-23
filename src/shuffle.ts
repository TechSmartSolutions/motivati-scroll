/**
 * Shuffle-bag: every item is served once, in random order, before any item
 * repeats. When the bag empties it is reshuffled, and the first item of the new
 * round is never the last item of the previous round (when more than one exists).
 */
export class ShuffleBag<T> {
  private items: T[] = [];
  private queue: T[] = [];
  private last: T | undefined;

  constructor(items: T[] = [], private rand: () => number = Math.random) {
    this.setItems(items);
  }

  /** Replace the item set. Unplayed items stay queued; new items join the queue. */
  setItems(items: T[]): void {
    const keep = new Set(items);
    const known = new Set(this.items);
    this.items = [...items];
    this.queue = this.queue.filter((x) => keep.has(x));
    const fresh = items.filter((x) => !known.has(x));
    if (fresh.length) {
      this.queue.push(...fresh);
      this.queue = this.shuffle(this.queue);
    }
  }

  get size(): number {
    return this.items.length;
  }

  next(): T | undefined {
    if (this.items.length === 0) return undefined;
    if (this.queue.length === 0) {
      this.queue = this.shuffle([...this.items]);
      if (this.queue.length > 1 && this.queue[0] === this.last) {
        const j = 1 + Math.floor(this.rand() * (this.queue.length - 1));
        [this.queue[0], this.queue[j]] = [this.queue[j], this.queue[0]];
      }
    }
    this.last = this.queue.shift();
    return this.last;
  }

  private shuffle(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
