# OODA Schema Mapping

This reference doc maps Mermate's five OODA tabs, the agent modes available at each tab, the rate-master limits that govern the pipeline, and the gpt-oss Mermaid Enhancer extension schema. It is intended to be read alongside the universal tracer output (`runs/ooda-trace-<run_id>.json`).

## 1. Tab Transition Matrix

| From Tab | To Tab | Frontend Stage | Trigger | Backend Route | Primary Artifact |
|----------|--------|----------------|---------|---------------|------------------|
| — | Simple Idea | `idea` | Render / Agent Run | `POST /api/agent/run` | `draft_text` / `md_source` |
| Simple Idea | Markdown Spec | `md` | Render / Agent Run | `POST /api/render` or agent | `md_source` |
| Markdown Spec | Mermaid | `mmd` | Render | `POST /api/render` | `mmd_source` / `png` / `svg` |
| Mermaid | TLA+ | `tla` | Render / Agent Run | `POST /api/render/tla` | `tla_source` / `cfg` |
| TLA+ | TypeScript | `ts` | Render / Agent Run | `POST /api/render/ts` | `ts_source` / harness |

The `WorkflowOrchestrator` in `public/js/mermaid-gpt-app.js` owns `STAGES = ['idea','md','mmd','tla','ts']` and merges `unlockedStages`, `completed`, `confidence`, and `guidance` into the UI after every backend round-trip.

## 2. Agent Modes

### Mode Registry
| Mode | Prompt File | Stage | Description |
|------|-------------|-------|-------------|
| `code-review` | `CODE-REVIEW-MODE.txt` | `mmd` | Recover architecture from a live codebase |
| `thinking` | `THINKING-MODE.txt` | `mmd` | Build architecture from ideas/notes |
| `optimize-mmd` | `OPTIMIZE-MMD-MODE.txt` | `mmd` | Improve existing Mermaid/markdown |
| `tla-verify` | `TLA-VERIFY-MODE.txt` | `tla` | Validate and repair TLA+ spec |
| `tla-optimize` | `TLA-OPTIMIZE-MODE.txt` | `tla` | Strengthen invariants and state coverage |
| `ts-generate` | `TS-GENERATE-MODE.txt` | `ts` | Compile TLA+ spec to TypeScript |
| `ts-optimize` | `TS-OPTIMIZE-MODE.txt` | `ts` | Improve generated TypeScript quality |
| `full-build` | `FULL-BUILD-MODE.txt` | `mmd` | Idea → Diagram → TLA+ → TypeScript → Bundle |

### Modes per Tab
- **idea**: `full-build`, `thinking`, `code-review`, `optimize-mmd`
- **md**: `thinking`, `optimize-mmd`, `full-build`
- **mmd**: `optimize-mmd`, `thinking`, `full-build`
- **tla**: `tla-verify`, `tla-optimize`
- **ts**: `ts-generate`, `ts-optimize`

### Role Domain Pool (`server/routes/agent.js`)
| Mode | Domains |
|------|---------|
| `thinking` / `full-build` | `formal_reasoning`, `systems_compilers`, `human_centric_systems`, `structural_precision` |
| `optimize-mmd` | `structural_precision`, `minimal_structure`, `programmatic_complexity` |
| `code-review` | `systems_compilers`, `formal_reasoning`, `narrative_orchestration` |

## 3. Agent Run Lifecycle & Limits

### Session Limits
| Setting | Default | Env Var |
|---------|---------|---------|
| Grace before stop | 5 min | `MERMATE_AGENT_GRACE` |
| Retention after end | 10 min | hard-coded |
| SSE event buffer | 3000 frames | hard-coded |

### Route Surface
- `POST /api/agent/run` — start a run
- `POST /api/agent/finalize` — final Max render with optional `user_notes`
- `GET /api/agent/modes` — mode metadata
- `GET /api/agent/attach/:id` — re-attach SSE to a detached session
- `POST /api/agent/stop/:id` — explicit stop/pause
- `GET /api/runs/:run_id/trace` — flattened tab-oriented trace (new)

