# NemoClaw

Desktop wrapper for local OpenClaw, NemoClaw/OpenShell, Ollama, and the Mermate architecture pipeline.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install wrapper dependencies |
| `npm run dev` | Start Vite client and Express server together |
| `npm run start:server` | Start only the backend wrapper API |
| `npm run build` | Typecheck and build the client |
| `npm run mcp` | Start the local MCP server exposed to Claude |
| `npm run desktop:launch` | Launch the desktop wrapper shell script |
| `./run.sh` | Start the built app on the fixed local wrapper port |

## Architecture

```text
nemoclaw/
  src/                     UI for status, chat, and builder actions
  server/index.ts          wrapper API, status, probes, architect routes
  server/architect.ts      Mermate render/TLA/TS pipeline and repo scaffold
  mcp/server.ts            Claude-facing MCP tool surface
  plugins/openclaw-desktop local Claude Code plugin and wrapper skill
  .agents/skills/          curated project-local skill bundles and catalog
```

## Key Files

- `server/index.ts` - primary wrapper API surface
- `server/architect.ts` - builder orchestration and generated repo manifest logic
- `mcp/server.ts` - tool registry for Claude/OpenClaw
- `.agents/skills/catalog.json` - runtime-readable bundle inventory
- `plugins/openclaw-desktop/skills/openclaw-wrapper/SKILL.md` - plugin skill for using wrapper tools

## Workflow

- `POST /api/architect/pipeline` -> Mermate render -> optional TLA+ -> optional TypeScript -> quality gate -> optional scaffold
- Generated repos land under `~/Desktop/developer/<repo-name>`
- Generated repos now use `app-spec/manifest.json` as the artifact tag and provenance index

## Claude Skill Layer

- Project-local bundles under `.agents/skills/` are intentionally limited to `sonnet-skills` and `anthropic-skills`
- Direct Claude Code maintenance skill is installed at `.claude/skills/claude-md-improver`
- Use `anthropic-skills` when `CLAUDE.md` or markdown quality is the bottleneck
- Use `sonnet-skills` when architecture, TLA+, provenance, or scaffold alignment is the bottleneck

## Gotchas

- The managed route does not always honor the requested model; trust the returned `model` field over the request payload
- Mermate is expected at `http://127.0.0.1:3333`; the wrapper is expected at `http://127.0.0.1:8787`
- The builder is designed around one canonical artifact path per stage; avoid keeping parallel speculative outputs in generated repos
