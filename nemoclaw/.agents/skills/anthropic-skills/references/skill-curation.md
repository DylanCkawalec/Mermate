# Skill Curation Rules

Adapted from Anthropic `skill-creator` guidance and Anthropic skill-writing best practices.

## What Makes a Good Skill Here

- Narrow trigger surface
- Strong description focused on when to use, not how the workflow works
- Short top-level body with references for deeper material
- Direct value to the Mermate/OpenClaw architecture path

## Description Rules

- Start with "Use when..."
- Describe the triggering situation, not the full workflow
- Include the concrete repo terms Claude will search for
- Avoid broad claims that would cause over-triggering

## Progressive Disclosure

- Keep `SKILL.md` focused on routing, guardrails, and order of operations
- Move large checklists and templates into `references/`
- Remove any example or asset that does not improve the target repo behavior

## Retention Test

Keep a file only if it clearly improves one of:

- markdown refinement
- specification refinement
- TLA+ preparation
- OpenClaw/MCP architecture work
- repo synthesis and provenance

Everything else is clutter.
