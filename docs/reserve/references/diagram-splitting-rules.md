# Diagram Splitting Rules

Use this guide to decide when one diagram should become several.

A common failure mode is trying to force the whole system into one Mermaid view.
When this happens, the result looks busy, clever, and weak.

## Core rule

Split diagrams when a single view can no longer preserve:
- structural clarity
- correct abstraction level
- readable flow
- meaningful boundaries

A smaller set of strong diagrams is better than one overloaded diagram.

## Signs that a diagram should be split

### 1. Multiple abstraction levels are mixed
Examples:
- business process mixed with infra topology
- human workflow mixed with service internals
- runtime states mixed with deployment nodes

Action:
- separate by abstraction level

### 2. Topology and behavior compete
Examples:
- system context plus detailed request flow
- topology plus event choreography
- architecture boundaries plus stepwise state transitions

Action:
- separate structural view from behavioral view

### 3. Failure paths dominate the main view
Examples:
- retries, DLQs, fallbacks, escalations overwhelm the happy path
- too many edge styles and exception labels clutter the whole system

Action:
- keep the main architecture clean
- move failure/recovery into a dedicated operational or exception-flow diagram

### 4. Security or policy logic is central
Examples:
- trust boundaries matter
- role-based control matters
- human approval/escalation matters
- policy gates shape the design materially

Action:
- create a dedicated security/policy view if those concerns clutter the main architecture

### 5. State is a first-class concern
Examples:
- rollout lifecycle
- workflow lifecycle
- pod/job/document/order states
- many transitions and terminal states

Action:
- create a state diagram instead of forcing lifecycle into a flowchart

### 6. Deployment and runtime logic both matter
Examples:
- multi-region network topology
- Kubernetes / mesh / infra deployment
- runtime service behavior
- external provider dependencies

Action:
- split into:
  - logical architecture
  - deployment / infrastructure topology

## Standard view families

Use these as the default split strategy for hard systems.

### A. System context
Show:
- external actors
- external systems
- high-level services
- major data boundaries

Avoid:
- deep retries
- infra detail
- state-machine detail

### B. Logical service architecture
Show:
- major services
- stores
- brokers
- synchronous and async flows
- internal architectural boundaries

Avoid:
- deployment detail
- too much operational exception detail

### C. Failure / retry / escalation
Show:
- retries
- backoff
- DLQ
- fallback
- human escalation
- recovery loops

Avoid:
- full topology unless necessary

### D. Security / policy / trust boundaries
Show:
- identity
- authz
- policy decisions
- trust zones
- human approval gates
- audit/logging if security-relevant

### E. Lifecycle / state
Show:
- object or workflow states
- transitions
- abort/rollback/retry states
- success/failure end states

### F. Deployment / infrastructure
Show:
- clusters
- regions
- ingress/mesh
- network boundaries
- storage topology
- external infrastructure dependencies

## Split-decision questions

Ask these after each render:

1. Is the main point of the diagram still obvious?
2. Is there more than one abstraction level competing here?
3. Are failure paths overwhelming the core view?
4. Would engineers argue about different parts of this in different meetings?
5. Would a separate state or infra view make the system easier to reason about?
6. Is the diagram readable without zooming and hunting?

If 2 or more answers suggest overload, split the diagram.

## Naming split diagrams

Use clear view names such as:
- System Context
- Logical Architecture
- Failure and Recovery
- Security and Trust Boundaries
- Lifecycle States
- Deployment Topology

Do not use vague labels like:
- Final Diagram 2
- Better Version
- Retry One

## Important rule

Splitting a diagram is not admitting failure.
It is usually a sign of stronger architecture thinking.

The goal is not one giant beautiful picture.
The goal is a correct and usable set of architectural views.