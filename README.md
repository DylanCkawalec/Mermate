![Mermate](./mermate-banner.png)

# Mermate

**AI architecture copilot for Mermaid — raw ideas in, verified systems out.**

![node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![tests — 205 passing](https://img.shields.io/badge/tests-205%20passing-brightgreen)
![design — TLC verified](https://img.shields.io/badge/design-TLC%20verified-blueviolet)

Describe a system in plain English. Mermate compiles it into High-quality Mermaid diagrams — flowcharts, state machines, sequence diagrams, ER diagrams, and more — then keeps going: **simple idea's → Markdown spec's → Mermaid Diagrams → TLA+ specifications → TypeScript runtime Modules → downloadable bundle**.

Mermate ships **without an AI model**. It is a compilation engine with a copilot layer — you bring the model (OpenAI-compatible API, local Ollama, or any endpoint that speaks the enhancer contract). With no model connected it still works as a full Mermaid compiler.

![Mermate workspace](docs/images/app-screenshot.png)

![The Mermate pipeline](docs/images/pipeline.svg)

---

## Quick start

```bash
git clone <your-fork-or-repo> ~/developer/mermaid
cd ~/developer/mermaid
npm install
cp .env.example .env     # optional — only needed for AI features
./mermaid.sh start
```

Open [http://localhost:3333](http://localhost:3333). That's it.

**Requirements:** Node.js ≥ 20, npm ≥ 9. Python ≥ 3.9 only if you run the optional local enhancer.

Full component-by-component setup — optional providers, TLA+/TLC toolchain, Rust + **desktop `.app` packaging**, MCP bridge.

**Try these first prompts** (paste into *Simple Idea*, press **Render**):

```
Payment service emits OrderCreated event to Kafka.
Inventory service and notification service both consume it.
If inventory fails, route to dead letter queue.
```

```
Pod lifecycle: Pending → ContainerCreating → Running.
On OOM kill → Failed. On graceful shutdown → Succeeded.
```

---

## What you get

| Capability | Model needed? |
|---|---|
| Paste Mermaid → high-res PNG + SVG, auto diagram-type detection, ZIP download | No |
| Pre-compile structural validation, fullscreen GPU pan/zoom canvas, diagram history | No |
| **Enhance** — ghost-text copilot + full-text refinement of your idea | Yes |
| Text → Mermaid compilation with repair budgets | Yes |
| **Agent mode** — staged planning → preview render → your notes → final render, over SSE | Yes |
| **TLA+ specification** generated from your diagram, SANY-parsed and TLC-checked by Specula which prefers Sonnet API key over other LLM keys | Yes (+ Java for TLC) |
| **TypeScript runtime** compiled from the verified TLA+ artifact, tested | Yes |
| Run lineage: every LLM call audited, per-stage cost/token summaries, trace JSON | No |
| Optional Rust binary + macOS `.app` packaging with landing page | Yes |

just ask for the desktop version from your coding agent on installation and you should see a mermaid appear on your desktop.
..Double click it and you're using mermate.

## Connecting a model

Three provider paths, automatically chained with fallback — if one is offline, Mermate falls through to the next:

| Provider | Configure | Best for |
|---|---|---|
| OpenAI-compatible API | `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) | Highest quality (default tiers: `gpt-5.6-sol` orchestrator, `gpt-5.6-terra` worker, `gpt-5.6-luna` fast) |
| Local Ollama | `MERMATE_OLLAMA_URL`, `MERMATE_OLLAMA_MODEL` | Free local iteration |
| Python enhancer | `MERMAID_ENHANCER_URL` (any server accepting `POST /mermaid/enhance`) | Custom/self-hosted models |

Minimal `.env` for the hosted path:

```env
OPENAI_API_KEY=sk-proj-YOUR_KEY_HERE
# Optional overrides — defaults are already sensible:
# MERMATE_ORCHESTRATOR_MODEL=gpt-5.6-sol
# MERMATE_WORKER_MODEL=gpt-5.6-terra
# MERMATE_FAST_STRUCTURED_MODEL=gpt-5.6-luna
# CLAUDE_API_KEY=sk-ant-...          # Anthropic (Sonnet) for TLA+ authoring
```

The enhancer contract is one endpoint: Mermate POSTs `{ stage, raw_source, system_prompt, temperature }` and expects `{ enhanced_source }` (or `{ suggestion }` for copilot stages). Any model server that honors it works — see `archs/mermaid_axioms.md` for the prompt framework it plugs into.

---

## Agent mode

The agent turns Mermate from a one-shot compiler into a review-and-refine copilot. It plans from your draft, produces a **preview render**, pauses for your notes, then runs the final render — streaming narration over SSE. Agent runs survive page refresh (reattach to live sessions; completed runs recover their artifacts on boot).

Modes: `thinking` · `code-review` · `optimize-mmd` · `tla-verify` · `tla-optimize` · `ts-generate` · `ts-optimize` · `full-build`

Every LLM call, repair attempt, and stage transition emits an audit event. Repair calls are budgeted per stage (`MERMATE_MAX_REPAIR_CALLS`, default 5) with graceful failure.

Idle discipline: when nothing is running and you haven't interacted for 60s, the app makes **zero** API calls.

---

## CLI reference

```bash
./mermaid.sh start                  # Start the web app (port 3333)
./mermaid.sh compile <file.mmd>     # Compile one diagram from the CLI
./mermaid.sh compile                # Compile everything in archs/
./mermaid.sh validate               # Validate archived diagrams
./mermaid.sh test                   # Run the test suite
```

Key environment variables (full list in `.env.example`):

```bash
PORT=3333                                # App server port
OPENAI_API_KEY=<key>                     # Hosted-model key
CLAUDE_API_KEY=<key>                     # Anthropic (TLA+ authoring)
MERMATE_OLLAMA_URL=http://localhost:11434
MERMAID_ENHANCER_URL=http://localhost:8100
MERMATE_MAX_REPAIR_CALLS=5               # Repair budget per stage
MERMATE_DUMP_DIR=~/Desktop/MERMATE/dumps # Optional completed-run exports
```
---

## ⚠️ Important

Mermate does not ship an AI model. The copilot, enhancement, agent, and formal-spec features work with a model **you** choose and run locally, scripts are included in the repo for how to create the enhancement for the model you chose to use. Output quality depends on your model; Mermate's job is excellent system prompts, a structured reasoning pipeline, a verified control plane, and a clean compilation layer.

Run it without any model and it is a fully usable standalone Mermaid compiler.
