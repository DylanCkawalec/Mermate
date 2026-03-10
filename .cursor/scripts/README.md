# Mermaid Enhancer Extension

A modular GPT-OSS extension that provides Mermaid diagram syntax validation,
classification, optional LLM-assisted refinement, and an intelligent copilot
suggestion engine for architecture ideation.

## Isolation

This extension is fully self-contained under `gpt_oss/extensions/mermaid_enhancer/`.
It does NOT import from or modify any existing GPT-OSS code, including:
- `gpt_oss/evals/`
- `gpt_oss/chat.py`
- `gpt_oss/generate.py`
- `gpt_oss/tools/`
- `gpt_oss/responses_api/`

Removing this directory has zero impact on the rest of GPT-OSS.

## Architecture

The extension has two pipelines: the **OODA pipeline** for Mermaid source
formatting and the **Copilot engine** for intelligent ghost-text suggestions
in Simple Idea mode. Both are deterministic and operate without an LLM.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  enhancer_service.py  — FastAPI app, POST /mermaid/enhance                  │
│  Routes by stage: copilot_suggest │ copilot_enhance │ OODA formatting       │
└──────────────┬───────────────────────────────┬──────────────────────────────┘
               │                               │
    stage = copilot_suggest             stage = (default / enhance)
               │                               │
               ▼                               ▼
┌──────────────────────────┐    ┌─────────────────────────────────────────────┐
│  copilot_engine.py       │    │  ooda_pipeline.py                           │
│  Suggestion intelligence │    │  Observe → Orient → Decide → Act            │
└──────────┬───────────────┘    └──────────┬──────────────────────────────────┘
           │                               │
           ▼                    ┌──────────┼──────────────┐
