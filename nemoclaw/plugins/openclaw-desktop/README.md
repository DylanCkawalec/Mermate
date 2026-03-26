# OpenClaw Desktop Plugin

Local Claude Code plugin for the desktop wrapper in `/Users/dylanckawalec/Desktop/developer/mermaid/nemoclaw`.

What it exposes:

- MCP tools for:
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
- A skill that tells Claude when to use the wrapper instead of guessing

This plugin assumes the desktop launcher has already started:

- OpenClaw console on `http://127.0.0.1:8787`
- Mermate on `http://127.0.0.1:3333`

The wrapper now treats Mermate as the architect sidecar and can scaffold launchable starter repos under `/Users/dylanckawalec/Desktop/developer`.

If you move this repo, update the absolute `npm --prefix` path in [plugins/openclaw-desktop/.mcp.json](/Users/dylanckawalec/Desktop/developer/mermaid/nemoclaw/plugins/openclaw-desktop/.mcp.json).
