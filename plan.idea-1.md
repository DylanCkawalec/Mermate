


Disable MD

Edit File

Split Edit

Preview Edit










Change to GitHub Flavored Markdown
OODA Lifecycle Tracer + Full-Build Flow Fixes#
Summary: Fix the full-build agent flow so it skips re-processing when starting from mmd/md with a valid run_id, add progress feedback for long inference calls, and rewrite the tracer script to follow the real UI lifecycle — so one script run reveals every dimension, edge, failure, and data schema transition from simple idea to final TypeScript.

1. The OODA Intent of Each Tab#
Each tab is an OODA cycle. The output schema of one tab becomes the input schema of the next. The “best outcome” at each tab is the schema that unlocks the next tab with maximum fidelity (no data loss, no premature simplification).

Tab 1: Simple Idea (idea)#
Observe: Raw text — ideas, notes, speech-to-text, problem statements
Orient: input-analyzer.js classifies maturity, quality, completeness, extracts shadow entities/relationships/gaps, computes depth score/tier
Decide: Which agent mode to run (thinking, full-build, code-review, optimize-mmd). Enhance flag on/off.
Act: POST /api/agent/run → SSE stream: planning (multi-role infer) → refinement (infer) → preview render (POST /api/render with input_mode: 'idea', enhance: true)
Output schema: draft_text (markdown prose), md_source (structured markdown), mmd_source (preview mermaid), run_id, diagram_name
Best outcome: Rich markdown spec with entities, relationships, boundaries, failure paths → unlocks md and mmd tabs
Tab 2: Markdown Spec (md)#
Observe: Markdown artifact from idea tab, or pasted/uploaded .md
Orient: input-detector.js classifies as MD, HYBRID, or TEXT. input-analyzer.js profiles maturity.
Decide: Continue agent (thinking), optimize (optimize-mmd), or full-build. Enhance flag routes to HPC-GoT pipeline.
Act: POST /api/render with input_mode: 'md', enhance: true → HPC-GoT: fact_extraction (JSON) → diagram_plan (JSON) → composition (Mermaid text) → compile/repair → validate
Output schema: compiled_source (valid Mermaid), markdown_source (enhanced md), diagram_name, paths (png/svg), run_id, mmd_metrics, depth_score, depth_tier
Best outcome: Valid Mermaid with all entities from markdown represented as nodes, all relationships as edges → unlocks mmd tab
Tab 3: Mermaid (mmd)#
Observe: Mermaid source from render, or pasted/uploaded .mmd
Orient: input-detector.js classifies as MMD or HYBRID. Compile + repair via mermaid-repairer.js.
Decide: Optimize (optimize-mmd), rework (thinking), or full-build. Enhance flag off for clean MMD.
Act: POST /api/render with input_mode: 'mmd', enhance: false → direct compile + repair + validate. Or agent optimize-mmd mode for AI-driven improvement.
Output schema: compiled_source (repaired Mermaid), paths (png/svg), run_id, mmd_metrics, validation (svg_valid, png_valid)
Best outcome: Compiled, validated Mermaid with SVG/PNG paths, stored in run tracker → unlocks tla tab
Tab 4: TLA+ (tla)#
Observe: Mastered run (run_id + diagram_name) from mmd tab
Orient: Extract facts and plan from run_data.agent_calls (HPC-GoT path) or on-demand fact_extraction from original input
Decide: Verify (tla-verify) or optimize (tla-optimize). Agent routes to /api/render/tla/edit (with run_id) or /api/render/tla/check (standalone).
Act: POST /api/render/tla with run_id → Specula LLM generates TLA+ spec → SANY parse → TLC model check → repair loop
Output schema: tla_source, cfg_source, sany: {valid, repairAttempts, error}, tlc: {checked, statesExplored, violations, invariantsChecked}, metrics: {variableCount, actionCount, invariantCount, entityCoverage}, verification
Best outcome: SANY-valid TLA+ spec with all entities as variables, all actions as TLA actions, invariants checked by TLC with 0 violations → unlocks ts tab
Tab 5: TypeScript (ts)#
Observe: TLA+ artifacts (tla_artifacts.tla, tla_artifacts.cfg) from run data
Orient: Extract facts/plan from run data, load TLA+ spec and config
Decide: Generate (ts-generate) or optimize (ts-optimize)
Act: POST /api/render/ts with run_id → TLA+ → TypeScript compiler → tsc compile → test harness → coverage analysis → repair loop
Output schema: ts_source, compile: {success, repairs, wallClockMs}, tests: {success, checked, repairs, wallClockMs}, coverage: {entityCoverage, actionCoverage, invariantCoverage}, traces
Best outcome: tsc pass, test harness pass, coverage > 80% on all three dimensions → pipeline complete, bundle ready
2. Data Schema Transition Map#
text

Copy
idea (text)
  │
  ├─ agent.run(mode=thinking) ──▶ SSE: draft_text, md_source, mmd_source, run_id
  │
  ▼
