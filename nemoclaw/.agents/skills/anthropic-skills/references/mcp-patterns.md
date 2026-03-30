# MCP and Plugin Patterns

Adapted from Anthropic `mcp-builder`.

## What Matters Here

OpenClaw already exposes a local MCP server. The useful discipline is not generic server generation; it is keeping the tool surface small, typed, and stage-aware.

## Rules

- One clear task intent per tool
- Verb-first names
- concise descriptions that help Claude pick the right tool
- structured errors instead of opaque failures
- no hidden transport assumptions in tool descriptions

## Apply This to Nemoclaw

When changing `mcp/server.ts` or plugin-facing docs:

- prefer tools that map to real wrapper capabilities
- avoid adding speculative tools with no stable backend surface
- keep formalization tools (`mermate_generate_tla`, `mermate_generate_ts`) visibly downstream of render/build stages
- expose metadata that helps Claude route work, such as the curated skill catalog, rather than more generic tools

## High-Leverage Additions

- status tools that explain current runtime state
- builder tools that preserve provenance from run id to scaffold
- metadata fields that reduce hidden assumptions in downstream sessions
