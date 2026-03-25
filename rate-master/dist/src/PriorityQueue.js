"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriorityQueue = void 0;
/**
 * Generic binary min-heap priority queue.
 *
 * Invariants:
 *  - O(log n) push and pop.
 *  - Stable: items with equal priority are dequeued in insertion order (FIFO).
 *    Stability is achieved via a monotonic sequence number used as a tiebreaker,
 *    not by sorting arrays — the heap comparison uses (priority, seq) as a
 *    composite key.
 *  - Zero dependencies; pure TypeScript.
 */
class PriorityQueue {
    heap = [];
    seq = 0;
    get size() {
        return this.heap.length;
    }
    get isEmpty() {
        return this.heap.length === 0;
    }
    /**
     * Insert an item with the given numeric priority.
     * Lower numeric priority = higher urgency (min-heap).
     */
    push(item, priority) {
        this.heap.push({ item, priority, seq: this.seq++ });
        this.bubbleUp(this.heap.length - 1);
    }
    /**
     * Remove and return the highest-urgency item (lowest priority number).
     * Returns undefined if the queue is empty.
     */
    pop() {
        if (this.heap.length === 0)
            return undefined;
        const top = this.heap[0].item;
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.sinkDown(0);
        }
        return top;
    }
    /** Return the highest-urgency item without removing it. */
    peek() {
        return this.heap[0]?.item;
    }
    /** Remove all items. */
    clear() {
        this.heap.length = 0;
    }
    /**
     * Return all items as an unsorted array snapshot.
     * Does NOT drain the queue.
     */
    toArray() {
        return this.heap.map((n) => n.item);
    }
    // ─── Heap maintenance ────────────────────────────────────────────────────
    bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >>> 1;
            if (this.lt(i, parent)) {
                this.swap(i, parent);
                i = parent;
            }
            else {
                break;
            }
        }
    }
    sinkDown(i) {
        const n = this.heap.length;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            if (left < n && this.lt(left, smallest))
                smallest = left;
            if (right < n && this.lt(right, smallest))
                smallest = right;
            if (smallest === i)
                break;
            this.swap(i, smallest);
            i = smallest;
        }
    }
    /** True if heap[a] should come before heap[b]. */
    lt(a, b) {
        const ha = this.heap[a];
        const hb = this.heap[b];
        if (ha.priority !== hb.priority)
            return ha.priority < hb.priority;
        return ha.seq < hb.seq; // stable tiebreaker
    }
    swap(a, b) {
        const tmp = this.heap[a];
        this.heap[a] = this.heap[b];
        this.heap[b] = tmp;
    }
}
exports.PriorityQueue = PriorityQueue;
//# sourceMappingURL=PriorityQueue.js.map