md (markdown)
  │
  ├─ render(input_mode=md, enhance=true) ──▶ HPC-GoT: facts(JSON) → plan(JSON) → composition(Mermaid)
  │                                         ──▶ compiled_source, paths, mmd_metrics, depth_score
  ▼
mmd (mermaid)
  │
  ├─ render(input_mode=mmd, enhance=false) ──▶ compile + repair + validate
  │                                         ──▶ compiled_source, paths, validation
  ▼
tla (TLA+ spec)
  │
  ├─ render/tla(run_id) ──▶ specula LLM → SANY → TLC → repair
  │                       ──▶ tla_source, cfg_source, sany, tlc, metrics
  ▼
ts (TypeScript runtime)
  │
  ├─ render/ts(run_id) ──▶ TLA→TS compiler → tsc → harness → coverage
  │                       ──▶ ts_source, compile, tests, coverage, traces
  ▼
DONE — bundle_ready
Key schema relations (cross-stage consistency):

Entity names in facts.entities[].name must appear as node IDs in compiled_source
Entity names must appear as state variables in tla_source
TLA+ actions must map to TypeScript runtime methods
TLA+ invariants must be checked by the test harness
3. Root Cause Analysis (from errors.txt)#
The user started full-build from the mmd tab (they had content in idea/md/mmd from a prior run, wanted TLA+). Here’s what went wrong:

Problem 1: Full-build from mmd re-runs the entire planning pipeline#
POST /api/agent/run with mode: 'full-build', current_stage: 'mmd' — no stage-specific shortcut exists for full-build
Only tla-verify/tla-optimize (from tla) and ts-generate/ts-optimize (from ts) have early exits (lines 466-514 of agent.js)
Full-build from mmd falls through to planning (4 concurrent roles × copilot_enhance = 186.5s), refinement, then preview render
The agent re-processed content the user already had instead of going straight to TLA+ generation
Problem 2: Agent auto-switches to md tab, so finalize uses markdown not Mermaid#
Planning produces a new markdown draft → onDraftUpdate routes it to md tab (line 2676 of mermaid-gpt-app.js)
Agent auto-switches to md tab via _scheduleAutoSwitchToStage
User clicks “Render as is” → agent.finalize(input.value, currentMode, currentRunId) (line 2849)
currentMode is now 'md', input.value is the markdown draft
Finalize sends current_stage: 'md' → finalInputMode = 'md', enhance = true (lines 1065-1073 of agent.js)
/api/render with input_mode: 'md', enhance: true → HPC-GoT pipeline → stuck on Phase 2/7
Problem 3: HPC-GoT ANALYZE phase is slow with no progress#
fact_extraction inference call (the first HPC-GoT stage) can take 30-180s depending on provider
The only UI feedback is ▹ Phase 2/7 — Extract facts, plan diagram, compute structural signature from the terminal narrator
No timing, no provider info, no “still working” signal between phase entry and completion
Problem 4: Preview render fails silently with Mermaid lexical error#
Render failed — Error: Lexical error on line 66. Unrecog — truncated error message
The user is told “Preview compile issue — you can still finalize” but doesn’t know what’s wrong or how to fix it
Problem 5: No clear agent intent display#
The user can’t tell if the agent is “making TLA+” or “updating markdown”
The stage SSE events say planning, refining, preview — but don’t say what the goal is
Data Schema Problem#
The core data problem: the agent loses the Mermaid artifact during full-build from mmd. The agent should have recognized the existing Mermaid, repaired it, and chained directly to TLA+ → TS. Instead, it re-processed everything from scratch, lost the mmd artifact, and got stuck re-running HPC-GoT on markdown.

4. Plan#
Step 1: Add full-build shortcut for mmd stage in agent run#
In server/routes/agent.js, add an early exit for full-build from mmd with a current_run_id:

js

Copy
// After the tla/ts early exits (line ~514), before the general planning path:
if (mode === 'full-build' && currentStage === 'mmd' && current_run_id) {
  // Skip planning/refinement — the user already has a Mermaid diagram.
  // Go directly to preview render with the existing mmd source.
  sendEvent('stage', { stage: 'preview', message: 'Compiling existing Mermaid diagram...' });
  const previewData = await _fetchRender('/api/render', {
    mermaid_source: startText,
    input_mode: 'mmd',
    enhance: false,
    max_mode: true,
    audit_run_id: auditId,
    parent_run_id: parentRunId,
    agent_mode: mode,
  }, abort);
  // ... emit preview_render / preview_ready as normal
  // The finalize step will chain TLA+ and TS
}
This skips 4 concurrent inference calls (186.5s) and goes straight to compile/repair.

Step 2: Fix finalize stage routing for full-build#
In server/routes/agent.js finalize endpoint, when mode === 'full-build':

js

