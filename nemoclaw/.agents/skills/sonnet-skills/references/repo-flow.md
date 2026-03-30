# OpenClaw Repo Flow

## Core Surfaces

- `src/App.tsx` - desktop wrapper UI for status, chat, and builder actions
- `server/index.ts` - wrapper API, runtime probes, architect endpoints, and MCP-visible status
- `server/architect.ts` - Mermate pipeline invocation, quality gate, and scaffold generation
- `mcp/server.ts` - Claude-facing MCP tool registration for wrapper and Mermate operations
- `plugins/openclaw-desktop/skills/openclaw-wrapper/SKILL.md` - plugin skill for using the wrapper tools instead of guessing

## Runtime Path

1. User enters an idea, markdown block, or Mermaid source in the wrapper UI.
2. `POST /api/architect/pipeline` in `server/index.ts` validates the request and calls `runArchitectPipeline()` in `server/architect.ts`.
3. The wrapper sends the source to Mermate:
   - `POST /api/render`
   - optional `POST /api/render/tla`
   - optional `POST /api/render/ts`
4. `server/architect.ts` evaluates a quality gate.
5. If scaffold is enabled and the gate passes, the wrapper writes a new repo under `~/Desktop/developer/<repo-name>`.

## Generated Repo Handoff

Generated repos contain:

- `app-spec/idea.md`
- `app-spec/architecture.mmd`
- `app-spec/manifest.json`
- optional `app-spec/spec.tla`
- optional `app-spec/spec.cfg`
- optional `app-spec/runtime.ts`
- optional `app-spec/runtime.harness.ts`
- `CLAUDE.md`
- `.claude/skills/openclaw-project-builder/SKILL.md`

The generated manifest is the handoff point for provenance and artifact tags. Treat it as the stage-aware index for the rest of the scaffold.

## Authority Rules

- `idea.md` captures original intent and scope
- `architecture.mmd` is the canonical structural artifact
- `spec.tla` and `spec.cfg` become the canonical behavioral artifacts when present
- `runtime.ts` is downstream of the structural and formal stages, not a replacement for them
- `CLAUDE.md` and the project skill are memory aids; they should summarize the current bundle, not override it
