#!/usr/bin/env node
/**
 * rate-master CLI — live monitoring dashboard.
 *
 * Usage:
 *   npx rate-master          # demo mode with sample endpoints
 *   rate-master              # if installed globally
 *
 * Environment variables:
 *   RM_OODA_CYCLE_MS         OODA cycle interval in ms     (default: 5000)
 *   RM_METRICS_INTERVAL_MS   Metrics push interval in ms   (default: 3000)
 *   RM_LOCAL_MAX             Local AI max requests         (default: 4)
 *   RM_LOCAL_INTERVAL_MS     Local AI window in ms         (default: 1000)
 *   RM_EXTERNAL_MAX          External API max requests     (default: 60)
 *   RM_EXTERNAL_INTERVAL_MS  External API window in ms     (default: 60000)
 */

import { RateMaster } from "../src/RateMaster";
import { EndpointType, JobPriority } from "../src/types";

// ─── Config from environment ──────────────────────────────────────────────────

const env = (key: string, fallback: number) => {
  const v = process.env[key];
  const n = v ? parseInt(v, 10) : NaN;
  return isNaN(n) ? fallback : n;
};

const OODA_CYCLE_MS = env("RM_OODA_CYCLE_MS", 5_000);
const METRICS_MS = env("RM_METRICS_INTERVAL_MS", 3_000);
const LOCAL_MAX = env("RM_LOCAL_MAX", 4);
const LOCAL_INTERVAL = env("RM_LOCAL_INTERVAL_MS", 1_000);
const EXTERNAL_MAX = env("RM_EXTERNAL_MAX", 60);
const EXTERNAL_INTERVAL = env("RM_EXTERNAL_INTERVAL_MS", 60_000);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const rm = new RateMaster({
  endpoints: {
    "local-ai": {
      type: EndpointType.LOCAL_AI,
      maxRequests: LOCAL_MAX,
      intervalMs: LOCAL_INTERVAL,
      targetLatencyMs: 2_000,
      maxErrorRate: 0.1,
      minRequests: 1,
      maxRequestsHardCap: LOCAL_MAX * 4,
      softQueueLimit: 500,
    },
    "external-api": {
      type: EndpointType.EXTERNAL_API,
      maxRequests: EXTERNAL_MAX,
      intervalMs: EXTERNAL_INTERVAL,
      targetLatencyMs: 1_000,
      maxErrorRate: 0.05,
      minRequests: 1,
      maxRequestsHardCap: EXTERNAL_MAX * 2,
      softQueueLimit: 1_000,
    },
  },
  ooda: { cycleMs: OODA_CYCLE_MS },
  metricsIntervalMs: METRICS_MS,
});

// ─── Demo workload ────────────────────────────────────────────────────────────
// Simulate mixed-priority inference requests so the dashboard shows live data.

function fakeInference(endpoint: string, latencyMs: number, priority: JobPriority): void {
  rm.execute(
    endpoint,
    () => new Promise<string>((res) => setTimeout(() => res("ok"), latencyMs)),
    { priority }
  ).catch(() => undefined);
}

function spawnDemoLoad(): void {
  // Local AI: continuous low-volume critical + background mix
  setInterval(() => fakeInference("local-ai", 300 + Math.random() * 500, JobPriority.CRITICAL), 800);
  setInterval(() => fakeInference("local-ai", 200 + Math.random() * 300, JobPriority.BACKGROUND), 400);

  // External API: sporadic high-priority bursts
  setInterval(() => fakeInference("external-api", 100 + Math.random() * 200, JobPriority.HIGH), 1_200);
  setInterval(() => fakeInference("external-api", 50 + Math.random() * 100, JobPriority.NORMAL), 2_500);
}

// ─── ANSI dashboard ───────────────────────────────────────────────────────────

