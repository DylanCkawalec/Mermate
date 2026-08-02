# Changelog

All notable changes to Mermate are documented here. Public releases follow
[Semantic Versioning](https://semver.org). (The pre-public `mermaid-gpt`
lineage carried internal versions up to 5.0.0; public versioning starts at
1.0.0 and supersedes that numbering.)

## [1.0.0] — 2026-08-02

First public production release. The raw-idea → verified-artifact pipeline
(Simple Idea → Markdown Spec → Mermaid → TLA+ → TypeScript → desktop `.app`)
is complete, formally specified, and test-locked.

### Features

- **Winning Design control plane** — TLC-verified TLA+ specification
  (`docs/specs/MermateOrchestrator.tla`) implemented across seven stages:
  TypeScript tab gated on verified TLA+; dual-axis confidence (value +
  verification); storage-degraded alarm with sticky banner; boot recovery
  of completed runs; inference LRU cache (50 entries); `_persist()`
  microtask coalescing (~180ms → <10ms); invariant regression tests.
- **Formal verification pipeline** — SANY parse + TLC model check gates,
  repair budget (5+1), TLA+ MCP harness (direct jar subprocess),
  specula-engine submodule at v1.0.0.
- **Agent runtime** — detached sessions with SSE phase timeline, narration,
  telemetry, live metrics (tokens / cost / time), pause/resume, reload
  reattach, agent modes (Full Build / Thinking / Code Review / Optimize /
  Max) with explicit arm → run.
- **Per-tab version control** — compact chip per tab; run-lineage versions
  (idea/mmd reconstructable from `runs/*.json`) plus ring-buffered edit
  snapshots (15/stage); reversible restore (auto-snapshots current first);
  snapshot delete; immutable run lineage.
- **MCP bridge** — 22 tools, session management, stage previews, runtime
  logger, context memory, Python sidecar with tests.
- **Enhance** — large-input support (up to 80K chars, 180s scaled timeout),
  manual Enhance working on every tab.
- **Desktop app** — Rust compilation stage produces a distributable
  `rust_executable.app` (DMG layout, bundled Mermaid/TLA+/TS renderers).
- **Persistence** — orchestrator state in localStorage (single JSON payload,
  quota-safe trimming), artifact hydration on tab switch, reload reattach
  for live agent runs, localStorage abuse scanner in tests.
- **Boot** — gated sequence with per-dependency badges; Opseeq warm-up wait
  bounded to 8s (optional dependency never blocks boot); idle-gated 20s
  heartbeat with visibility cutoff.
- **Documentation** — public README with generated imagery; installation &
  deployment guide (every component, Opseeq optional, desktop packaging);
  consolidated `docs/opseeq.md`; product specification; ADR; formal axioms;
  Mermate skill tree (master + per-tab + infra sub-skills).

### Fixes

- Enhance failure on large input; session data vanishing across reloads.
- Auto-fire TLA+ verification and auto-chain continuation CTAs removed.
- Double repair loop in `validateWithScaffoldFastPath` removed.
- Trace envelope symmetry (`render_start` on local renders); AutoGuide
  `const` reassignment crash; dead architecture-stage reconstruction.
- `rate-master` queue timing (`queueWaitMs` always 0); `ports` bypass in
  compile retry; `inferMax` skipped in decompose path; enhancer health
  check caching.

### Quality

- **Tests**: 206 total / 200 pass / 0 fail (6 pre-existing dev-mode-only
  skips) — 13 invariant tests lock the winning design; tandem e2e
  self-spawns a server and exercises render → TLA+ → TS → Rust `.app`.
- **Security**: `npm audit` 0 high / 0 critical — exact dependency pins,
  multer 2.2.0, tar 7.5.22 override; no runtime secrets; path guards;
  rate limiting; request size caps.
- **Performance**: idea render ~10–20s typical (cached instant); TLA+ SANY
  ~2s; persistence <10ms coalesced; boot worst case 30s → 8s.
- **Evidence**: live headless-Chrome screenshots — boot, workspace, full
  agent run (phases, metrics, cost), version panel restore.

## [0.x] — pre-public (mermaid-gpt lineage)

Idea → Mermaid rendering, AI enhance, agent modes, TLA+ generation,
TypeScript build, gamified UX, OpenClaw wiring, OpenClaw MCP service,
search/embeddings pipeline, dark terminal UI, landing page.
