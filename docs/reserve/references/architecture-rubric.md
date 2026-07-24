# Architecture Rubric

Use this rubric every time you assess a Mermate draft or rendered diagram.

A diagram is not good because it is detailed.
A diagram is good because it is structurally correct, readable, and useful for real engineering judgment.

## Scoring scale

Use a 1–5 score for each category.

- **1** = poor / misleading
- **2** = weak
- **3** = acceptable
- **4** = strong
- **5** = architect-grade

A final design should usually score:
- no category below **3**
- at least **4** in structure, correctness, and readability
- at least **4** in failure handling for production-grade systems
- at least **4** in decomposition if the system is large

## Categories

### 1. Problem fidelity
Does the design actually solve the user’s stated problem?

Check:
- does the diagram reflect the real problem statement
- are the main actors present
- are the core outcomes represented
- are key constraints respected

Red flags:
- diagram looks sophisticated but does not answer the problem
- major actors or flows are missing
- the system is technically interesting but irrelevant

### 2. Architectural correctness
Are components, relationships, and responsibilities correct?

Check:
- right services for the job
- correct relationship direction
- correct store / queue / broker / cache roles
- no impossible or nonsensical dependencies
- stateful vs stateless elements represented correctly where relevant

Red flags:
- everything connects to everything
- stores are treated like services
- event streams and request/response are confused
- failure handling contradicts the main architecture

### 3. Decomposition quality
Is the system split into the right boundaries?

Check:
- major boundaries are clear
- control plane vs data plane is separated if needed
- logical services are not collapsed into one blob
- infra concerns do not pollute the business-flow view unless intentional
- large systems are split into multiple diagrams when necessary

Red flags:
- flat diagrams for systems that clearly need layers
- deployment topology mixed chaotically into app logic
- business flow, infra, and lifecycle all jammed into one weak view

### 4. Flow clarity
Can a human follow the architecture?

Check:
- main path is obvious
- alternate path is obvious
- failure path is obvious
- labels help instead of cluttering
- order of operations can be understood

Red flags:
- excessive crossing edges
- too many unlabeled arrows
- sequence is ambiguous
- failure/retry paths are buried

### 5. Failure and recovery design
Production systems require explicit failure behavior.

Check:
- retries shown where relevant
- DLQ or dead-end handling shown where relevant
- escalation paths shown where relevant
- timeout / fallback logic represented when central
- recovery behavior not ignored

Red flags:
- architecture assumes everything always works
- no treatment of high-risk or high-failure pathways
- retries exist in prose but not in diagram

### 6. Operational realism
Would a real team find this useful?

Check:
- observability present where appropriate
- logging / tracing / audit if the domain requires it
- policy and access control if the domain requires it
- roles or humans included when the design depends on them

Red flags:
- architecture is “clean” only because real concerns were omitted
- no observability in a production-grade design
- risky systems with no human review or audit path

### 7. Diagram readability
The diagram must be visually usable.

Check:
- node names are concise
- labels are meaningful
- grouping improves readability
- shape selection is helpful
- rendering is not overloaded

Red flags:
- giant crowded graph
- labels that repeat obvious words
- every node has long paragraphs
- multiple conceptual levels mixed together

### 8. Mermaid suitability
Is Mermaid the right representation and is it being used correctly?

Check:
- correct Mermaid type chosen
- flowchart used for structure/topology
- sequence used for interactions
- state diagram used for lifecycle
- mindmap used only when structure is exploratory rather than operational

Red flags:
- sequence diagrams for architecture overviews
- flowcharts for rich lifecycle logic that needs states
- one Mermaid type forced onto the wrong problem

## Decision rules

### Accept the design
Accept when:
- problem fidelity is strong
- architecture is structurally correct
- the diagram is readable
- failure/recovery is represented where relevant
- there is no major conceptual confusion

### Refine the design
Refine when:
- the core is correct but weakly decomposed
- failure paths are missing
- the diagram is too flat
- naming is vague
- there is too much clutter

### Split into multiple diagrams
Split when:
- one diagram mixes multiple abstraction levels
- topology and runtime flow are both important
- failure handling deserves separate emphasis
- security / trust boundaries deserve separate treatment
- state/lifecycle deserves its own representation

### Reject the design
Reject when:
- the system does not solve the problem
- major actors or responsibilities are wrong
- the flow is misleading
- the diagram is visually confusing enough to hurt engineering judgment
- the architecture is “fancy” but not real

## Final judgment template

Use this summary after each serious render:

- **Problem fidelity:** X/5
- **Architectural correctness:** X/5
- **Decomposition quality:** X/5
- **Flow clarity:** X/5
- **Failure/recovery:** X/5
- **Operational realism:** X/5
- **Readability:** X/5
- **Mermaid suitability:** X/5

Then conclude with one of:
- **Accept**
- **Refine**
- **Split into multiple diagrams**
- **Reject and re-architect**

## Important rule

Do not reward diagrams for surface complexity.
Reward them for structural truth.