### Agent Run Flow
1. Validate `mode` against `AGENT_MODES`
2. `runTracker.create()` with `mode`, `maxMode: true`, `enhance: true`, `inputMode`
3. `analyze(startText, currentStage)` → profile with `maturity`, `qualityScore`, `completenessScore`, `shadow`, `architectureDepthScore/Tier`
4. Planning: per-role `provider.infer('diagram_plan', ...)`
5. Refinement: `provider.infer('composition', ...)` or `inferMax`
6. Preview: `_fetchRender('/api/render', ...)` with `RENDER_TIMEOUT_MS` (default 660000 ms)
7. SSE: `preview_render`, `preview_ready`, `bundle_ready`

## 4. Rate-Master Limits (`server/services/rate-master-bridge.js`)

| Tier | RPM Default | Interval | Target Latency | Max Error | Soft Queue Limit |
|------|-------------|----------|----------------|-----------|------------------|
| ORCHESTRATOR | `MERMATE_ORCH_RPM` (30) | 60 s | 15 s | 8 % | 6 |
| WORKER | `MERMATE_WORKER_RPM` (60) | 60 s | 10 s | 5 % | 10 |
| FAST | `MERMATE_FAST_RPM` (120) | 60 s | 5 s | 5 % | 20 |
| LOCAL | `MERMATE_LOCAL_RPM` (4) | 1 s | 30 s | 15 % | 4 |

OODA cycle parameters: `cycleMs=5000`, `ewmaAlpha=0.25`, `scaleDownFactor=0.15`, `scaleUpFactor=0.12`, `minSamplesBeforeAct=5`.

## 5. Render Pipeline (`server/services/input-router.js`)

### Content Routing
- `detect(source)` → `TEXT`, `MD`, `MMD`, `HYBRID`
- **PATH A**: `MMD` → direct compile
- **PATH B**: `MD` / `HYBRID` + `enhance=true` + enhancer available → HPC-GoT (`fact_extraction` → `diagram_plan` → `composition`)
- **PATH C**: `TEXT` local deterministic `localTextToMmd`
- **PATH D**: `HYBRID` fallback to `localTextToMmd` after `bestEffortExtract` fails

### HPC-GoT Phases
1. `fact_extraction` — JSON entities/relationships/boundaries/gaps
2. `diagram_plan` — JSON directive/nodes/edges/subgraphs
3. `composition` — two branches (A/B) concurrently
4. `validate` — structural/invariant scoring
5. `select` — prune below threshold
6. `merge` — lightweight union of surviving branches
7. `output` — structural signature and final Mermaid

## 6. Inference Provider Chain (`server/services/inference-provider.js`)

Tiers: `ORCHESTRATOR` (gpt-5.6-sol), `WORKER` (gpt-5.6-terra), `FAST` (gpt-5.6-luna), `LOCAL` (gpt-oss:20b / enhancer).

| Stage Type | Preferred First | Fallback |
|------------|-----------------|----------|
| `copilot_suggest` | local Ollama | premium API |
| `copilot_enhance` | premium API | local Ollama |
| `render` / `enhance` / `decompose` / `repair` | premium API | Ollama → Python enhancer |

Default `INFER_TIMEOUT_MS` = 180000 ms; `MAX_TIMEOUT` = 360000 ms.

### Trace Events
`inference.trace` is now emitted after every provider attempt and final result:
```
{ stage, provider, model, result ∈ {ok, empty, noop, error, skipped}, latencyMs, error_class, outputLen? }
```

## 7. Run-Tracker Manifest (`server/services/run-tracker.js`)

Top-level fields captured in `getTrace(runId)`:
- `run_id`, `status`, `created_at`, `completed_at`, `tags`
- `tabs` — per-tab `{ present, ok, artifact, provider, model, latency_ms }`
- `phases` — lifecycle phase timeline
- `calls` — every `agent_call` with `stage`, `role`, `model`, `provider`, `latency_ms`, `success`, `error`, `action_tag`
- `branches`, `subviews`, `rate_events`, `failures`
- `consistency` — `has_diagram`, `has_tla`, `has_typescript`, `entity_drift`, `state_variable_drift`
- `totals`, `sum_check`

## 8. GPT-OSS Mermaid Enhancer Extension

