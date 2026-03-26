# OpenClaw Desktop Console

Local desktop wrapper for the OrbStack NemoClaw/OpenShell stack, local Ollama, and the Mermate architecture pipeline.

## What this project does

- Serves a local chat UI at `http://127.0.0.1:8787`
- Talks to the live `nemoclaw` OpenShell gateway over gRPC + mTLS
- Executes inside the live `aoc-local` sandbox when using the managed route
- Chats against either:
  - the managed `inference.local` route through OpenShell
  - local Ollama on `http://127.0.0.1:11434`
- Inherits the architect-agent profile from the parent Mermate checkout: [`../.env`](../.env) (repository root of this monorepo)
- Runs the Mermate idea -> Mermaid -> TLA+ -> TypeScript pipeline
- Scaffolds a clean starter repo under `~/Desktop/developer` with:
  - curated spec bundle files
  - builder skill + project `.mcp.json`
  - a Vite desktop-window starter app
  - `run.sh` plus a Desktop `.command` launcher
- Exposes the same wrapper through MCP for Claude Code
- Ships a local Claude Code plugin marketplace entry and a desktop launcher

## Verified local reality

Observed on March 26, 2026:

- Managed route inventory currently advertises `kimi-k2.5:cloud`, `nemotron-3-nano:4b`, and `gpt-oss:20b`
- Local Ollama is serving `nemotron-3-nano:4b` and `gpt-oss:20b`
- Direct local Ollama calls to `gpt-oss:20b` work now
- Direct local Ollama calls to `kimi-k2.5:cloud` currently return `unauthorized`
- Managed-route requests for `kimi-k2.5:cloud` currently resolve back to `nemotron-3-nano:4b`
- The managed route accepts requested model names, but it does not always honor them consistently

Because of that last point, the console records the actual model returned by the response instead of assuming the requested model won.

## Desktop start path

Double-click your installed launcher (for example `OpenClaw Desktop.command` on the Desktop), or use the path you configured during setup.

Or run:

```bash
./run.sh
```

That launcher:

1. Starts or reuses the OpenClaw console
2. Attempts to start Mermate
3. Opens the wrapper in an app-style browser window when Chrome/Chromium/Brave/Edge is available

Launcher implementation:

- [scripts/launch_openclaw_desktop.sh](scripts/launch_openclaw_desktop.sh)

## Application builder flow

The builder panel in the UI now does all of the following from one place:

1. Takes an idea, markdown block, or Mermaid source
2. Sends it through Mermate using the local `.env` architect profile
3. Optionally promotes the run into TLA+ and TypeScript
4. Applies a clean-output gate to reject junk scaffolds
5. Generates a new repo in `~/Desktop/developer/<repo-name>`
6. Writes a repo-local `run.sh` and a Desktop launcher for the generated starter

Verified on March 26, 2026 (example run):

- Repo `desktop-builder-smoke-a1` was scaffolded under the configured output directory
- The generated repo built successfully after `npm install`
- Launcher artifacts included `run.sh` in the new repo and a Desktop `.command` file alongside it

## Claude Code attachment paths

Project-scoped MCP:

- [.mcp.json](.mcp.json)

Local plugin marketplace:

- [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json)
- [plugins/openclaw-desktop/.claude-plugin/plugin.json](plugins/openclaw-desktop/.claude-plugin/plugin.json)
- [plugins/openclaw-desktop/.mcp.json](plugins/openclaw-desktop/.mcp.json)

Plugin skill:

- [plugins/openclaw-desktop/skills/openclaw-wrapper/SKILL.md](plugins/openclaw-desktop/skills/openclaw-wrapper/SKILL.md)

Agent skills (project-local, including README guidance and other bundles):

- [.agents/skills/](.agents/skills/)
- [skills-lock.json](skills-lock.json) — install sources and content hashes

The MCP server itself lives in:

- [mcp/server.ts](mcp/server.ts)

## Run locally

```bash
npm install
npm run dev
```

Or run only the backend that serves the built app:

```bash
npm run build
npm run start:server
```

## MCP tools exposed

- `openclaw_status`
- `openclaw_chat`
- `openclaw_connectivity_probe`
- `architect_status`
- `architect_pipeline_build`
- `builder_scaffold_repo`
- `mermate_status`
- `mermate_agent_modes`
- `mermate_render`
- `mermate_generate_tla`
- `mermate_generate_ts`

## Mermate sidecar note

This wrapper detects the Mermate app as the parent directory of this folder (see `../` from [`README.md`](../README.md) at the repository root).

If Mermate fails on startup with a missing DuckDB native binding, rebuild it in the Mermate root:

```bash
cd ..    # from nemoclaw/: Mermate repository root
npm rebuild duckdb
```

## Current limitation

The embedded `openclaw agent` path is still timing out in this environment. The desktop wrapper therefore uses stable surfaces directly:

- OpenShell sandbox execution to `inference.local`
- local Ollama HTTP
- Mermate HTTP endpoints

That is enough to make the system useful now while the deeper agent path is stabilized.
