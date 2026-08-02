# Mermate — Winning-Design Implementation Plan (for Kimi 3 MAX)

**Authority**: `docs/specs/MermateOrchestrator.tla` + `.cfg` — SANY-clean, TLC-verified
(992,588 states / 85,449 distinct / depth 21 / **no error found**, both temporal
properties hold). Every work item below cites the invariant it implements.
Do not deviate from the spec; if code reality forces a deviation, change the
spec first and re-run TLC.

Re-verify the spec after any spec edit:

```bash
cd docs/specs
java -XX:+UseParallelGC -cp ../../vendor/tla2tools.jar tlc2.TLC \
  -workers 4 -config MermateOrchestrator.cfg MermateOrchestrator.tla
```

## Verified findings (from spec-master analysis of the codebase)

| # | Finding | Spec clause that bars it | Where in code |
|---|---------|--------------------------|---------------|
| F1 | Confidence conflation: `RENDERED 1.0 > VERIFIED 0.95` — rendered-but-unverified outranks TLC-clean | `verified` is a separate axis from `art`/`completed` in the spec; confidence must be a 2-tuple | `public/js/mermaid-gpt-app.js` `CONFIDENCE` (~L120) |
| F2 | TS reachable without verified TLA+ (`mmd.unlocks='ts'` → `unlockedThrough('ts')` unlocks all) | `TSRequiresVerifiedTLA`, `UnlocksFor`, `VerifyTLA` grants ts atomically | `mermaid-gpt-app.js` `AGENT_ARTIFACT_RULES` (~L844), `unlockedThrough` (~L134) |
| F3 | Persistence degradation invisible to the user (console.warn only) | `HealthAlarm`, `VolatilePresenceAlarmed`, `VerifiedAlarmed` | `mermaid-gpt-app.js` `orchestrator._persist()` (~L255) |
| F4 | Terminal SSE events lost when browser detached; boot reattach only handles *running* sessions | `Reload` + agent-survives-reload semantics | `server/routes/agent.js` `/agent/active`; `mermaid-gpt-app.js` boot restore (~L3035) |
| F5 | Cost concentration in `decompose` (worker ×N) + `merge_composition` (orchestrator); no fact/plan caching across retries | out of spec scope (control plane); addressed as cost guardrail §4 | `server/services/inference-provider.js` `STAGE_MODEL_MAP` (~L213) |
| F6 | Enhance must never empty a non-empty artifact | `Enhance` action (`UNCHANGED memVars` presence contract) | `public/js/mermaid-gpt-copilot.js` `enhance()`; fixed — needs regression test |

## Stage 1 — Gate the TS stage on verified TLA+ (F2) — implements `TSRequiresVerifiedTLA`

1. `mermaid-gpt-app.js`: change `AGENT_ARTIFACT_RULES.mmd.unlocks` from `'ts'` to
   `'tla'`. Add a new unlock path: when SANY+TLC succeeds (the
   `onPipelineStage` tla branch and `/render/tla/check` response handler),
   call `orchestrator.updateFromBackend({ stage: 'tla', unlockedStages: unlockedThrough('ts'), … })`.
   This mirrors the spec exactly: **VerifyTLA is the only action that grants ts**.
2. `server/routes/agent.js`: in the full-pipeline path, do not emit the TS
   `pipeline_stage` unless the TLA stage reported `sany_valid` (the code
   already threads `sany_valid` through; enforce it as a hard precondition,
   matching `AgentEmit("ts")`'s guard).
3. UI: TS tab shows "Verify TLA+ to unlock" placeholder when
   `!orchestrator.isUnlocked('ts')` — `setMode` already guards on
   `isUnlocked`, so this is only a placeholder string change.

## Stage 2 — Split confidence into two axes (F1)

Replace the single `CONFIDENCE` scalar with `{ presence: 0|1, verification: 'none'|'draft'|'sany'|'tlc'|'tests' }`
in `orchestrator.state.confidence[stage]`. Update `updateFromBackend` callers
and the badge renderer. Keep the legacy numeric mapping as a derived getter
so existing toasts don't break. (`ponytail:` keep the numeric getter until
all readers migrate; then delete.)

## Stage 3 — Surface persistence degradation in the UI (F3) — implements `HealthAlarm`

`_persist()` already trims/retries/logs. Add: `window.dispatchEvent(new CustomEvent('mermate:storage-degraded'))`
in the degraded branch; `mermaid-gpt-app.js` listens and shows a persistent
(badge-level, not toast) indicator until a persist succeeds again
(= `RecoverStorage`). One listener, one badge, no new state machine.

## Stage 4 — Recover completed-run artifacts on boot (F4) — implements `Reload`

Boot reattach (`mermaid-gpt-app.js` ~L3035) currently only handles
`status === 'running'`. Extend: when the saved session is **not** live,
`GET /api/runs/:id` (run-tracker already persists per-run artifacts to
`runs/`), and if the run completed with artifacts, hydrate
`orchestrator.setArtifact` for each stage present, then
`_persistSession()`. This closes the "agent finished while I was away,
tabs are empty" hole without any server change.

## Stage 5 — Cost guardrails (F5)

1. Cache `fact_extraction` + `diagram_plan` outputs keyed by
   `hash(input_text)` in `inference-provider.js` (in-process Map, 50-entry
   LRU is enough) — retries and enhance-then-render flows currently
   re-derive identical facts on worker-tier tokens.
2. `decompose`: cap subviews at the depth tier's existing bound; skip the
   orchestrator-tier `merge_composition` when only one subview was produced
   (merge of one is identity).
3. Narration/suggestion stages stay on `gpt-5.6-luna` — already true; add a
   telemetry assert in `inference-telemetry.js` logging any narrator call
   that escalates above fast tier (should be zero).

## Stage 6 — Regression tests (one per invariant, ponytail-minimal)

Add `test/test-winning-design.js` (`node --test`):

- **F2/TSRequiresVerifiedTLA**: simulate artifact application
  (`md → mmd`) and assert `!isUnlocked('ts')`; then apply tla + sany_valid
  and assert `isUnlocked('ts')`.
- **F6/Enhance presence**: stub fetch failure in copilot enhance on a
  non-empty artifact; assert artifact text unchanged.
- **F3/HealthAlarm**: force `localStorage.setItem` to throw
  `QuotaExceededError`; assert the degraded event fires and artifacts
  survive in-memory.
- **F4/Reload recovery**: mock `/api/runs/:id` completed payload; assert
  boot hydration populates stage artifacts.

## Stage 7 — Keep the spec alive

- Any PR touching unlock rules, persistence, agent lifecycle, or the
  enhance path must state which spec action it modifies and re-run TLC.
- Follow-up module (not yet written): `MermateInference.tla` — the
  provider failover chain (premium→direct→ollama→enhancer) with the
  cost invariant "at most one provider bills per request" and tier
  escalation rules. Write it when the provider chain next changes.

## Explicitly out of scope (YAGNI)

- Multi-tab/last-writer-wins localStorage merge (single-user app; note the
  ceiling, add when collaborative editing appears).
- TLAPS proofs — TLC's exhaustive check at this state size is the
  appropriate assurance level.
- Content-level artifact modeling (presence is sufficient for every
  verified property).
