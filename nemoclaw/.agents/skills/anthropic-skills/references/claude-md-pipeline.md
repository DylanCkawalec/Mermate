# CLAUDE.md and Markdown Pipeline

Adapted from `claude-md-improver` and its quality references.

## Direct Skill Location

The direct Claude Code install lives at:

- `.claude/skills/claude-md-improver`

Use that when the task is explicitly about `CLAUDE.md` maintenance in Claude Code. Use this reference when the work is broader markdown/spec pipeline design in the project-local bundle.

## Audit Rubric

Check four things before editing:

- commands still work
- architecture map still matches current files
- non-obvious gotchas are captured
- the file is concise enough to be prompt-worthy

## Where This Repo Uses It

- `CLAUDE.md` as project memory for the wrapper
- builder-facing docs when runtime, scaffold, or manifest behavior changes
- markdown blocks before they become Mermate inputs
- specification text before TLA+ generation when the input feels loose or ambiguous

## Editing Rules

- Output the problems first, then propose targeted additions
- Prefer minimal diffs
- Add project-specific commands, quirks, and file paths
- Do not stuff generic advice into `CLAUDE.md`
- Treat `CLAUDE.md` as memory for future Claude sessions, not as a second README

## Good Triggers

Use this pipeline when:

- the wrapper code changed materially
- builder or scaffold behavior changed
- spec handoff docs drifted from reality
- the next formal transformation depends on clearer markdown