const CLEAR = "\x1b[2J\x1b[H";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function bar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  return GREEN + "█".repeat(filled) + DIM + "░".repeat(width - filled) + RESET;
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderDashboard(): void {
  const m = rm.getMetrics();
  const lines: string[] = [];

  lines.push(
    `${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`
  );
  lines.push(
    `${BOLD}${CYAN}║         rate-master  ·  live dashboard               ║${RESET}`
  );
  lines.push(
    `${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}`
  );
  lines.push(
    `  uptime ${CYAN}${formatMs(m.uptimeMs)}${RESET}   ` +
      `ooda-cycles ${CYAN}${m.oodaCycles}${RESET}   ` +
      `total-queue ${YELLOW}${m.totalQueueDepth}${RESET}   ` +
      `total-active ${GREEN}${m.totalActive}${RESET}`
  );
  lines.push("");

  for (const [name, ep] of Object.entries(m.endpoints)) {
    const util = ep.windowUsage / Math.max(ep.currentLimit, 1);
    const utilColor = util > 0.85 ? RED : util > 0.5 ? YELLOW : GREEN;

    lines.push(`  ${BOLD}${name}${RESET}  ${DIM}[${ep.type}]${RESET}`);
    lines.push(
      `    window  ${bar(ep.windowUsage, ep.currentLimit)} ` +
        `${utilColor}${ep.windowUsage}/${ep.currentLimit}${RESET} req`
    );
    lines.push(
      `    queue   ${YELLOW}${ep.queueDepth.toString().padStart(4)}${RESET}  ` +
        `active ${GREEN}${ep.activeRequests}${RESET}  ` +
        `executed ${ep.totalExecuted}  ` +
        `errors ${ep.totalErrors > 0 ? RED : ""}${ep.totalErrors}${RESET}`
    );
    lines.push(
      `    latency p50=${CYAN}${formatMs(ep.executionLatency.p50)}${RESET} ` +
        `p95=${CYAN}${formatMs(ep.executionLatency.p95)}${RESET} ` +
        `p99=${CYAN}${formatMs(ep.executionLatency.p99)}${RESET} ` +
        `wait=${DIM}${formatMs(ep.queueWaitLatency.avg)}${RESET}`
    );
    lines.push(
      `    errRate ${ep.errorRate > 0.05 ? RED : GREEN}${(ep.errorRate * 100).toFixed(1)}%${RESET}  ` +
        `rps ${CYAN}${ep.throughputRps.toFixed(2)}${RESET}  ` +
        `limit ${BOLD}${ep.currentLimit}${RESET} req/${formatMs(ep.intervalMs)}`
    );
    lines.push("");
  }

  const recentDecisions = rm.memory.decisions.slice(-3);
  if (recentDecisions.length > 0) {
    lines.push(`  ${DIM}── Recent OODA decisions ──────────────────────────${RESET}`);
    for (const d of recentDecisions) {
      const arrow =
        d.reason === "scale-up" ? GREEN + "▲" : d.reason === "scale-down" ? RED + "▼" : DIM + "─";
      lines.push(
        `  ${arrow}${RESET} ${d.endpoint.padEnd(14)} ${d.previousLimit} → ${BOLD}${d.newLimit}${RESET}  ` +
          `ewma=${formatMs(d.ewmaLatencyMs)} err=${(d.ewmaErrorRate * 100).toFixed(1)}% ` +
          `conf=${(d.confidence * 100).toFixed(0)}%`
      );
    }
    lines.push("");
  }

  lines.push(`  ${DIM}Press Ctrl+C to exit${RESET}`);

  process.stdout.write(CLEAR + lines.join("\n") + "\n");
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

console.log("Starting rate-master demo...");
spawnDemoLoad();

const dashInterval = setInterval(renderDashboard, 1_000);

rm.on("ooda:decision", (d) => {
  // Already visible in dashboard; nothing extra needed.
  void d;
});

process.on("SIGINT", () => {
  clearInterval(dashInterval);
  rm.destroy();
  process.stdout.write(RESET + "\nrate-master stopped.\n");
  process.exit(0);
});

process.on("SIGTERM", () => {
  rm.destroy();
  process.exit(0);
});
