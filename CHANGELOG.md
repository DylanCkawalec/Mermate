# Changelog

All notable changes to Mermate are documented here. Public releases follow
[Semantic Versioning](https://semver.org). (The pre-public `mermaid-gpt`
lineage carried internal versions up to 5.0.0; public versioning starts at
1.0.0 and supersedes that numbering.)

## [1.2.1] — 2026-08-09

Render fix: text/idea inputs now always use the LLM pipeline, regardless of
the Enhance flag.  Patch release — no breaking changes.

### Bug Fixes

- **Render without Enhance on text/idea inputs** — the `shouldUseProvider`
  gate in `render.js` required `enhance=true` for text/md/hybrid inputs to
  use the LLM pipeline (renderPrepare / HPC-GoT / decompose).  Without
  Enhance, text ideas fell through to `localTextToMmd` — a trivial local
  heuristic that produced a 1-node diagram (`N1[microservices e-commerce
  platform]`).  The LLM pipeline is the core rendering engine for text
  inputs and should always run.  The `enhance` flag now only controls
  Python enhancer pre-processing in the mmd path, not whether the LLM
  generates the diagram.

### Verified

- Idea without enhance: 27 lines, 7 entities rendered as proper nodes (was
  1 node before fix).
- Idea with enhance: 25 lines, same quality (no regression).
- Valid .mmd without enhance: renders fine (mmd path unchanged).
- Short idea without enhance: 8 lines with proper nodes and edges.
- 149 fast tests, 0 fail.

## [1.2.0] — 2026-08-09

Enhance preservation + surgical render repair. No breaking changes; drop-in
upgrade from 1.1.0.

### Features

- **Surgical line repair in render** — when a Mermaid diagram fails to
  compile, `compileWithRetry` now extracts a ±15-line context window around
  the error, sends only those lines to the model, and patches the returned
  fix back into the full source.  The rest of the diagram is never touched
  by the model.  This works even for user-authored `.mmd` with Enhance OFF
  (surgical repair is safe — it can't silently rewrite the diagram).
  Falls through to full-source model repair only if surgical repair is not
  applicable (no line number in error) or fails.
- **True enhancement for large .mmd** — the enhance source limit for
  structured formats (mmd/md/tla/ts) is now 80K chars (was 8K).  A 500-line
  `.mmd` is no longer truncated before the model sees it, so Enhance
  receives the full diagram and can enhance instead of summarizing a
  fragment.
- **Line-count preservation rule in enhance prompt** — the mmd refine
  prompt now includes an explicit hard rule: "The input has N non-empty
  lines. Your output MUST have at least N non-empty lines."  The
  `{LINE_COUNT}` placeholder is filled at runtime with the actual count.

### Bug Fixes

- **Enhance preservation guard** — after enhance, if the model's output has
  fewer than 70% of the input's non-empty, non-comment lines, the
  enhancement is rejected and the original is returned unchanged with a
  `preservation_guard` field explaining the rejection.  Catches the model
  silently summarizing a 200-line diagram into 50 lines.

### Tests

- Full `test:ci` suite green (149 fast + 17 compile, 0 fail).
- Live-verified: 216-line `aria.mmd` enhanced with 1.14x line ratio (model
  added detail, no content loss).
- Live-verified: broken `aria.mmd` (unbalanced bracket on line 50) repaired
  surgically — lines outside the ±15 window confirmed unchanged, 170KB SVG
  rendered.

## [1.1.0] — 2026-08-09

Agent intelligence pass + Mermaid repairer correctness fix. No breaking
changes; drop-in upgrade from 1.0.0.

### Features

- **Agent persona intelligence** — `agent-loader.js` now parses and injects
  `EXPERTISE SIGNALS` into the runtime prompt (prefixed with an
  interrogative directive), and `_buildPromptBlock` enforces identity-led,
  imperative voice instead of third-person descriptive phrasing. The
  `promptBlock` cap is now line-boundary-aware (no more mid-word truncation).
- **New personas** — five new agent `.txt` files added to round out the
  active domain registry: `ELIZABETH_DILLER`, `LINA_BO_BARDI`,
  `LUDWIG_MIES`, `MIES_VANDERROHE`, `REM_KOOLHAAS`.
- **Stage directive polish** — `_buildAgentRoleHeader` in
  `server/routes/agent.js` emits clearer stage-specific directives and a
  tighter fallback for unscoped roles.

### Bug Fixes

- **`mermaid-repairer.js` rule 8** — quote-stripping now only fires on
  plain labels (no `[](){}|<>&#;` inside). Previously the rule stripped
  quotes from labels that *required* them (e.g. `[Next]_vars`, `<br/>`,
  `(parens)`), turning valid user-authored diagrams into parse failures.
  Resolves the `aria.mmd` regression.
- **Error sanitization** — `_sanitizeCompileError` (input-router.js) and
  `_sanitizeError` (render.js) now preserve up to 3 context lines
  (offending text, caret, `Expecting …`) instead of amputating after the
  first line, so compile-failure toasts are actionable again.

### Tests

- `test-mermaid-repairer.js` — 2 new regression tests: reserved-char
  labels stay quoted; plain labels still get cleaned.
- Full `test:ci` suite green (149 fast + 17 compile, 0 fail).

## [1.0.0] — 2026-08-02

First public production release. The raw-idea → verified-artifact pipeline
(Simple Idea → Markdown Spec → Mermaid → TLA+ → TypeScript → desktop `.app`)
is complete, formally specified, and test-locked.

### Features

- **Formally specified control plane** — TLC-checked TLA+ specification
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
  skips) — 13 invariant tests lock the control-plane design; tandem e2e
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
