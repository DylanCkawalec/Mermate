# Meta-Tagging for Builder Artifacts

Use tags only when they improve orchestration. For this repo, the useful tag groups are:

## Required Tag Groups

- `stage:*`
  - `idea`, `markdown`, `mmd`, `tsx`, `tla`, `ts`, `repo`
- `artifact:*`
  - `concept-brief`, `architecture-diagram`, `formal-spec`, `runtime`, `runtime-harness`, `project-memory`
- `representation:*`
  - `markdown`, `mermaid`, `tla+`, `cfg`, `typescript`, `json`
- `intent:*`
  - `problem`, `scope`, `structure`, `boundary`, `behavior`, `invariant`, `verification`, `scaffold`
- `source:*`
  - `user`, `mermate`, `openclaw`, `manual`
- `status:*`
  - `input`, `compiled`, `validated`, `generated`, `curated`

## Provenance Fields

Every manifest that governs a generated repo should preserve:

- `run_id`
- `diagram_name`
- `transformation_path`

`transformation_path` should describe the major stage transitions, not every micro-edit.

## Application Rules

- Every artifact gets exactly one stage, one artifact type, one representation, one source, and one status.
- Intents may be multiple, but only when each intent changes how an agent should reason about the artifact.
- When a stronger artifact supersedes a weaker one, keep the weaker artifact for provenance but do not promote it back to canonical status.
- Do not tag files just to tag them. If a tag would not affect routing, validation, or handoff decisions, omit it.