┌──────────────────────────┐    │          │              │
│  semantic_analyzer.py    │    ▼          ▼              ▼
│  Entity extraction       │  mermaid_  aad_          prompt_
│  Relationship inference  │  syntax.py analysis.py   templates.py
│  Drafting intent         │
│  Architecture profiling  │
│  Quality scoring (SIQS)  │
└──────────────────────────┘
```

### Module roles

| Module | Role |
|--------|------|
| **enhancer_service.py** | FastAPI app. `POST /mermaid/enhance` routes by `stage` field: `copilot_suggest` → copilot engine, `copilot_enhance` → enhanced OODA, default → OODA formatting. Backward compatible with requests that omit `stage`. |
| **copilot_engine.py** | Deterministic suggestion generator. Reads full text via semantic analyzer, classifies what completion is needed (verb target, entity action, next step, failure path, thought completion), generates context-aware suggestions, scores confidence, enforces anti-repetition. |
| **semantic_analyzer.py** | NLP-lite analysis of natural language. Extracts architectural entities (services, data stores, actors, processes, externals), infers relationships from verb patterns, classifies drafting intent (brainstorming/specifying/sequencing/listing), profiles architecture pattern (microservices/event-driven/layered/pipeline/state-machine), computes Simple Idea Quality Score (SIQS 0–100). |
| **prompt_templates.py** | Prompt templates for both enhancement (existing) and copilot stages (new). `COPILOT_SYSTEM` and `build_copilot_suggest_prompt()` are used when an LLM is available for higher-quality suggestions. `COPILOT_ENHANCE_SYSTEM` and `build_copilot_enhance_prompt()` for full-text enhancement. |
| **ooda_pipeline.py** | **Observe**: extract metadata (line/node/edge/subgraph counts, classDefs, emojis, formatting score, warnings). **Orient**: classify type, complexity, structural intent. **Decide**: choose strategy (passthrough/normalize/refine/restructure). **Act**: apply deterministic transforms. |
| **mermaid_syntax.py** | Diagram type classification, basic validation (empty source, unknown type, unbalanced brackets), formatting score (0–100). |
| **aad_analysis.py** | Architecture-Aware Deterministic analysis. Advisory-only. Reports on subgraph labels, legend presence, classDef count, cross-subgraph edges, governance flow patterns. |

### Copilot suggestion flow

1. Mermate sends `POST /mermaid/enhance` with `stage: "copilot_suggest"` and `raw_source` (the user's current text).
2. `enhancer_service.py` routes to `copilot_engine.generate_suggestion()`.
3. The copilot engine runs `semantic_analyzer.analyze()` on the full text to extract entities, relationships, drafting intent, and architecture profile.
4. Based on the drafting state (trailing verb, trailing entity, complete clause, partial thought), the engine selects the right generator:
   - **Trailing verb** (e.g. "API gateway validates") → suggest a target entity
   - **Trailing preposition** (e.g. "reads from") → suggest a data store or service
   - **Trailing entity** (e.g. "PostgreSQL") → suggest what it does in context
   - **Complete clause** (e.g. "User logs in via browser.") → suggest next step or failure path
   - **Partial thought** (e.g. "on failure,") → suggest error handling
5. The suggestion is scored for confidence (0–100). Below 55, it's suppressed.
6. Anti-repetition checks prevent the same suggestion from reappearing within 30 seconds.
7. Response: `{ suggestion, confidence: "high"/"medium"/"low", transformation, insertion_type, suppress, reasoning }`.

### Transform strategies (OODA pipeline)

| Strategy | When | Actions |
|----------|------|---------|
| **passthrough** | Score ≥ 90, no warnings, simple complexity | No changes |
| **normalize** | Score ≥ 60 or has warnings | Strip trailing whitespace, normalize indentation, collapse excessive blank lines |
| **refine** | Score 30–59 or < 30 | Normalize + canonicalize directive (`graph`→`flowchart`), reorder classDefs to top |

### Quality scoring

**Simple Idea Quality Score (SIQS)** evaluates the architectural richness of the user's natural language input:

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| Entity clarity | 25% | Number of identified services, stores, actors |
| Specificity bonus | 10% | Named technologies (PostgreSQL, Kafka, etc.) |
| Relationship clarity | 25% | Explicit verb-based relationships between entities |
| Flow directionality | 15% | Presence of data flow, routing, or event relationships |
| Type diversity | 15% | Variety of entity types (service + store + actor) |
| Technology specificity | 10% | High-confidence named entities |

Suggestions are suppressed when SIQS < 20 (insufficient architectural content).

## Usage

### Standalone service

```bash
uvicorn gpt_oss.extensions.mermaid_enhancer.enhancer_service:app --port 8100
```

### API — Copilot suggestion (Simple Idea mode)

```
POST /mermaid/enhance
{
  "stage": "copilot_suggest",
  "raw_source": "user logs in via browser, API gateway validates",
  "system_prompt": "...",
  "temperature": 0.0
}

Response:
{
  "suggestion": " the JWT and routes to the user service",
  "confidence": "high",
  "transformation": "copilot_suggest",
  "insertion_type": "continuation",
  "suppress": false,
  "reasoning": "Verb 'validation' target → entity 'user service'"
}
```

### API — Diagram enhancement (backward compatible)

```
POST /mermaid/enhance
{
  "raw_source": "flowchart LR\n  A --> B",
  "diagram_type": "flowchart"
}
```

### OODA Pipeline (programmatic)

```python
from gpt_oss.extensions.mermaid_enhancer.ooda_pipeline import run_pipeline

result = run_pipeline("flowchart LR\n  A --> B")
print(result.orientation.diagram_type)   # "flowchart"
print(result.decision.strategy)          # "passthrough"
print(result.output_source)              # cleaned source
```

### Copilot Engine (programmatic)

```python
from gpt_oss.extensions.mermaid_enhancer.copilot_engine import generate_suggestion

result = generate_suggestion("user logs in via browser, API gateway validates")
print(result.suggestion)      # " the JWT and routes to the user service"
print(result.confidence)      # 82
print(result.suppress)        # False
```

### Semantic Analyzer (programmatic)

```python
from gpt_oss.extensions.mermaid_enhancer.semantic_analyzer import analyze

ctx = analyze("payment service emits event to Kafka, inventory consumes")
print(ctx.entities)              # [Entity(name='payment service', ...), ...]
print(ctx.architecture.pattern)  # "event_driven"
print(ctx.architecture.quality_score)  # 68
print(ctx.drafting.intent)       # "sequencing"
```
