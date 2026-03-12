import { EventEmitter } from "events";
import type {
  EndpointConfig,
  ExecuteOptions,
  GlobalMetrics,
  ProcessorConfig,
  UpstreamFeedback,
} from "./types";
import { JobPriority } from "./types";
import { AdaptiveRateLimiter } from "./AdaptiveRateLimiter";
import { OODAController, type OODAConfig } from "./OODAController";
import { JobProcessor } from "./JobProcessor";
import { Telemetry, MemoryExporter, newTraceId } from "./Telemetry";

// ─── RateMaster configuration ─────────────────────────────────────────────────

export interface RateMasterConfig {
  /**
   * Named endpoint definitions.
   * At least one entry is required.
   * @example
   *   endpoints: {
   *     "openai":    { type: EndpointType.EXTERNAL_API, maxRequests: 60,  intervalMs: 60_000 },
   *     "local-llm": { type: EndpointType.LOCAL_AI,     maxRequests: 4,   intervalMs: 1_000  },
   *   }
   */
  endpoints: Record<string, EndpointConfig>;

  /** OODA controller tuning. Defaults are production-safe. */
  ooda?: Partial<OODAConfig>;

  /**
   * Metrics push interval (ms).
   * Set to 0 to disable periodic metric emission.
   * Default: 15_000.
   */
  metricsIntervalMs?: number;

  /**
   * Whether to write structured JSON spans/metrics to stdout.
   * Default: false (use addExporter() for custom output).
   */
  stdoutTelemetry?: boolean;
}

// ─── RateMaster ───────────────────────────────────────────────────────────────

/**
 * The parent rate limiter and traffic orchestrator for AI-native applications.
 *
 * RateMaster is the single entry point through which ALL AI inference traffic
 * flows. It:
 *
 *  1. Routes requests to per-endpoint AdaptiveRateLimiters.
 *  2. Applies OODA-driven adaptive limit adjustment on a recurring cycle.
 *  3. Surfaces a unified telemetry layer for tracing and metrics.
 *  4. Guarantees: NEVER denies a request. ALWAYS forwards. Shapes, never gates.
 *
 * Usage:
 * ```ts
 * const rm = new RateMaster({
 *   endpoints: {
 *     "openai":    { type: EndpointType.EXTERNAL_API, maxRequests: 60, intervalMs: 60_000 },
 *     "local-llm": { type: EndpointType.LOCAL_AI,     maxRequests: 4,  intervalMs: 1_000 },
 *   },
 * });
 *
 * // Direct execution
 * const result = await rm.execute("openai", () => openai.chat.completions.create({...}));
 *
 * // Batch job processing
 * const proc = rm.createProcessor<MyJob>("local-llm", { processingFunction: processJob, concurrency: 8 });
 * proc.addJobs(myJobs);
 * await proc.waitForIdle();
 *
 * rm.destroy();
 * ```
 *
 * Events:
 *  "ooda:decision"  (decision: OODADecision) — rate limit adjusted.
 *  "backpressure"   (endpoint: string, depth: number) — queue depth alert.
 *  "metrics"        (metrics: GlobalMetrics) — periodic snapshot.
 */
export class RateMaster extends EventEmitter {
  private readonly limiters = new Map<string, AdaptiveRateLimiter>();
  private readonly processors = new Map<string, Set<JobProcessor<unknown>>>();
  private readonly ooda: OODAController;
  readonly telemetry: Telemetry;
  readonly memory: MemoryExporter;

  private metricsIntervalId?: ReturnType<typeof setInterval>;
  private readonly startedAt = Date.now();

  constructor(config: RateMasterConfig) {
    super();

    this.memory = new MemoryExporter(200);
    this.telemetry = new Telemetry([this.memory]);

    const ooda = new OODAController(config.ooda ?? {}, this.telemetry);
    this.ooda = ooda;

    ooda.on("decision", (d) => this.emit("ooda:decision", d));

    // Register all endpoints.
    for (const [name, cfg] of Object.entries(config.endpoints)) {
      this.registerEndpoint(name, cfg);
    }

    ooda.start();

    const metricsMs = config.metricsIntervalMs ?? 15_000;
    if (metricsMs > 0) {
      this.metricsIntervalId = setInterval(() => {
        const m = this.getMetrics();
        this.telemetry.emitMetrics(m);
        this.emit("metrics", m);
      }, metricsMs);
    }
  }

  // ─── Endpoint management ──────────────────────────────────────────────────

