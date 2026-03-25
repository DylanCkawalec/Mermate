"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobProcessor = void 0;
const events_1 = require("events");
const types_1 = require("./types");
// ─── JobProcessor ────────────────────────────────────────────────────────────
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
class JobProcessor extends events_1.EventEmitter {
    cfg;
    limiter;
    queue = [];
    dedup = new Set();
    activeWorkers = 0;
    concurrency;
    totalProcessed = 0;
    totalErrors = 0;
    totalRetries = 0;
    totalCancelled = 0;
    statsIntervalId;
    idleWaiters = [];
    constructor(config, limiter) {
        super();
        this.cfg = {
            name: "Unnamed Processor",
            onError: () => undefined,
            onCancel: () => undefined,
            retry: { maxRetries: 0, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
            ...config,
        };
        this.limiter = limiter;
        this.concurrency = config.concurrency;
    }
    // ─── Job submission ───────────────────────────────────────────────────────
    addJob(job, priority = types_1.JobPriority.NORMAL) {
        const key = JSON.stringify(job);
        if (this.dedup.has(key))
            return false;
        this.dedup.add(key);
        this.enqueueEntry({ job, key, priority, attempts: 0, addedAt: Date.now() });
        this.spawnWorkers();
        return true;
    }
    addJobs(jobs, priority = types_1.JobPriority.NORMAL) {
        let added = 0;
        for (const job of jobs) {
            if (this.addJob(job, priority))
                added++;
        }
        return added;
    }
    // ─── Controls ─────────────────────────────────────────────────────────────
    adjustConcurrency(newLimit) {
        if (newLimit < 1)
            throw new Error("concurrency must be ≥ 1");
        this.concurrency = newLimit;
        this.spawnWorkers();
    }
    /**
     * Cancel all pending (not yet executing) jobs.
     * Jobs currently being processed by a worker are not affected.
     */
    cancelAllPending() {
        const drained = this.queue.splice(0);
        this.dedup.clear();
        // Re-insert keys for actively running jobs so dedup still works.
        // (Active jobs have been removed from this.queue already; dedup.clear is safe
        //  because new addJob calls after cancel will proceed normally.)
        for (const entry of drained) {
            this.totalCancelled++;
            try {
                this.cfg.onCancel(entry.job);
                this.emit("cancelled", entry.job);
            }
            catch {
                // swallow
            }
        }
        this.checkIdle();
        return drained.length;
    }
    /** Promise that resolves when the queue is empty and all workers are done. */
    waitForIdle() {
        if (this.isIdle)
            return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }
    // ─── Stats ────────────────────────────────────────────────────────────────
    getStats() {
        return {
            name: this.cfg.name,
            endpoint: this.limiter?.endpoint ?? "none",
            queueDepth: this.queue.length,
            activeWorkers: this.activeWorkers,
            concurrency: this.concurrency,
            totalProcessed: this.totalProcessed,
            totalErrors: this.totalErrors,
            totalRetries: this.totalRetries,
            totalCancelled: this.totalCancelled,
            utilizationPct: ((this.activeWorkers / Math.max(1, this.concurrency)) *
                100).toFixed(1),
            isIdle: this.isIdle,
        };
    }
    startStatsLogging(intervalMs = 5_000) {
        if (this.statsIntervalId)
            clearInterval(this.statsIntervalId);
        this.statsIntervalId = setInterval(() => {
            const s = this.getStats();
            console.log(`[rate-master:${s.name}] q=${s.queueDepth} active=${s.activeWorkers}/${s.concurrency} ` +
                `processed=${s.totalProcessed} err=${s.totalErrors} retries=${s.totalRetries} ` +
                `cancelled=${s.totalCancelled} idle=${s.isIdle}`);
        }, intervalMs);
        return () => {
            if (this.statsIntervalId) {
                clearInterval(this.statsIntervalId);
                this.statsIntervalId = undefined;
            }
        };
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    get isIdle() {
        return this.queue.length === 0 && this.activeWorkers === 0;
    }
    enqueueEntry(entry) {
        // Insert in priority order (stable — preserve FIFO within same priority).
        let i = this.queue.length;
        while (i > 0 && this.queue[i - 1].priority > entry.priority)
            i--;
        this.queue.splice(i, 0, entry);
    }
    spawnWorkers() {
        while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
            this.activeWorkers++;
            this.workerLoop().catch(() => undefined);
        }
    }
    async workerLoop() {
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            if (!entry)
                continue;
            this.dedup.delete(entry.key);
            await this.processEntry(entry);
        }
        this.activeWorkers--;
        this.checkIdle();
    }
    async processEntry(entry) {
        const execute = () => Promise.resolve(this.cfg.processingFunction(entry.job));
        try {
            if (this.limiter) {
                await this.limiter.enqueue(() => execute(), entry.priority);
            }
            else {
                await execute();
            }
            this.totalProcessed++;
        }
        catch (err) {
            const retry = this.cfg.retry;
            if (entry.attempts < retry.maxRetries) {
                entry.attempts++;
                this.totalRetries++;
                const delay = this.backoffDelay(entry.attempts, retry);
                await sleep(delay);
                // Re-add to queue front for next attempt (same priority, no dedup check needed).
                this.queue.unshift(entry);
                this.dedup.add(entry.key);
            }
            else {
                this.totalErrors++;
                try {
                    this.cfg.onError(err, entry.job);
                    this.emit("error", err, entry.job);
                }
                catch {
                    // swallow
                }
            }
        }
    }
    backoffDelay(attempt, opts) {
        const base = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt - 1));
        if (!opts.jitter)
            return base;
        return base * (0.75 + Math.random() * 0.5); // ±25% jitter
    }
    checkIdle() {
        if (this.isIdle && this.idleWaiters.length > 0) {
            const waiters = this.idleWaiters.splice(0);
            for (const resolve of waiters)
                resolve();
            this.emit("idle");
        }
    }
}
exports.JobProcessor = JobProcessor;
// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=JobProcessor.js.map