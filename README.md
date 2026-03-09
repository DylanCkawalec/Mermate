![Mermate](./mermate-banner.png)

# Mermate

**AI architecture copilot for Mermaid, built to turn raw ideas into expert system diagrams.**

Describe a system in plain English. Mermate compiles it into production-quality Mermaid diagrams — flowcharts, state machines, sequence diagrams, ER diagrams, and more — with optional AI enhancement powered by whatever local or remote LLM you connect.

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | >= 20 |
| npm | >= 9 |
| Python | >= 3.9 (for gpt-oss enhancer, optional) |

Mermate ships **without an AI model**. It is a diagram compilation engine with a copilot layer. You bring the model.

---

## Quick start

```bash
# 1. Clone into your developer folder
git clone <your-fork-or-repo> ~/developer/mermaid
cd ~/developer/mermaid

# 2. Install dependencies
npm install

# 3. Start the app
./mermaid.sh start
```

Open [http://localhost:3333](http://localhost:3333).

That's it. The app runs completely without an AI model. You can paste Mermaid source directly and compile it to high-resolution PNG and SVG from day one.

---

## What you get without an AI model

- Paste Mermaid source → compile to PNG + SVG
- Auto-detection of diagram type (flowchart, sequence, state, ER, gantt, pie, mindmap, etc.)
- Axiomatic pre-compile validation
- Download both outputs as a ZIP
- Fullscreen canvas view with GPU-accelerated pan/zoom
- Diagram history with delete support
- `./mermaid.sh compile <file.mmd>` to compile any `.mmd` file from the command line
- `./mermaid.sh validate` to validate all archived diagrams against structural rules

---

## Connecting an AI model

The copilot and enhancement features (`Enhance` toggle, `Ctrl+Return` in Simple Idea mode) require an API-compatible language model running on `http://localhost:8100`.

Mermate uses a simple HTTP contract. Any model server that accepts `POST /mermaid/enhance` works.

### What the enhancer endpoint expects

```
POST http://localhost:8100/mermaid/enhance
Content-Type: application/json

{
  "stage": "text_to_md" | "md_to_mmd" | "validate_mmd" | "repair" |
           "copilot_suggest" | "copilot_enhance",
  "raw_source": "user input text",
  "system_prompt": "injected axiom prompt from Mermate",
  "temperature": 0.0
}
```

```
Response:
{
  "enhanced_source": "...",   // for diagram stages
  "suggestion": "...",        // for copilot_suggest
  "confidence": "high",       // for copilot_suggest
  "transformation": "..."
}
```

Mermate sends a full system prompt with each call (built from `archs/mermaid-axioms.md`). Your model only needs to follow the system prompt and return valid JSON.

---

## Example: using gpt-oss-20b

> This is one approach. You are free to use any model that fits the endpoint contract above.

### Step 1 — Check if you have gpt-oss-20b

```bash
# If you are using Ollama
ollama list | grep gpt-oss

# If you are using a local server
ls ~/models/ | grep gpt-oss
```

If nothing shows up, continue to Step 2. If it's already there, jump to Step 4.

### Step 2 — Download gpt-oss-20b

```bash
# Via Ollama (simplest path)
ollama pull gpt-oss-20b

# Or download GGUF weights manually and load with llama.cpp / LM Studio
# Model page: https://huggingface.co/gpt-oss-20b (placeholder — use your actual model source)
```

### Step 3 — Start the model server on port 8100

```bash
# With Ollama
OLLAMA_HOST=0.0.0.0:8100 ollama serve

# Or with llama-cpp-python
python3 -m llama_cpp.server --model ~/models/gpt-oss-20b.gguf --port 8100

# Or with LM Studio: start the server, set port to 8100, and add a proxy route
# that maps POST /mermaid/enhance to the completion endpoint.
```

### Step 4 — Point Mermate at your model

By default Mermate looks for the enhancer at `http://localhost:8100`. If your server runs on a different host or port:

```bash
# Mermate reads this environment variable
MERMAID_ENHANCER_URL=http://localhost:11434 ./mermaid.sh start

# Or to auto-start the enhancer via mermaid.sh
MERMAID_ENHANCER_START_CMD="ollama serve" ./mermaid.sh start
```

### Step 5 — Verify the connection

```bash
curl http://localhost:8100/health
# Expected: 200 OK
```

When the enhancer is healthy, the app shows "Enhancer: healthy" on startup and the `Enhance` checkbox becomes active.

---

## What to do next

Once the app is running, here are the starting prompts to try:

**Simple architecture idea:**
```
A user logs in via the browser, the API gateway validates the JWT,
then routes to the user service which reads from PostgreSQL.
On failure, return 401 to the browser.
```

**Event-driven system:**
```
Payment service emits OrderCreated event to Kafka.
Inventory service and notification service both consume it.
If inventory fails, route to dead letter queue.
```

**State machine:**
```
Pod lifecycle: Pending → ContainerCreating → Running.
On OOM kill → Failed. On graceful shutdown → Succeeded.
```

**CI/CD pipeline:**
```
Code push triggers build, then parallel unit tests and lint,
then integration tests, security scan, staging deploy,
manual approval gate, then canary production deploy at 5% → 25% → 100%.
```

Paste any of these into Simple Idea mode and press **Render**. Add `Enhance` for AI-assisted refinement.

---

## Project structure (brief)

```
mermaid/
├── mermaid.sh              # Start, compile, validate
├── server/                 # Express API (port 3333)
│   ├── routes/render.js    # POST /api/render, DELETE /api/diagrams/:name
│   └── services/
│       ├── mermaid-compiler.js    # mmdc wrapper, high-res PNG/SVG
│       ├── mermaid-classifier.js  # Diagram type detection
│       ├── input-detector.js      # Content-state detection (text/md/mmd/hybrid)
│       ├── input-router.js        # Pipeline routing
│       ├── diagram-selector.js    # Axiom-based diagram type selection
│       ├── mermaid-validator.js   # Pre-compile structural validation
│       ├── axiom-prompts.js       # System prompts for each pipeline stage
│       └── gpt-enhancer-bridge.js # HTTP bridge to the enhancer service
├── public/                 # Frontend (served statically)
│   ├── js/mermaid-gpt-copilot.js  # Ghost-text copilot for Simple Idea mode
│   └── css/mermaid-gpt.css
├── archs/                  # Archived diagram sources (.mmd, .md)
│   └── flows/              # Compiled output from ./mermaid.sh compile
├── flows/                  # Compiled output from the web app (served at /flows)
├── test/                   # Node test suite
└── archs/mermaid-axioms.md # The intelligence model (read this)
```

---

## The intelligence model

The axioms that govern how Mermate thinks about diagrams live in `archs/mermaid-axioms.md`. This is the most important file to read if you want to:

- Fine-tune your own model against Mermate's prompts
- Extend the enhancer with custom stages
- Build your own `gpt-oss` extension for Mermate

**The key design principle:** Mermate ships the reasoning framework. You supply the model. The combination is what makes it powerful.

---

## Choosing a model and thinking about fine-tuning

Mermate does not mandate a specific model. These are the questions worth considering:

**Model size tradeoffs**
- 7B–13B models: fast, local-friendly, good for `validate_mmd` and `copilot_suggest`
- 20B–34B models: better at `text_to_md` and `copilot_enhance` (more architectural reasoning)
- 70B+ models: best for complex architecture generation and AAD-style decomposition

**Fine-tuning targets**
The prompts in `server/services/axiom-prompts.js` are the system prompts Mermate injects. If you fine-tune a model on pairs of (axiom_prompt, mermaid_source), you get a model that follows the axiom framework natively without needing the full prompt injection.

**What to build in your gpt-oss extension**
The enhancer endpoint receives a `stage` field. You can add your own stages — for example, a `validate_architecture` stage that checks if the described system is secure, or a `suggest_diagram_type` stage that proposes the best visualization for a given input. Mermate's router will call whatever stages you support.

---

## CLI reference

```bash
./mermaid.sh start                          # Start the web app
./mermaid.sh compile                        # Compile all .mmd files in archs/
./mermaid.sh compile <filename.mmd>         # Compile one file
./mermaid.sh validate                       # Validate all .mmd files against axiom rules
./mermaid.sh test                           # Run the test suite
```

Environment variables:

```bash
PORT=3333                                   # App server port (default 3333)
MERMAID_ENHANCER_URL=http://localhost:8100  # Enhancer service URL
MERMAID_ENHANCER_START_CMD="<command>"      # Auto-start command for the enhancer
```

---

## ⚠️ Important

Mermate does not ship an AI model. The copilot and enhancement features are designed to work with a model you choose and run. The quality of the AI output depends entirely on your model. Mermate's job is to provide excellent system prompts, a structured reasoning pipeline, and a clean compilation layer. Your model's job is to follow the prompts.

If you run Mermate without any model connected, it functions as a standalone Mermaid compiler and is fully usable for direct diagram authoring.