### Service Endpoint
`POST /mermaid/enhance` dispatches on `stage`:
| Stage | Handler |
|-------|---------|
| `render` | `run_render_cycle` |
| `decompose` | `run_decompose_cycle` |
| `repair_from_trace` | `run_repair_from_trace` |
| `copilot_suggest` | `run_copilot_suggest` |
| `copilot_enhance` | `run_copilot_enhance` |
| (default) | `run_pipeline` deterministic OODA |

### Core Phase Cycle (`intelligence_core.py`)
1. Load dump context if `dump_id`
2. `classify` → `ClassificationResult`
3. `score_sufficiency` → `SufficiencyScore`
4. `decide_intervention` → `InterventionDecision`
5. Execute `STOP` / `VALIDATE` / `REPAIR` / `ENHANCE` / `TRANSFORM` / `RENDER` / `PREPARE_RENDER`
6. `validate_render` → `RenderValidationResult`
7. `repair` → `RepairResult`

### Key Schemas
- `ClassificationResult`: `input_type, user_intent, architecture_pattern, maturity_score, mermaid_fraction, problem_statement, entities, relationships`
- `SufficiencyScore`: `completeness, specificity, structural_quality, render_readiness, overall, is_sufficient, is_render_ready, gaps`
- `InterventionDecision`: `level, reasoning, target_output_type, use_premium_model, max_retries, use_max_model`
- `MermaidGenerationResult`: `mermaid_source, diagram_type, generation_method, confidence, warnings`
- `RenderValidationResult`: `status, is_renderable, errors, warnings, error_lines`
- `IntelligenceCycleResult`: aggregates all of the above plus `trace_log`, `provider_used`, `total_model_calls`, `success`, `failure_reason`

### Provider Routing (`provider_layer.py`)
| Intent | Primary | Fallback |
|--------|---------|----------|
| `COPILOT_SUGGEST` | `LOCAL_OLLAMA` | `API_TERRA` |
| `COPILOT_ENHANCE` | `API_TERRA` | `LOCAL_OLLAMA` |
| `RENDER` | `API_TERRA` | `LOCAL_OLLAMA` |
| `RENDER_MAX` | `API_SOL` | `API_TERRA` |
| `REPAIR` | `API_TERRA` | `LOCAL_OLLAMA` |
| `DECOMPOSE` | `API_TERRA` | `LOCAL_OLLAMA` |
| `AUDIT/ORGANIZE/VALIDATE` | `LOCAL_OLLAMA` | None |

## 9. Failure Class Taxonomy

| Class | Source | Trace Field |
|-------|--------|-------------|
| `timeout` | Premium/Ollama call hung | `error_class: timeout` |
| `rate_limit` | 429 or rate-master backpressure | `error_class: rate_limit` |
| `provider_exhausted` | All providers unavailable | `error_class: provider_exhausted` |
| `parse` | JSON/fenced output parse failed | `error_class: parse` |
| `schema` | Missing required structured fields | `error_class: schema` |
| `invalid_mermaid` | Mermaid directive or syntax invalid | `validation` / `render_validation` |
| `sany_failed` | TLA+ SANY parser/repair failed | `tla.sany.valid=false` |
| `tlc_violation` | TLC found invariant/deadlock violation | `tla.tlc.violations` |
| `tsc_failed` | TypeScript `tsc` failed | `ts.compile.success=false` |
| `test_failed` | TypeScript test harness failed | `ts.tests.success=false` |
| `completeness` | Manifest sum/check or required field missing | `failures` / `sum_check.issues` |

## 10. Reading a Trace File

`runs/ooda-trace-<run_id>.json` is produced by `scripts/ooda-lifecycle-tracer.js` and contains:
- `tabs` — quick pass/fail for each OODA tab
- `calls` — chronological inference calls with stage/provider/model/latency
- `rate_events` — rate-master decisions
- `failures` — deduplicated errors with `error_class`
- `consistency` — cross-tab artifact presence and drift placeholders
- `totals` — wall time, inference time, tokens, cost, counts
- `enhancer_telemetry` — gpt-oss Mermaid Enhancer records (if service reachable)

Use the per-tab `ok` and `failures` list to answer: "Why did this run fail or succeed?"
