# Operating Procedure — Agent Architect + Mermate Runtime

This document describes the exact steps the agent should follow when using Mermate as an architecture copilot. Every instruction maps directly to real runtime behavior.

## Runtime facts

These are not aspirational — these are the actual system parameters:

| Parameter | Value | Source |
|-----------|-------|--------|
| Copilot idle delay | 1.8 seconds | `IDLE_DELAY_MS = 1800` in `mermaid-gpt-copilot.js` |
| Minimum gap between AI suggestions | 5 seconds | `MIN_SUGGEST_GAP = 5000` |
| Minimum gap between local suggestions | 2 seconds | `LOCAL_SUGGEST_GAP = 2000` |
| Suggestion timeout | 4 seconds | `SUGGEST_TIMEOUT = 4000` |
| Enhancement timeout | 12 seconds | `ENHANCE_TIMEOUT = 12000` |
| Max consecutive dismissed suggestions before silence | 2 | `MAX_DISMISSALS_BEFORE_SILENCE = 2` |
| Characters typed to reset dismissal counter | 20 | `CHARS_TO_RESET_DISMISSALS = 20` |
| Copilot health check interval | 30 seconds | `HEALTH_INTERVAL = 30000` |
| Compile retry attempts | 3 (compile, deterministic repair, model-assisted repair) | `compileWithRetry()` |
| Render prepare timeout | 30 seconds (120 seconds for Max) | `INFER_TIMEOUT_MS`, `MAX_INFER_TIMEOUT_MS` |

## Copilot health: what "available" means

The copilot reports `available: true` when ANY of these providers is reachable:
- Ollama local (`gpt-oss:20b` at `localhost:11434`)
- Premium API (OpenAI/Anthropic via `MERMATE_AI_API_KEY`)
- Python enhancer (at `localhost:8100`)

When healthy, the copilot routes suggestions through the provider chain. When unhealthy, it falls back to local pattern-based suggestions (`_localSuggest`).

**For copilot suggestions and enhancement**, the provider chain prefers local first (cheap, fast):
1. Ollama local
2. Python enhancer
3. Premium API (only as last resort for copilot — premium is reserved for render)

**For render**, the provider chain prefers premium first (highest quality):
1. Premium API
2. Ollama local
3. Python enhancer

## Step-by-step operating procedure

### Phase 1 — Understand the problem (before typing)

1. Read the user's problem statement carefully.
2. Identify: actors, system boundaries, major flows, failure concerns, deployment constraints.
3. Decide whether this is a single-diagram or multi-diagram architecture.
4. Choose the likely diagram views needed (system context, logical flow, failure/retry, state, deployment).

### Phase 2 — Draft in Simple Idea mode

Type the architecture description incrementally in the textarea.

**Do not paste a fully-finished specification.** Build it the way a thoughtful human would:

```
Step 1: State the problem (1-2 sentences)
Step 2: Name the actors and entry points
Step 3: Name the core services
Step 4: Describe the main flows
Step 5: Name the data stores and brokers
Step 6: Describe failure handling
Step 7: Add observability and operational concerns
Step 8: Add security and access control
Step 9: Describe deployment topology if relevant
Step 10: Add end states and completion conditions
```

### Phase 3 — Use copilot suggestions

After typing each meaningful chunk (2-3 sentences):

1. **Pause for at least 2 seconds** (the idle timer fires at 1.8 seconds).
2. **Wait up to 5 seconds** for a suggestion to appear as ghost text in the textarea.
3. **Evaluate the suggestion critically:**
   - Does it add architectural specificity? Accept (Tab).
   - Does it add filler like "→ [connects to]"? Ignore.
   - Does it add a real failure path or missing entity? Accept.
   - Is the architecture already sufficient? The system should return silence or low-confidence.
4. **After accepting or ignoring, continue typing.**

**Stop-condition awareness:** If the text already has:
- a clear beginning (actor/trigger)
- processing steps (services/flow)
- failure handling (retry/fallback/error)
- an end state (response/result/notify)

...the copilot should stop suggesting. If it doesn't, dismiss the suggestion with Escape. After 2 consecutive Escape dismissals, the system will go silent until you type 20+ more characters.

### Phase 4 — Use active enhancement deliberately

Press **Cmd+Return** (Mac) or **Ctrl+Return** (Windows/Linux) to trigger active enhancement.

**Selection enhancement:** Select a weak fragment first, then press Cmd+Return. Only the selection is improved.

**Full enhancement:** Press Cmd+Return with no selection. The entire text is enhanced.

**When to use:**
- A fragment is vague and needs more architectural specificity.
- The whole draft needs failure paths, protocol labels, or technology specifics.
- You want the local model to strengthen the description before rendering.

**When NOT to use:**
- The text is already strong. Enhancement will return "good enough" or no-op.
- You already have a well-structured specification. Go directly to Render.

### Phase 5 — Render early and often (cheap/default mode)

Click the **Render** button to compile the current text into a diagram.

