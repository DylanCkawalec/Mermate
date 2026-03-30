# Claude-Only Skill Architecture

## 1. Mission Interpretation

The goal of this curation is not to maximize installed skills. The goal is to make OpenClaw/NemoClaw better at one narrow, high-value path:

- concept -> markdown -> Mermaid -> Specula/TLA+ -> TypeScript/runtime -> scaffolded repo

That means the project-local skill layer should bias toward architectural reasoning, markdown hardening, specification refinement, provenance, and Claude-facing orchestration. Generic language, UI, infra, database, and self-evolving meta-agent bundles are noise here unless they directly improve that path.

## 2. Current Skill Audit

### Project-local install before pruning

- Project runtime surface: [`nemoclaw/.agents/skills`](./)
- Installed skills before curation: 28
- Largest bundles by size:
  - `engineering-advanced-skills` (~4.2 MB)
  - `ui-ux-pro-max` (~1.5 MB)
  - `capability-evolver` (~1.2 MB)
  - `latex-paper-en` (~424 KB)
  - `skill-creator` (~248 KB)

### Observed integration points

- Runtime status and builder orchestration live in [`nemoclaw/server/index.ts`](../../server/index.ts) and [`nemoclaw/server/architect.ts`](../../server/architect.ts)
- Claude-facing MCP surface lives in [`nemoclaw/mcp/server.ts`](../../mcp/server.ts)
- Claude Code plugin wrapper lives in [`nemoclaw/plugins/openclaw-desktop/`](../../plugins/openclaw-desktop)
- Generated repo scaffolding already emits `CLAUDE.md`, `.claude/skills/openclaw-project-builder/`, and `app-spec/manifest.json`
- Prior to this curation, the runtime did not expose a first-class catalog for the project skill layer

### Upstream Anthropic audit

- `anthropics/skills` audited at commit `98669c1`
- Upstream example skills found: 17
- `anthropics/claude-plugins-official` audited at commit `72b9754`
- Relevant plugin: `claude-md-management`, specifically `claude-md-improver`

### Current skill surface conclusion

The actual OpenClaw/NemoClaw skill surface is the project-local [`nemoclaw/.agents/skills`](./), not the root helper skills used by the development agent for this repository. That is the layer that needed pruning.

## 3. Proposed Claude-Only Skill Strategy

Keep exactly two project-local bundles:

- `sonnet-skills`
  - repo-authored
  - stage-aware architecture/spec/TLA+/tagging guidance
  - grounded in actual Mermate/OpenClaw flow
- `anthropic-skills`
  - Anthropic-derived patterns only where they materially improve this repo
  - includes markdown memory discipline, spec co-authoring, skill curation, and MCP surface design

Keep `claude-md-improver` installed for direct Claude Code use under [`nemoclaw/.claude/skills/claude-md-improver`](../../.claude/skills/claude-md-improver), but do not keep it as a third project-local bundle in `.agents/skills/`. Its operating model is folded into `anthropic-skills`.

## 4. Recommended Structure for `.agents/skills`

```text
.agents/skills/
  README.md
  catalog.json
  sonnet-skills/
    SKILL.md
    references/
      repo-flow.md
      specula-tla-pipeline.md
      meta-tagging.md
  anthropic-skills/
    SKILL.md
    references/
      doc-coauthoring.md
      skill-curation.md
      claude-md-pipeline.md
      mcp-patterns.md
```

## 5. `sonnet-skills` Contents and Purpose

Retained items:

- [`sonnet-skills/SKILL.md`](./sonnet-skills/SKILL.md)
  - What it is: the project-specific router for architecture/specification work
  - Why it stays: the repo needs one authoritative bundle that understands actual OpenClaw, Mermate, scaffold, and TLA+ handoff semantics
  - Mermate support: controls stage discipline from idea through scaffold
  - Specula/TLA+ support: routes formalization work to the TLA+ preparation reference
  - Capability gain: makes Nemoclaw behave like a stage-aware architect instead of a generic coding assistant