  /**
   * Register a new endpoint at runtime (hot-add).
   * Endpoints registered in the constructor are already available.
   */
  public registerEndpoint(name: string, config: EndpointConfig): void {
    if (this.limiters.has(name)) {
      throw new Error(`Endpoint "${name}" is already registered.`);
    }

    const limiter = new AdaptiveRateLimiter(name, config);

    limiter.on("backpressure", (depth: number) =>
      this.emit("backpressure", name, depth)
    );

    this.limiters.set(name, limiter);
    this.ooda.register(name, limiter);
  }

  public deregisterEndpoint(name: string): void {
    const limiter = this.limiters.get(name);
    if (!limiter) return;
    limiter.cancelAll();
    this.limiters.delete(name);
    this.ooda.deregister(name);
  }

  // ─── Direct execution ─────────────────────────────────────────────────────

  /**
   * Execute an async function through the named endpoint's rate limiter.
   *
   * - Always queues and eventually resolves.
   * - Priority defaults to NORMAL.
   * - Pass traceId to correlate with your own distributed traces.
   */
  public execute<R>(
    endpoint: string,
    fn: () => Promise<R>,
    options: ExecuteOptions = {}
  ): Promise<R> {
    const limiter = this.requireLimiter(endpoint);
    const traceId = options.traceId ?? newTraceId();
    const priority = options.priority ?? JobPriority.NORMAL;

    const enqueuedAt = Date.now();

    return limiter
      .enqueue(fn, priority, { traceId, timeoutMs: options.timeoutMs })
      .then((result) => {
        this.telemetry.emitSpan({
          traceId,
          spanId: newTraceId(),
          endpoint,
          priority,
          queueWaitMs: 0, // enriched inside AdaptiveRateLimiter
          executionMs: Date.now() - enqueuedAt,
          success: true,
          timestamp: Date.now(),
        });
        return result;
      });
  }

  /**
   * Feed upstream response metadata (e.g. parsed rate-limit headers) back
   * to the endpoint's limiter for immediate self-calibration.
   */
  public feedback(endpoint: string, fb: UpstreamFeedback): void {
    this.requireLimiter(endpoint).feed(fb);
  }

  // ─── Job processor factory ────────────────────────────────────────────────

  /**
   * Create a JobProcessor wired to the named endpoint's rate limiter.
   * The processor inherits OODA-driven limit adjustments automatically.
   */
  public createProcessor<T>(
    endpoint: string,
    config: ProcessorConfig<T>
  ): JobProcessor<T> {
    const limiter = this.requireLimiter(endpoint);
    const proc = new JobProcessor<T>(config, limiter);

    if (!this.processors.has(endpoint)) {
      this.processors.set(endpoint, new Set());
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.processors.get(endpoint) as Set<JobProcessor<unknown>>).add(proc as any);

    proc.once("idle", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.processors.get(endpoint)?.delete(proc as any);
    });

    return proc;
  }

  // ─── Bulk controls ────────────────────────────────────────────────────────

  /**
   * Cancel all queued (not yet executing) requests across ALL endpoints.
   * Running requests complete normally.
   */
  public cancelAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, limiter] of this.limiters) {
      result[name] = limiter.cancelAll();
    }
    return result;
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────

  public getMetrics(): GlobalMetrics {
    const endpoints: GlobalMetrics["endpoints"] = {};
    let totalQueue = 0;
    let totalActive = 0;

    for (const [name, limiter] of this.limiters) {
      const m = limiter.getMetrics();
      endpoints[name] = m;
      totalQueue += m.queueDepth;
      totalActive += m.activeRequests;
    }

    return {
      uptimeMs: Date.now() - this.startedAt,
      endpoints,
      totalQueueDepth: totalQueue,
      totalActive,
      oodaCycles: this.ooda.cycles,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Graceful shutdown: stop OODA, stop metrics interval. */
  public destroy(): void {
    this.ooda.stop();
    if (this.metricsIntervalId) {
      clearInterval(this.metricsIntervalId);
      this.metricsIntervalId = undefined;
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private requireLimiter(endpoint: string): AdaptiveRateLimiter {
    const limiter = this.limiters.get(endpoint);
    if (!limiter) {
      throw new Error(
        `Unknown endpoint "${endpoint}". ` +
          `Registered endpoints: [${[...this.limiters.keys()].join(", ")}]`
      );
    }
    return limiter;
  }
}