Copy
// If the current_stage is mmd and the text looks like Mermaid,
// don't re-run HPC-GoT — just compile and chain to TLA+/TS.
if (mode === 'full-build' && currentStage === 'mmd') {
  finalInputMode = 'mmd';
  enhance = false;
}
Also: the finalize should preserve the original stage the agent was started from, not use whatever tab the user happens to be viewing. Pass agent_start_stage from the agent run to finalize.

Step 3: Add progress sub-events during HPC-GoT phases#
In server/services/input-router.js, emit progress SSE events within each phase:

js

Copy
// Before each inference call in renderHPCGoT:
_emitPipelinePhase('pipeline.hpc.analyze.fact_extraction', { 
  runId, stage: 'fact_extraction', provider: 'pending', useMax 
});
// After:
_emitPipelinePhase('pipeline.hpc.analyze.fact_extraction.done', { 
  runId, stage: 'fact_extraction', provider: result.provider, 
  latencyMs: result.latencyMs, entities: facts?.entities?.length 
});
The terminal narrator renders these as:

text

Copy
  ▹ Phase 2/7 — Extract facts (calling ollama gpt-oss:20b)...
  ✓ Phase 2/7 — Extract facts done (47.8s, 12 entities, ollama)
Step 4: Improve Mermaid compile error reporting#
In the preview render failure path of agent.js, include the full error and repair attempts:

js

Copy
sendEvent('preview_render', {
  success: false,
  error: previewData.details || previewData.error,
  error_line: previewData.compile_error?.line,
  repair_attempts: previewData.render_meta?.repair_attempts,
  repair_errors: previewData.render_meta?.repair_errors,
});
Step 5: Add agent intent to SSE events#
In agent.js, emit an intent event at the start of each run:

js

Copy
sendEvent('intent', {
  goal: mode === 'full-build' ? 'Generate Mermaid → TLA+ → TypeScript' : 'Enhance architecture',
  start_stage: currentStage,
  target_stages: mode === 'full-build' ? ['mmd', 'tla', 'ts'] : ['mmd'],
  has_existing_run: !!current_run_id,
});
The frontend renders this as a header in the agent panel: “Goal: Generate Mermaid → TLA+ → TypeScript · Starting from: Mermaid”

Step 6: Rewrite the tracer to follow the real full-build flow#
Rewrite scripts/ooda-lifecycle-tracer.js:

POST /api/agent/run with mode: 'full-build', current_stage: 'idea', prompt: IDEA
Consume SSE until preview_ready — capture run_id, md_source, mmd_source, diagram_name
POST /api/agent/finalize with current_text: md_source, mode: 'full-build', current_stage: 'idea', current_run_id: run_id
Consume SSE through final_render → pipeline_stage(tla) → pipeline_stage(ts) → bundle_ready → done
Capture all artifacts from SSE events
Also trace the mmd-start path (the user’s actual scenario):

Start with a pre-existing run_id (from a prior render)
POST /api/agent/run with mode: 'full-build', current_stage: 'mmd', current_run_id: run_id
Verify it skips planning and goes directly to preview/finalize → TLA+ → TS
Step 7: OODA loop capture and cross-stage consistency#
For each tab transition, record the OODA cycle (observe/orient/decide/act/result).
After all tabs complete, check entity name consistency across facts ↔ Mermaid ↔ TLA+ ↔ TypeScript.

Step 8: Compact verdict output#
Write runs/ooda-trace-<run_id>.json and runs/ooda-verdict-<run_id>.md with:

OODA loop table (one row per tab transition)
Per-tab schema completeness score
Provider breakdown
Failure list with error_class, tab, stage, message
Cross-stage consistency drift report
Timing breakdown per phase
5. Files to Modify#
File	Change
server/routes/agent.js	Steps 1, 2, 4, 5 — full-build mmd shortcut, finalize stage fix, error reporting, intent event
server/services/input-router.js	Step 3 — progress sub-events during HPC-GoT phases
server/services/terminal-narrator.js	Step 3 — render progress sub-events with provider/timing
scripts/ooda-lifecycle-tracer.js	Steps 6, 7, 8 — rewrite tracer with correct flow, OODA capture, consistency checks
public/js/mermaid-gpt-agent.js	Step 5 — render intent header in agent panel
public/js/mermaid-gpt-app.js	Step 2 — pass agent_start_stage to finalize
6. Success Criteria#
Full-build from mmd with a valid run_id skips planning/refinement and goes directly to compile → TLA+ → TS
Finalize preserves the agent’s starting stage, not whatever tab the user is viewing
HPC-GoT phases emit progress sub-events with provider, timing, and entity counts
Mermaid compile errors include line number, repair attempts, and actionable detail
Agent panel shows the goal (e.g., “Generate Mermaid → TLA+ → TypeScript”) at the start
node scripts/ooda-lifecycle-tracer.js completes one full-build run and produces trace + verdict
The trace captures every inference call, every phase transition, every failure with context
264 lines · 1986 words · 14597 chars · ~10 min read