# Render Strategy

Use this guide to operate Mermate intelligently over many iterations.

The goal is to use cheap renders for learning and expensive renders for finishing.

## Core render modes

### Default / cheap render
Use this often.

Purpose:
- validate structure
- test whether the current draft produces a useful diagram
- inspect decomposition quality
- inspect naming and layout
- identify missing flows or failure paths
- compare iterations

This is diagnostic rendering, not final rendering.

### Max render
Use this sparingly.

Purpose:
- get the strongest final architecture output
- use the most capable configured premium model (`MERMATE_AI_MAX_MODEL`)
- obtain richer layering and better decomposition (AAD-style subgraphs)
- produce final-grade diagrams after the design is already mature

Activation: click the **Max** toggle button next to Render, or send `max_mode: true` in the API request.

Cost: approximately 26x more expensive than default render (~$0.012 vs ~$0.0005).

Max mode sends the same prompt but uses the stronger model, which typically produces:
- 5-8 subgraphs with architectural layer labels
- Multi-line node labels with responsibilities
- Proper node shapes (cylinders for stores, hexagons for externals)
- classDef coloring for architectural layers
- Legend subgraph

If the configured Max model is unavailable (HTTP error), the system gracefully falls back to the default premium model.

Do not use Max early unless the task explicitly demands it and cost is not a concern.

## Default operating cycle

For difficult architecture work:

1. draft the problem and first architecture text
2. use copilot suggestion loops
3. perform a cheap/default render
4. inspect the returned diagram
5. refine the text based on actual structural weaknesses
6. repeat many times
7. only use Max once the text is strong enough to benefit from it

## Recommended iteration counts

For serious architectures:
- use **10 or more** cheap/default renders
- use **dozens** of suggestion cycles if needed
- use **1–3** max renders at the end

If the architecture is especially hard or large:
- split it into multiple diagrams
- give each view its own cheap/default render loop
- use Max only once each view is mature

## What cheap renders are for

Cheap renders are for asking:
- is the diagram type correct
- is the system too flat
- is the diagram overloaded
- are boundaries weak
- are failure paths missing
- are labels weak
- should this be split into multiple diagrams

Cheap renders are not final-quality judgments.

## What Max renders are for

Max renders are for:
- final presentation quality
- stronger architectural decomposition
- improved grouping/layering
- richer labels where useful
- best available final architecture diagram

Max renders should happen only after the text has been deliberately strengthened.

## When to render again

Render again when:
- you made a real structural change
- you added a major failure path
- you changed decomposition
- you split the system into a new view
- the prior render exposed a genuine architecture weakness

Do not render again after trivial wording edits unless they materially change the structure.

## When to stop rendering

Stop when:
- further renders produce only cosmetic differences
- the problem is already well represented
- the architecture is structurally correct
- the main view is readable
- key operational or failure concerns are covered
- another diagram would not significantly improve engineering understanding

## Multi-view strategy

Prefer multiple coherent renders instead of one overloaded diagram.

Typical render set for hard systems:
1. **System context**
2. **Logical services and data flows**
3. **Failure / retry / escalation**
4. **Security / trust / policy**
5. **Lifecycle / state machine**
6. **Deployment / infra topology**

Not all systems need all views.

## Render comparison method

After each render, compare against the previous version:

### Ask:
- what became clearer
- what became noisier
- what became more correct
- what got flattened
- what disappeared
- what still needs its own view

### Do not just prefer the newest one
Prefer the render that is:
- more correct
- more readable
- more structured
- more useful for engineering discussion

## Pre-Max checklist

Before running Max, verify:
- naming is stable
- boundaries are intentional
- problem statement is fully represented
- failure and recovery paths are explicit where needed
- unnecessary clutter has been removed
- the draft text is stronger than any earlier draft
- the diagram should not be split further

If this checklist fails, do more cheap renders first.

## Max escalation rule

Use Max only when one or more are true:
- the architecture is highly complex
- you want final-grade output
- the current default render is correct but too flat
- better decomposition would materially help
- this is the version meant to be kept, shown, or used downstream

## Final-output policy

The final chosen output should not merely be the most expensive render.
It should be the render that best balances:
- correctness
- decomposition
- readability
- usefulness
- fidelity to the problem