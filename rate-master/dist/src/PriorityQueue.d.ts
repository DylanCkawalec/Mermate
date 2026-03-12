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
export declare class PriorityQueue<T> {
    private readonly heap;
    private seq;
    get size(): number;
    get isEmpty(): boolean;
    /**
     * Insert an item with the given numeric priority.
     * Lower numeric priority = higher urgency (min-heap).
     */
    push(item: T, priority: number): void;
    /**
     * Remove and return the highest-urgency item (lowest priority number).
     * Returns undefined if the queue is empty.
     */
    pop(): T | undefined;
    /** Return the highest-urgency item without removing it. */
    peek(): T | undefined;
    /** Remove all items. */
    clear(): void;
    /**
     * Return all items as an unsorted array snapshot.
     * Does NOT drain the queue.
     */
    toArray(): T[];
    private bubbleUp;
    private sinkDown;
    /** True if heap[a] should come before heap[b]. */
    private lt;
    private swap;
}
//# sourceMappingURL=PriorityQueue.d.ts.map