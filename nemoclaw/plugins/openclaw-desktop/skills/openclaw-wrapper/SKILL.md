---
name: openclaw-wrapper
description: Use when the user wants to inspect or drive the local OpenClaw desktop wrapper, NemoClaw route, Ollama models, or Mermate pipeline from Claude Code.
---

# OpenClaw Wrapper

Use the plugin MCP tools instead of guessing local runtime state.

Preferred tools:

- `openclaw_status` to inspect the live managed route, Ollama, Mermate, launcher, and Claude Code attachment state
- `openclaw_chat` to send a prompt through either `openshell` or `ollama`
- `openclaw_connectivity_probe` to test a host from inside the `aoc-local` sandbox
- `architect_status` to inspect the inherited Mermate `.env` architect profile
- `architect_pipeline_build` to run idea -> Mermaid -> TLA+ -> TypeScript -> scaffold from the wrapper
- `builder_scaffold_repo` to materialize a clean repo from an existing Mermate run id
- `mermate_status` to inspect Mermate copilot, TLA, TS, and agent mode availability
- `mermate_agent_modes` to list the loaded Mermate specialist modes and agent catalog
- `mermate_render` when the user wants idea -> markdown -> Mermaid compilation through Mermate
- `mermate_generate_tla` and `mermate_generate_ts` when the user wants the formal stages directly

Operational rules:

- Trust the returned runtime status over stale assumptions
- If the wrapper endpoints are offline, tell the user to open `/Users/dylanckawalec/Desktop/OpenClaw Desktop.command`
- When a managed-route chat response reports a different `model` than the requested one, treat the returned model as authoritative
