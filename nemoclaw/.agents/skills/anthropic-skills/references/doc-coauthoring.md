# Structured Doc Co-Authoring

Adapted from Anthropic's `doc-coauthoring` skill.

## Three Useful Stages

1. Context capture
   - collect audience, purpose, constraints, and missing facts
2. section drafting
   - build the document from the sections with the most uncertainty first
3. reader test
   - check whether the document works for someone without hidden context

## Use in This Repo

Use this workflow when refining:

- product idea markdown before Mermate render
- architecture notes that will become Mermaid
- specification text that should survive translation into TLA+
- repo handoff docs such as `CLAUDE.md` or builder manifests

## Compression Rules

- Ask for the minimum missing context, not a generic interview.
- Draft the hardest section first.
- Treat summaries and intros as downstream of the actual technical decision.
- Favor short, explicit sentences over persuasive prose.

## Reader-Test Questions

Before shipping a spec, ask:

- Can a reader identify the system boundary?
- Can they tell what the artifact promises versus what it merely suggests?
- Can they find failure handling and out-of-scope items quickly?
- Could they turn the document into Mermaid, TLA+, or code without guessing core behavior?
