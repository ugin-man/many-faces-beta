export type ScoredIndex = { i: number; score: number };
const compare = (a: ScoredIndex, b: ScoredIndex) => a.score - b.score || a.i - b.i;

/** Exact bounded selection: stable index ties match a full ascending sort. */
export class TopK {
  private readonly heap: ScoredIndex[] = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Invalid top-k capacity");
    this.capacity = capacity;
  }
  get full() { return this.heap.length === this.capacity; }
  get worstScore() { return this.full ? this.heap[0].score : Infinity; }
  offer(i: number, score: number) {
    const heap = this.heap;
    if (this.full) {
      const worst = heap[0];
      if (score > worst.score || (score === worst.score && i >= worst.i)) return;
      heap[0] = { i, score };
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && compare(heap[right], heap[left]) > 0 ? right : left;
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        parent = child;
      }
    } else {
      let child = heap.push({ i, score }) - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    }
  }
  sorted() { return this.heap.slice().sort(compare); }
}
