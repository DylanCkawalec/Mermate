---
name: anthropic-skills
description: Use when improving project memory or markdown quality, co-authoring architecture or specification documents, curating Claude-facing skills, or tightening MCP and plugin surfaces for OpenClaw and Nemoclaw. This bundle integrates the claude-md-improver workflow and selected Anthropic patterns without importing the rest of the example catalog.
---

# Anthropic Skills

This bundle keeps only the Anthropic patterns that materially strengthen this repository.

## Read Order

1. For `CLAUDE.md`, project memory drift, or markdown preflight, read [references/claude-md-pipeline.md](references/claude-md-pipeline.md).
2. For architecture/spec writing, read [references/doc-coauthoring.md](references/doc-coauthoring.md).
3. For skill descriptions and bundle maintenance, read [references/skill-curation.md](references/skill-curation.md).
4. For MCP or plugin surface changes, read [references/mcp-patterns.md](references/mcp-patterns.md).

## Use This Bundle To

- audit and improve `CLAUDE.md`
- harden markdown before it becomes Mermaid or formal input
- structure collaborative spec writing without importing a giant document toolkit
- keep Claude-facing skill descriptions sharp and discoverable
- keep wrapper MCP surfaces concise, typed, and easy for Claude to select

## Hard Rules

- Keep every retained instruction project-specific and high-signal.
- Show markdown or `CLAUDE.md` quality gaps before rewriting them.
- Prefer targeted additions over full rewrites unless structure is irrecoverably weak.
- Separate skill trigger language from workflow details.
- Keep MCP contracts explicit and compact enough for reliable tool choice.
