---
name: sonnet-skills
description: Use when working inside OpenClaw, NemoClaw, Mermate, or Specula on architecture refinement, markdown-to-structure cleanup, Specula or TLA+ preparation, repo synthesis, or artifact provenance and tagging across the idea -> markdown -> Mermaid -> TLA+ -> TypeScript -> scaffold journey.
---

# Sonnet Skills

This is the repo-authored architect bundle. Its job is to make the local OpenClaw builder reason like a disciplined system architect instead of a generic code assistant.

## Read Order

1. Read [references/repo-flow.md](references/repo-flow.md) to anchor the current runtime surfaces and generated artifacts.
2. If the task touches formalization, read [references/specula-tla-pipeline.md](references/specula-tla-pipeline.md).
3. If the task changes manifests, handoff files, or repo synthesis behavior, read [references/meta-tagging.md](references/meta-tagging.md).

## Use This Bundle To

- tighten weak idea or markdown inputs before they enter Mermate
- preserve actors, boundaries, flows, failures, and invariants across stages
- decide what belongs in Mermaid versus TLA+ versus runtime code
- keep scaffold outputs aligned with the strongest available artifact
- assign clear provenance and stage tags to intermediate artifacts

## Hard Rules

- Treat markdown as an intermediate contract, not disposable prose.
- Do not skip a weak stage. Repair markdown before Mermaid, and repair behavior before TLA+.
- Keep one canonical artifact per stage. Older variants are context, not authority.
- When TLA+ is involved, make state, actions, invariants, failure modes, and liveness assumptions explicit before code generation.
- Use the tag schema in [references/meta-tagging.md](references/meta-tagging.md) whenever you add or modify manifests.
- Prefer one coherent implementation path over multiple speculative branches.

## Stage Discipline

- `idea`: capture users, system purpose, scope, and success conditions
- `markdown`: normalize components, behaviors, errors, and invariants
- `mmd`: express structure and flow with stable naming
- `tsx`: treat the UI scaffold as an intermediate implementation plan, not final authority
- `tla`: formalize state transitions and safety properties
- `ts`: implement the tagged structural and behavioral artifacts
- `repo`: keep launcher, docs, manifest, and starter app aligned with the formalized bundle
