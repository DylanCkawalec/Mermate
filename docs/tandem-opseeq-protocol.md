# MERMATE ↔ Opseeq tandem protocol

This document describes how MERMATE correlates runs with **Opseeq**, how URLs are normalized, where **stage traces** live, and how the **idea → Mermaid → TLA+ → TypeScript → Rust → desktop app** path behaves today.

---

## 1. Roles

| Component | Role |
|-----------|------|
| **MERMATE** | Express API (`server/index.js`), render pipeline, formal stages (TLA+, TS, Rust), local trace store, static `/flows` and `/runs`. |
| **Opseeq** | Optional OpenAI-compatible gateway plus management APIs. When healthy, receives stage events and can serve as the inference base; when down, MERMATE keeps working with local traces and optional direct OpenAI fallback. |
| **Inference provider** | `server/services/inference-provider.js` — premium (OpenAI-compatible) chain with gateway → direct fallback, `X-Request-Id` correlation, and recorded fallback events for the UI. |

---

## 2. Environment: `OPSEEQ_URL` as the single service root

**`OPSEEQ_URL` must be the bare Opseeq origin — do not append `/v1`.**

Examples:

- Correct: `OPSEEQ_URL=http://localhost:9090`
- Avoid: `OPSEEQ_URL=http://localhost:9090/v1` (legacy; code strips a trailing `/v1` in some bridges, but the documented contract is the bare URL)

How paths are built:

| Consumer | Base | Typical path |
|----------|------|--------------|
| `inference-provider.js` | `OPENAI_BASE_URL` if set; else `OPSEEQ_URL` normalized to `…/v1` | `/chat/completions`, models, etc. |
| `opseeq-bridge.js` | `OPSEEQ_URL` with trailing slash and `/v1` stripped | `/health`, `/v1/chat/completions`, `/api/mermate/stage`, `/api/mermate/trace/:run_id` |
| `openclaw.js` | Normalized management base (no double `/v1`) | `/api/...` proxy routes |

**`OPENAI_BASE_URL`** (optional) overrides **only** the inference HTTP base. If you set it, include `/v1` (e.g. `http://localhost:9090/v1`).

**Images (DALL·E / GPT Image)** for packaged apps use `DALLE_API_KEY` (fallback: `OPENAI_API_KEY`) and `MERMATE_IMAGE_MODEL` (default `gpt-image-1`) in `server/services/icon-generator.js`. This is separate from the Opseeq chat path.

---

## 3. Shared trace ID: `run_id` and `X-Request-Id`

1. Each render allocates a **`run_id`** (UUID) when the enhanced/simple-idea pipeline runs.
2. **`provider.setTraceId(runId)`** is set for the duration of that render’s inference work and cleared in a `finally` block (`server/routes/render.js`).
3. Premium inference requests include **`X-Request-Id: <run_id>`** when a trace ID is set (`inference-provider.js`), so Opseeq (or any compatible gateway) can correlate HTTP logs with MERMATE’s run.

Stage reporting uses the same **`run_id`** string in JSON bodies and in the local trace store.

---

## 4. Stage events: emission, storage, readback

### 4.1 Emission

`opseeq-bridge.reportStage(runId, stageEvent)` is the single write path for “something happened in the pipeline.” It:

1. **Always** appends to the in-memory trace (`trace-store.js`).
2. **Best-effort** `POST` to Opseeq: `{ run_id, ...stageEvent }` at `OPSEEQ_URL/api/mermate/stage` (never blocks the pipeline on failure).

Emitters include (non-exhaustive):

| Location | Stages (examples) |
|----------|-------------------|
| `render.js` | `render_start`, `render_complete`, `render_failed` |
| `tla.js` | `tla_complete`, `tla_failed` |
| `ts.js` | `ts_complete`, `ts_partial`, `ts_failed` |
| `rust.js` | `rust_complete`, `rust_partial`, `rust_failed` |
| `agent.js` | `agent_planning`, `agent_preview`, `agent_finalize` |

Payloads include stage-specific fields (e.g. diagram name, SANY/TLC results, compile/test flags, desktop path).

### 4.2 Local storage (primary for MERMATE UI and tests)

- **In memory:** `server/services/trace-store.js` (`run_id` → event array, capped).
- **On disk:** `runs/<run_id>.trace.json` — appended on each `opseeq.reportStage` (flush via `traceStore.persist`) and again when the run is finalized (`run-tracker.finalize` → `traceStore.persist`) so later formal stages are durable without waiting for finalize.
- **Format:** Run manifests and trace files default to **compact JSON** (single-line) for smaller disk use and faster I/O. Set `MERMATE_RUN_JSON_PRETTY=1` when you need human-readable diffs. For **phase timing** instrumentation during performance work, set `MERMATE_DEBUG_PIPELINE=1` (posts structured timings to the Cursor debug ingest when that session is active).

### 4.3 MERMATE HTTP readback (always available if the server is up)