**What happens behind the scenes:**
1. The system calls `/api/analyze` to compute an `InputProfile` (maturity, quality, completeness, shadow model, intent).
2. For text/markdown with Enhance checked, it calls `renderPrepare()` which routes to the provider chain (`render_prepare` stage).
3. The premium API (or Ollama fallback) generates valid Mermaid from the architecture description.
4. The Mermaid is compiled to SVG + PNG via `mmdc`.
5. If compilation fails, the system retries: deterministic repair first, model-assisted repair second.
6. The response includes `compiled_source` (the actual Mermaid), `mmd_metrics` (node/edge/subgraph counts), and `render_meta` (attempts, repair changes).

**How to evaluate the returned diagram:**

Use the architecture rubric (`.cursor/references/architecture-rubric.md`):
- Problem fidelity: does it answer the real question?
- Architectural correctness: right services, right relationships?
- Decomposition quality: are boundaries meaningful?
- Flow clarity: can a human follow it?
- Failure/recovery: are error paths represented?
- Operational realism: observability, audit, access control?
- Readability: not overloaded?
- Mermaid suitability: right diagram type?

**Use `mmd_metrics` from the response to assess:**
- `nodeCount`: how many entities are represented
- `edgeCount`: how many relationships
- `subgraphCount`: how many boundaries/layers (0 in default mode, 3-8+ in Max mode)

### Phase 6 — Revise based on actual diagram quality

After each render, ask:
- Is the diagram too flat? Add boundary/layer language to the text.
- Are failure paths missing? Add "On failure..." clauses.
- Is it overloaded? Consider splitting into multiple diagrams.
- Are node names vague? Improve naming in the text.
- Is the diagram type wrong? Add explicit hints like "state machine" or "sequence diagram".

**Then render again.** Cheap renders cost approximately $0.0005 each. Use them liberally.

### Phase 7 — Decide when to split

Use the splitting rules (`.cursor/references/diagram-splitting-rules.md`):

Split when:
- Multiple abstraction levels compete (business flow + infra topology)
- Failure paths overwhelm the main view
- Security/policy logic is central and clutters the architecture
- State transitions deserve explicit modeling
- Deployment and runtime logic both matter

**When splitting, render each view separately.** Each view gets its own text and its own render cycle.

### Phase 8 — Use Max mode for final render

Click the **Max** toggle next to the Render button to enable Max mode.

**What Max mode does:**
- Routes the `render_prepare` stage to the strongest configured premium model (`MERMATE_AI_MAX_MODEL`).
- The system prompt is the same, but the model is more capable.
- Max mode typically produces: AAD-style layered subgraphs, richer labels, better decomposition, more explicit failure paths.

**When to use Max mode:**
- The architecture text is mature and well-structured.
- You want architect-grade output with layers and boundaries.
- You have already done multiple cheap renders and refined the text.
- The architecture is complex enough to benefit from stronger reasoning.

**When NOT to use Max mode:**
- Early iterations (waste of cost).
- Simple diagrams (no benefit over default).
- Text that is still vague or incomplete (garbage in, garbage out — even with Max).

**Pre-Max checklist:**
1. Naming is stable and consistent.
2. Boundaries are intentional.
3. Problem statement is fully represented.
4. Failure and recovery paths are explicit.
5. Unnecessary clutter has been removed.
6. The text is stronger than any earlier draft.

### Phase 9 — Evaluate the final result

After the final Max render:

1. Check `mmd_metrics.subgraphCount` — should be 3+ for complex architectures.
2. Check `mmd_metrics.nodeCount` — should match the entities in your description.
3. Read `compiled_source` — the actual Mermaid that was rendered.
4. Check `render_meta.attempts` — should be 1 (no repair needed).
5. Check `render_meta.max_mode` — should be `true`.
6. Apply the architecture rubric. All categories should be 4/5 or higher.

### Phase 10 — Stop when sufficient

Stop iterating when:
- The architecture is structurally coherent.
- The main problem is solved.
- Important failure/policy/operational concerns are represented.
- The diagram is useful to real engineers.
- Further refinement would be cosmetic.

**Do not keep rendering.** A great copilot knows when enough is enough.

## API reference for agents

### `GET /api/copilot/health`
Returns provider availability and Max mode status.
```json
{ "available": true, "providers": { "premium": true, "ollama": true, "enhancer": false }, "maxAvailable": true }
```

### `POST /api/analyze`
Returns an InputProfile without rendering.
```json
{ "text": "...", "mode": "idea" }
→ { "profile": { "maturity": "complete", "qualityScore": 0.82, "recommendation": "stop", "shadow": {...}, "hint": "..." } }
```

### `POST /api/render`
Full render cycle.
```json
{ "mermaid_source": "...", "enhance": true, "input_mode": "idea", "max_mode": false }
→ { "success": true, "compiled_source": "flowchart TB\n...", "mmd_metrics": { "nodeCount": 15, "edgeCount": 18, "subgraphCount": 7 }, "render_meta": { "attempts": 1, "max_mode": false } }
```

## Cost awareness

| Action | Approximate cost | When to use |
|--------|-----------------|-------------|
| Local copilot suggestion | $0.00 | Every 2-5 second pause |
| Local enhancement | $0.00 | Freely during drafting |
| Default render | ~$0.0005 | 10+ times during development |
| Max render | ~$0.012 | 1-3 times at the end |

The system is designed for many cheap renders and few expensive ones.