- [`sonnet-skills/references/repo-flow.md`](./sonnet-skills/references/repo-flow.md)
  - What it is: the concrete map of current runtime files, endpoints, and scaffold outputs
  - Why it stays: avoids stale or generic reasoning about the repo
  - Mermate support: documents the actual render -> TLA -> TS -> scaffold chain
  - Specula/TLA+ support: positions the formal stage inside the real wrapper pipeline
  - Capability gain: improves architecture grounding and reduces false assumptions

- [`sonnet-skills/references/specula-tla-pipeline.md`](./sonnet-skills/references/specula-tla-pipeline.md)
  - What it is: the formalization contract for turning refined markdown/Mermaid into TLA+-ready artifacts
  - Why it stays: this is the highest-leverage missing discipline in the existing bundle sprawl
  - Mermate support: strengthens pre-TLA inputs before they reach compiler/validator stages
  - Specula/TLA+ support: emphasizes state, actions, invariants, failure paths, and liveness assumptions
  - Capability gain: improves specification quality and formal transformation control

- [`sonnet-skills/references/meta-tagging.md`](./sonnet-skills/references/meta-tagging.md)
  - What it is: a compact taxonomy for stage, artifact type, representation, intent, source, status, and provenance
  - Why it stays: metadata only matters here if it sharpens orchestration, and these tags do
  - Mermate support: helps reason about intermediate artifacts and handoff ordering
  - Specula/TLA+ support: keeps formal and implementation artifacts aligned by intent and provenance
  - Capability gain: improves agentic control and repo synthesis awareness

Derived local source material:

- `improve-codebase-architecture` -> deep-module / architectural-friction reasoning
- `engineering-advanced-skills/spec-driven-workflow` -> spec-first discipline
- `engineering-advanced-skills/agent-workflow-designer` -> bounded workflow staging
- `nvidia-nemoclaw` -> local OpenClaw/NemoClaw runtime context only

These source skills were not retained verbatim because their full payloads were broader than the mission.

## 6. `anthropic-skills` Contents and Purpose

Retained items:

- [`anthropic-skills/SKILL.md`](./anthropic-skills/SKILL.md)
  - What it is: Anthropic-derived router for markdown, project memory, skill design, and MCP surface work
  - Why it stays: one focused Anthropic bundle is more useful than importing the upstream example catalog wholesale
  - Mermate support: improves markdown quality before the architecture/formal pipeline
  - Specula/TLA+ support: raises document quality before formal transformation
  - Capability gain: gives Nemoclaw a Claude-native editing and curation discipline

- [`anthropic-skills/references/doc-coauthoring.md`](./anthropic-skills/references/doc-coauthoring.md)
  - What it is: compressed adaptation of Anthropic's `doc-coauthoring` workflow
  - Why it stays: structured spec writing materially improves markdown-to-structure quality
  - Mermate support: strengthens idea and markdown phases
  - Specula/TLA+ support: produces cleaner intermediate specs for formalization
  - Capability gain: better collaborative spec refinement

- [`anthropic-skills/references/skill-curation.md`](./anthropic-skills/references/skill-curation.md)
  - What it is: condensed adaptation of Anthropic `skill-creator` guidance for trigger quality, progressive disclosure, and high-signal skill design
  - Why it stays: the repo is actively curating Claude-facing skills; this keeps the bundle maintainable
  - Mermate support: prevents drift in the builder-facing skill layer
  - Specula/TLA+ support: ensures spec-oriented skills stay sharp and discoverable
  - Capability gain: improves future skill evolution without reintroducing bulk

- [`anthropic-skills/references/claude-md-pipeline.md`](./anthropic-skills/references/claude-md-pipeline.md)
  - What it is: adapted operating playbook from `claude-md-improver`
  - Why it stays: markdown/project memory quality is central to the repo's transformation path
  - Mermate support: improves idea markdown before MMD/TLA processing
  - Specula/TLA+ support: acts as a pre-formalization memory/clarity gate
  - Capability gain: stronger markdown refinement and CLAUDE.md maintenance