Mounted under `/api` via `server/routes/trace.js`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/mermate/stage` | Ingest one event (same shape as bridge; also used if Opseeq echoes or tools POST back). |
| `GET` | `/api/mermate/trace/:run_id` | Full event list for a run (loads from memory or `runs/*.trace.json`). |
| `GET` | `/api/mermate/trace-stats` | Store statistics. |

### 4.4 Opseeq readback (optional)

`opseeq-bridge.getTrace(runId)` calls `GET OPSEEQ_URL/api/mermate/trace/:run_id` when cross-service aggregation is needed. If Opseeq is down, callers should use MERMATE’s `GET /api/mermate/trace/:run_id` instead.

---

## 5. Direct OpenAI fallback visibility

When the configured base URL is not `https://api.openai.com/v1`, the provider may fall back to direct OpenAI if the gateway fails. Those episodes are collected as **`fallback_events`**.

- Render responses may include **`fallback_events`** when non-empty (`render.js`).
- The main UI shows a short **fallback banner** when the client sees that payload (`public/js/mermaid-gpt-app.js`).

This keeps “Opseeq in the loop” vs “direct provider” explicit for operators and users.

---

## 6. Auto Guide and `/api/guide/evaluate`

- **`POST /api/guide/evaluate`** (`server/routes/guide.js`) evaluates guide hints; when Opseeq is unhealthy it still returns **HTTP 200** with a heuristic payload and `fallback: true` so the client never hard-fails.
- **`public/js/mermate-autoguide.js`** polls this endpoint on an interval and merges AI suggestions with local heuristics (AI-weighted higher when present).

---

## 7. Formal pipeline, Specula alignment, and TLA+ management

- **TLA+:** Primary spec generation can use **Claude** (`CLAUDE_API_KEY`, `server/services/specula-llm.js` → `generateTlaSpec`) with a deterministic scaffold as fallback (`server/routes/tla.js`).
- **TypeScript:** After deterministic compilation, an **optional Claude review** may adjust TS against the TLA+ spec (`server/routes/ts.js`).
- **Artifacts:** Specula-style bundles under `flows/<diagram>/specula/` remain as described in [specula-integration.md](./specula-integration.md).

### 7.1 TLA+ Toolbox management API

The system provides a "no-code TLA+ management" layer over the Java runtime (SANY + TLC). Opseeq and MCP clients can drive the full lifecycle without directly invoking Java:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/render/tla/status` | Toolchain availability (Java, JAR, timeouts, Specula config). |
| `POST` | `/api/render/tla` | Full generate → validate → repair loop → persist. |
| `POST` | `/api/render/tla/check` | Quick **SANY-only** syntax check on raw TLA+ source (no `run_id` required). |
| `GET` | `/api/render/tla/errors/:run_id` | Read structured SANY/TLC errors and metrics for an existing run. |
| `POST` | `/api/render/tla/revalidate` | Re-run SANY + TLC (with optional LLM repair) on existing artifacts. Does not regenerate the spec. |
| `POST` | `/api/render/tla/edit` | Accept an edited TLA+ source, validate with SANY + TLC, persist on success. |

The corresponding MCP tools are `mermate_tla_check`, `mermate_tla_errors`, `mermate_tla_revalidate`, `mermate_tla_edit` (in `mcp_service/server.py`).

**Stage events** for TLA+ now include structured validation detail (repair attempts, TLC violation count, deadlock status, errors, state count, and wall-clock timing) so traces are useful for automated diagnosis.

---

## 8. Rust binary, desktop `.app`, landing page, and `skill.json`

When the Rust stage succeeds (`server/routes/rust.js`):

1. **Unique app name:** The packaged name includes a short **`run_id` suffix** so repeated runs do not overwrite the same Desktop app.
2. **Assets:** Custom **icon** and **hero** images via OpenAI Images API when keys are configured (`icon-generator.js`).
3. **Landing page:** Minimal product dashboard (hero, prompt shell, engine run UI) with a **collapsible audit bubble** for IPO-style stage verification and build metadata (`landing-page-generator.js`).
4. **Launcher:** The macOS `.app` uses an embedded **Python HTTP server** to serve static files and a **`/run`** endpoint that executes the bundled Rust engine (replacing fragile shell-only launchers).
5. **Opseeq-oriented manifest:** **`skill.json`** is written under `flows/<name>/skill.json` (and bundled in the app) so external agents can read purpose, trace location, and how to run the app.

---

## 9. End-to-end acceptance

The tandem chain is exercised by **`test/test-e2e-tandem.js`** (render → trace readback → TLA → TS → Rust → guide evaluate, with assertions on trace ordering and stage completion where applicable). Run via `./mermaid.sh test` or `node test/test-e2e-tandem.js` with the server available per the test’s expectations.

---

## 10. Quick reference: related files

| Concern | File(s) |
|---------|---------|
| Trace ID on inference | `server/services/inference-provider.js`, `server/routes/render.js` |
| Stage fan-out + Opseeq POST | `server/services/opseeq-bridge.js` |
| Local trace store | `server/services/trace-store.js` |
| MERMATE trace HTTP API | `server/routes/trace.js` |
| TLA+ toolbox management API | `server/routes/tla.js` (check/errors/revalidate/edit endpoints) |
| TLA+ Java integration (SANY+TLC) | `server/services/tla-validator.js` |
| TLA+ MCP tools | `mcp_service/server.py` (`mermate_tla_check`, `_errors`, `_revalidate`, `_edit`) |
| OpenClaw/Opseeq proxy URL fix | `server/routes/openclaw.js` |
| Packaged app + manifest | `server/routes/rust.js`, `server/services/landing-page-generator.js`, `server/services/icon-generator.js` |
