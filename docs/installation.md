# Installation & deployment guide

Everything Mermate can run with, what each piece is for, and how to verify
it. **Only the core app is required** — every AI provider, formal
toolchain, packaging target, and gateway is optional. Opseeq in particular
is **not** a requirement; it is one optional inference gateway among
several (see [docs/opseeq.md](opseeq.md)).

## Component matrix

| Component | Required? | Default port | Purpose |
|---|---|---|---|
| **Core app** (Node.js + npm) | ✅ Yes | 3333 | Web UI, compile pipeline, run lineage, all `/api` routes |
| OpenAI-compatible API key | One AI path recommended | — | Copilot, enhance, agent, TLA+/TS authoring |
| Ollama | Optional | 11434 | Local-first inference fallback |
| Python enhancer | Optional | 8100 | Self-hosted model bridge (`POST /mermaid/enhance`) |
| Java (JDK 11+) | Optional | — | TLC model checking of generated TLA+ (`tla2tools.jar` is bundled) |
| Rust toolchain | Optional | — | Rust binary + macOS `.app` packaging |
| Python venv (`.venv-mcp`) | Optional | — | MCP bridge for OpenClaw/other MCP clients |
| Opseeq gateway | Optional | 9090 | Centralized routing, trace correlation, WS telemetry — [details](opseeq.md) |

---

## 1. Core app (required)

```bash
git clone <repo> && cd mermaid
npm install
./mermaid.sh start          # http://localhost:3333
```

Verify:

```bash
curl -s http://localhost:3333/api/health | python3 -m json.tool
```

No `.env` needed — without any model the app is a full Mermaid compiler
(paste source → PNG/SVG/ZIP, validation, history).

## 2. AI providers (pick any, or none)

Provider chain with automatic fallback: **premium API → Ollama → enhancer**.

**Hosted (recommended):** put `OPENAI_API_KEY=sk-proj-...` in `.env`
(`cp .env.example .env`). Model defaults are sensible
(`gpt-5.6-sol`/`terra`/`luna` tiers); override via
`MERMATE_ORCHESTRATOR_MODEL` / `MERMATE_WORKER_MODEL` /
`MERMATE_FAST_STRUCTURED_MODEL` only if needed. Optional
`CLAUDE_API_KEY` enables Anthropic-authored TLA+.

**Local Ollama:**

```bash
ollama pull gpt-oss:20b     # or any model you prefer
ollama serve                # port 11434
```

```env
MERMATE_OLLAMA_URL=http://localhost:11434
MERMATE_OLLAMA_MODEL=gpt-oss:20b
```

**Self-hosted enhancer:** run any server that answers
`POST /mermaid/enhance` with `{ stage, raw_source, system_prompt, temperature }`
→ `{ enhanced_source }` and point `MERMAID_ENHANCER_URL` at it
(default `http://localhost:8100`).

Verify whichever you configured:

```bash
curl -s http://localhost:3333/api/copilot/health | python3 -m json.tool
```

The boot overlay shows a per-provider badge (green/yellow/red) — AI absent
is a valid state, not an error.

## 3. Formal toolchain (optional — TLA+ verification)

SANY parsing of generated TLA+ works out of the box (bundled
`vendor/tla2tools.jar`). TLC model checking additionally needs Java:

```bash
java -version               # JDK 11+ required
./mermaid.sh tla-setup      # verifies/installs the toolchain
curl -s http://localhost:3333/api/render/tla/status | python3 -m json.tool
```

Without Java, TLA+ specs are still generated and SANY-validated; TLC
checks are skipped with an explicit status. Layout details:
[docs/specula-integration.md](specula-integration.md).

## 4. Rust + desktop app packaging (optional)

The final pipeline stage can compile the generated TypeScript runtime into
a Rust binary and wrap it as a macOS `.app`:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -s http://localhost:3333/api/render/rust/status
```

### Desktop installation (what the user gets)

When a run completes the Rust stage (via the agent `full-build` mode or
`POST /api/render/rust` with a `run_id`):

1. Mermate builds the binary and assembles `<diagram-name>-<runid8>.app`
2. The bundle is copied to your **Desktop** with:
   - a generated **landing page** (double-click → dashboard for the app)
   - `skill.json` — machine-readable manifest for agent consumption
3. Install = drag the `.app` to `/Applications` (or run from Desktop).
   No installer, no daemon — it is a self-contained bundle of the
   compiled runtime for the system you diagrammed.

First launch on macOS may require right-click → Open (unsigned bundle).

## 5. MCP bridge (optional — OpenClaw / agent clients)

```bash
python3 -m venv .venv-mcp
./.venv-mcp/bin/pip install -r requirements.txt
./.venv-mcp/bin/python -m mcp_service     # smoke-test the bridge
```

The repo `.mcp.json` points MCP clients at `.venv-mcp/bin/python` with
`MERMATE_URL=http://127.0.0.1:3333`. Adjust the interpreter path after
moving the repo.

## 6. Opseeq (optional gateway)

Not required. If you want centralized gateway routing, correlated
`run_id` traces across services, or WS telemetry: **all** Opseeq setup,
URL rules, and caveats live in [docs/opseeq.md](opseeq.md). With
`OPSEEQ_URL` unset, nothing in Mermate waits on or requires it.

---

## Deployment checklist (production)

```bash
npm ci                      # lockfile-exact deps
npm audit                   # expect: 0 high / 0 critical
npm test                    # 200+ tests, self-contained (spawns own server)
./mermaid.sh validate       # archived diagrams: 0 errors
PORT=3333 npm start         # or your process manager of choice
```

- Set env via `.env` (never commit it; `.gitignore` covers it)
- `flows/`, `runs/`, `logs/` are runtime output — safe to prune, regenerated
- The app makes **zero** outbound API calls when idle (60s no-interaction cutoff)
- Boot is bounded: every dependency probe has a timeout and a visible badge;
  a down optional dependency never blocks the app

## Troubleshooting

| Symptom | Fix |
|---|---|
| DuckDB native binding error on start | `npm rebuild duckdb` (repeat after Node major upgrades) |
| Enhance/Render silent | no provider configured — check `/api/copilot/health` |
| TLA+ "toolchain missing" | install JDK 11+, run `./mermaid.sh tla-setup` |
| Rust stage 503 | install rustup (command above) |
| Port already in use | `kill $(lsof -ti :3333)` or `PORT=3400 npm start` |