- [`anthropic-skills/references/mcp-patterns.md`](./anthropic-skills/references/mcp-patterns.md)
  - What it is: adapted guidance from Anthropic `mcp-builder`
  - Why it stays: OpenClaw is already exposed through MCP; this is directly relevant
  - Mermate support: keeps the wrapper tool surface aligned with the architecture sidecar
  - Specula/TLA+ support: helps formal-stage tools stay typed and composable
  - Capability gain: better end-to-end agentic system construction

Upstream assets retained by intent:

- From `anthropics/skills`:
  - `doc-coauthoring`
  - `mcp-builder`
  - `skill-creator`
- From `anthropics/claude-plugins-official`:
  - `claude-md-improver`

Upstream assets intentionally removed:

- `algorithmic-art`, `brand-guidelines`, `canvas-design`, `frontend-design`, `internal-comms`, `slack-gif-creator`, `theme-factory`, `web-artifacts-builder`, `webapp-testing`
  - Why removed: creative, communications, or broad web-generation examples that do not materially improve the Mermate -> Specula -> TLA+ path
- `docx`, `pdf`, `pptx`, `xlsx`
  - Why removed: document-file manipulation, not markdown/spec/TLA+ architecture work
- `claude-api`
  - Why removed: OpenClaw/NemoClaw in this repo currently relies on local wrapper/MCP/Mermate surfaces rather than Anthropic API integration
- all other plugins in `claude-plugins-official`
  - Why removed: unrelated to project memory, spec refinement, or Claude-facing architecture control in this repo

## 7. `claude-md-improver` Integration Design

Integration decisions:

- Required install performed:
  - `npx skills add https://github.com/anthropics/claude-plugins-official --skill claude-md-improver --copy -y`
- Direct Claude Code install preserved at:
  - [`nemoclaw/.claude/skills/claude-md-improver`](../../.claude/skills/claude-md-improver)
- Project-local standalone copy removed from `.agents/skills` to avoid a third top-level bundle
- Operating guidance folded into:
  - [`anthropic-skills/references/claude-md-pipeline.md`](./anthropic-skills/references/claude-md-pipeline.md)
- New project memory target added:
  - [`nemoclaw/CLAUDE.md`](../../CLAUDE.md)

Pipeline position:

- before promoting weak idea text into markdown or Mermaid
- after major wrapper/builder/runtime changes that invalidate project memory
- before formal transformation when markdown/spec quality is suspect
- when builder docs and current code drift apart

## 8. Skills-to-Mermate Application-Flow Mapping

| Flow Stage | Primary Bundle | Why |
|---|---|---|
| idea intake | `sonnet-skills` + `anthropic-skills` | enforce stage discipline and structure raw input |
| markdown refinement | `anthropic-skills` | improve clarity, project memory, and sectioning before formal work |
| markdown -> Mermaid | `sonnet-skills` | preserve boundaries, actors, flows, and errors as architectural inputs |
| Mermaid -> TLA+ | `sonnet-skills` | formalize state, actions, invariants, and failure paths |
| TLA+ -> TypeScript | `sonnet-skills` | ensure runtime is downstream of validated structural/behavioral artifacts |
| wrapper/MCP changes | `anthropic-skills` | keep Claude-facing tool surfaces clear, typed, and discoverable |
| repo scaffold handoff | `sonnet-skills` | preserve manifest tags, provenance, and single canonical implementation path |

## 9. Skills-to-Specula/TLA+ Mapping

| Formalization Need | Bundle Support |
|---|---|
| stronger markdown before formal conversion | `anthropic-skills/references/claude-md-pipeline.md` |
| explicit actors, state, actions, invariants | `sonnet-skills/references/specula-tla-pipeline.md` |
| better intermediate artifact quality | both bundles, with Sonnet as final arbiter |
| provenance from structure to formal model | `sonnet-skills/references/meta-tagging.md` |
| TS/runtime alignment with formal artifacts | `sonnet-skills` plus generated `app-spec/manifest.json` tags |

## 10. Meta-Tagging Pipeline Recommendations

Recommended tag groups:

- `stage:*` -> `idea`, `markdown`, `mmd`, `tla`, `ts`, `repo`
- `artifact:*` -> `concept-brief`, `architecture-diagram`, `formal-spec`, `runtime`, `runtime-harness`, `project-memory`
- `representation:*` -> `markdown`, `mermaid`, `tla+`, `cfg`, `typescript`, `json`
- `intent:*` -> `problem`, `scope`, `structure`, `boundary`, `behavior`, `invariant`, `verification`, `scaffold`
- `source:*` -> `user`, `mermate`, `openclaw`, `manual`
- `status:*` -> `input`, `compiled`, `validated`, `generated`, `curated`
- provenance fields -> `run_id`, `diagram_name`, `transformation_path`

Implemented recommendation:

- generated builder manifests now carry `artifact_tags` and `provenance.transformation_path`
- project skill catalog exposes bundle purpose/stage coverage to runtime status

Rejected metadata additions:

- free-form taxonomies with no consumer
- tagging every file in the repo
- opaque score-only metadata with no stage meaning

## 11. Pruning Plan

Project-local removals and why:

- `agent-browser` -> browser automation is not central to the architecture/spec/TLA+ path
- `backend-patterns` -> generic backend advice; replaced by repo-specific guidance
- `capability-evolver` -> self-modifying meta-agent behavior adds risk and noise
- `claude-md-improver` (project-local copy) -> integrated into `anthropic-skills`; direct Claude install retained under `.claude/skills`
- `code-review-expert` -> review-only specialization does not improve the target transformation path
- `crafting-effective-readmes` -> README tuning is lower-value than CLAUDE.md/project memory tuning
- `cryptography` -> off-mission
- `engineering-advanced-skills` -> oversized generic mega-bundle; only a few ideas were extracted into the curated bundles
- `find-skills` -> closed curated set; discovery helper is now unnecessary
- `hybrid-cloud-networking` -> off-mission
- `improve-codebase-architecture` -> concepts retained, full skill removed
- `latex-paper-en` -> off-mission
- `neon-postgres` -> off-mission
- `nvidia-nemoclaw` -> installation-heavy; only local runtime context retained
- `orbstack-best-practices` -> infra-specific, not pipeline-specific
- `postgresql-expert` -> off-mission
- `proactive-self-improving-agent` -> autonomous self-edit behavior is too noisy for a precision-curated layer
- `python-design-patterns` -> off-mission
- `python-sdk` -> off-mission
- `rust-engineer` -> off-mission
- `rust-pro` -> off-mission
- `skill-creator` -> concepts retained, full bundle removed
- `tidy-laptop-folders` -> off-mission
- `typescript-advanced-types` -> generic language help, not architecture pipeline help
- `typescript-expert` -> generic language help, not architecture pipeline help
- `ui-ux-pro-max` -> heavy UI catalog that does not improve formal/spec reasoning
- `writing-skills` -> concepts retained, full bundle removed

## 12. Final Curated Skill Architecture

Final project-local state:

- exactly two top-level bundles under [`nemoclaw/.agents/skills`](./)
- one runtime-readable catalog: [`catalog.json`](./catalog.json)
- one high-signal project memory file: [`nemoclaw/CLAUDE.md`](../../CLAUDE.md)
- one direct Claude Code maintenance skill preserved under [`nemoclaw/.claude/skills/claude-md-improver`](../../.claude/skills/claude-md-improver)

The architecture is intentionally asymmetric:

- `sonnet-skills` owns repo-specific reasoning and stage control
- `anthropic-skills` owns Anthropic-derived markdown, memory, skill, and MCP patterns

## 13. Final Actions to Perform

Completed in this curation:

- cloned and audited `anthropics/skills`
- audited `anthropics/claude-plugins-official`
- installed `claude-md-improver`
- replaced the prior 28-skill project-local install with two curated bundles
- added a project-local skill catalog for runtime visibility
- added `nemoclaw/CLAUDE.md`
- integrated bundle visibility into wrapper status/UI
- added artifact tags and provenance metadata to generated repo manifests
- updated docs and lock metadata to reflect the curated architecture
