# Specula and TLA+ Preparation

## What the Formal Stage Needs

Before a Mermaid artifact can become a useful TLA+ model, the markdown and diagram phases must make the following explicit:

- actors or external participants
- system state and durable records
- state transitions and their triggers
- safety invariants
- failure paths and degraded modes
- assumptions about concurrency, retries, or ordering

If any of those are implicit, the formal stage is weak.

## Pre-TLA Cleanup Checklist

- Separate structure from behavior. Components alone are not a specification.
- Name states and transitions consistently across markdown, Mermaid, and formal artifacts.
- Turn vague verbs such as "handles" or "manages" into explicit actions.
- Turn vague guarantees such as "stays consistent" into invariants.
- Turn vague failures such as "errors" into concrete failure classes and expected outcomes.
- Identify what is out of scope so the model does not accidentally formalize wishful behavior.

## Translation Map

| Input Surface | Formal Meaning |
|---|---|
| component or subgraph | state owner or responsibility boundary |
| arrow / interaction | action or transition candidate |
| note about validation | invariant or guard |
| retry / timeout language | liveness, fairness, or recovery assumption |
| failure path | error transition or forbidden state |

## Stop Conditions

Do not continue into TLA+ when:

- the diagram still mixes user goals with implementation guesses
- component names are unstable
- actions depend on hidden state not represented anywhere
- invariants cannot be stated as short, testable sentences
- failure handling is described as "etc." or "edge cases"

Repair the markdown or Mermaid stage first, then return to formalization.
