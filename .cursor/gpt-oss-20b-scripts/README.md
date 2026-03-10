# Scripts in `.cursor/gpt-oss-20b-scripts`

Reference implementation for the Mermaid enhancer extension. **These scripts are not meant to be run from this Mermate repo.** They document how to implement the enhancer in your **gpt-oss-20b** project (or your LLM framework of choice). Copy or adapt them into your extension directory (e.g. `gpt_oss/extensions/mermaid_enhancer/`) and run the service there. Mermate connects via `MERMAID_ENHANCER_URL` when the service is running.

---

## Scripts in this directory

| Script | Role |
|--------|------|
| **enhancer_service.py** | FastAPI app. `POST /mermaid/enhance` routes by `stage`: `render` → full intelligence cycle, `copilot_suggest` → copilot engine, `copilot_enhance` → full-text enhancement, `decompose` / `repair_from_trace` → specialized flows, default → OODA pipeline. |
| **intelligence_core.py** | Central cognition engine for the hidden one-shot render cycle. Orchestrates classify → score → decide intervention → enhance/generate → validate → repair. Mixture-of-thoughts design. |
| **copilot_engine.py** | Deterministic suggestion generator for Simple Idea mode. Uses semantic analyzer to classify drafting state and produce context-aware ghost-text suggestions. |
| **ooda_pipeline.py** | Observe → Orient → Decide → Act. Deterministic Mermaid formatting: metadata extraction, type classification, strategy selection (passthrough/normalize/refine/restructure), transforms. |
| **semantic_analyzer.py** | NLP-lite analysis of natural language. Extracts entities, relationships, drafting intent, architecture pattern, Simple Idea Quality Score (SIQS). |
| **input_classifier.py** | Classifies raw input: input type (raw idea, prose, Mermaid, mixed), user intent (brainstorming, structuring, refining), architecture pattern. Deterministic. |
| **sufficiency_scorer.py** | Scores input sufficiency for render vs. copilot. Informs intervention policy. |
| **intervention_policy.py** | Decides minimum useful action (silent, suggest, enhance, repair, transform, etc.) from classification and sufficiency. |
| **render_validator.py** | Validates Mermaid source for renderability. Syntax and structure checks. |
| **repair_engine.py** | Repairs invalid Mermaid using LLM when available. Falls back to deterministic fixes. |
| **noop_detector.py** | Detects false-success: empty output, unchanged prose, trivial Mermaid, repetitive filler. Prevents propagating useless results. |
| **provider_layer.py** | LLM provider abstraction. Model tiers (local/premium), availability checks, inference calls. |
| **prompt_templates.py** | System prompts and builders for enhance, generate Mermaid, refine, render cycle. |
| **stage_contracts.py** | Typed result contracts for each stage: `InputType`, `InterventionLevel`, `RenderStatus`, `EnhancementResult`, etc. Prevents contract violations. |
| **mermaid_syntax.py** | Diagram type classification, basic validation (empty, unknown type, unbalanced brackets), formatting score. |
| **aad_analysis.py** | Architecture-Aware Deterministic analysis. Advisory reports on subgraph labels, legends, classDefs, cross-subgraph edges. |

---

## Architecture (dependency flow)

```
enhancer_service.py
├── copilot_engine.py
│   └── semantic_analyzer.py
├── ooda_pipeline.py
│   └── mermaid_syntax.py
├── intelligence_core.py
│   ├── provider_layer.py
│   ├── input_classifier.py
│   │   ├── mermaid_syntax.py
│   │   ├── semantic_analyzer.py
│   │   └── stage_contracts.py
│   ├── sufficiency_scorer.py
│   │   ├── semantic_analyzer.py
│   │   ├── mermaid_syntax.py
│   │   └── stage_contracts.py
│   ├── intervention_policy.py
│   │   ├── stage_contracts.py
│   │   └── provider_layer.py
│   ├── render_validator.py
│   │   ├── mermaid_syntax.py
│   │   └── stage_contracts.py
│   ├── repair_engine.py
│   │   ├── render_validator.py
│   │   ├── stage_contracts.py
│   │   └── provider_layer.py
│   ├── noop_detector.py
│   ├── ooda_pipeline.py
│   ├── prompt_templates.py
│   └── stage_contracts.py
└── stage_contracts.py
```

---

## When implemented in gpt-oss

After copying these scripts into `gpt_oss/extensions/mermaid_enhancer/`:

```bash
uvicorn gpt_oss.extensions.mermaid_enhancer.enhancer_service:app --port 8100
```

Mermate sends `POST /mermaid/enhance` with `stage` and `raw_source`. The enhancer routes to the appropriate pipeline and returns the result.
