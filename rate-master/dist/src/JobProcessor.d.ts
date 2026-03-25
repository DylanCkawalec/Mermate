import { EventEmitter } from "events";
import type { ProcessorConfig } from "./types";
import { JobPriority } from "./types";
import { AdaptiveRateLimiter } from "./AdaptiveRateLimiter";
export interface ProcessorStats {
    name: string;
    endpoint: string;
    queueDepth: number;
    activeWorkers: number;
    concurrency: number;
    totalProcessed: number;
    totalErrors: number;
    totalRetries: number;
    totalCancelled: number;
    utilizationPct: string;
    isIdle: boolean;
}
/**
 * Priority-aware, retry-capable job processor that routes work through an
 * AdaptiveRateLimiter — the authoritative traffic shaper.
 *
 * Design:
 *  - Jobs are deduplicated by JSON serialisation (same key = one in-flight instance).
 *  - Priority ordering: CRITICAL jobs are always attempted before BACKGROUND.
 *  - Retry with exponential back-off + optional jitter prevents thundering herds.
 *  - cancelAllPending() drains the queue, firing onCancel for each job.
 *  - waitForIdle() resolves when both queue and active workers are empty.
 *  - adjustConcurrency() scales workers at runtime (hook for OODA integration).
 *
 * Events:
 *  "idle"      — emitted when queue empties and all workers finish.
 *  "error"     — (error, job) forwarded after all retries exhausted.
 *  "cancelled" — (job) for each job flushed by cancelAllPending().
 */
export declare class JobProcessor<T> extends EventEmitter {
    private readonly cfg;
    private readonly limiter?;
    private readonly queue;
    private readonly dedup;
    private activeWorkers;
    private concurrency;
    private totalProcessed;
    private totalErrors;
    private totalRetries;
    private totalCancelled;
    private statsIntervalId?;
    private readonly idleWaiters;
    constructor(config: ProcessorConfig<T>, limiter?: AdaptiveRateLimiter);
    addJob(job: T, priority?: JobPriority): boolean;
    addJobs(jobs: T[], priority?: JobPriority): number;
    adjustConcurrency(newLimit: number): void;
    /**
     * Cancel all pending (not yet executing) jobs.
     * Jobs currently being processed by a worker are not affected.
     */
    cancelAllPending(): number;
    /** Promise that resolves when the queue is empty and all workers are done. */
    waitForIdle(): Promise<void>;
    getStats(): ProcessorStats;
    startStatsLogging(intervalMs?: number): () => void;
    private get isIdle();
    private enqueueEntry;
    private spawnWorkers;
    private workerLoop;
    private processEntry;
    private backoffDelay;
    private checkIdle;
}
//# sourceMappingURL=JobProcessor.d.ts.map