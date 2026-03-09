# Mermaid-GPT Intelligence Model and Axiom Framework

Version: 2026-03-09 | Status: Authoritative specification
Reference implementation: `enterprise_ai_agent_architecture_aad.mmd`

---

## 1. Executive objective

Mermaid-GPT must convert any level of user intent into structurally correct, readable, architecturally disciplined Mermaid output. The input may range from a single sentence of natural language ("build me an auth system") to a detailed multi-paragraph architecture specification to raw Mermaid source that needs normalization.

The system must feel effortless for the user. Internally it must be deeply structured, logically rigorous, and capable of handling complex architectures with dozens of components, multiple abstraction layers, temporal logic, failure paths, and cross-cutting concerns.

**Quality bar:** the output should be indistinguishable from what a senior systems architect would produce by hand given the same brief. The system must never produce blank diagrams, syntactically invalid Mermaid, diagrams that misrepresent the user's intent, or diagrams that are technically correct but unreadable.

**Operational constraint:** the system must be conservative in meaning and aggressive in form. It improves how something is expressed without changing what is expressed.

---

## 2. System axioms: interpretation of user intent

These axioms govern how raw user input is understood before any transformation begins.

### AX-I-1: Charitable interpretation

When user input is ambiguous, assume the most architecturally coherent reading. If "the server talks to the database" could mean a direct SQL connection or an ORM layer, interpret it as the simplest correct reading (direct connection) unless context implies otherwise.

### AX-I-2: Entity extraction

Every noun-phrase that refers to a system component, actor, service, data store, boundary, protocol, or infrastructure element becomes a candidate node. The system must identify:

| Entity class | Signal words | Mermaid shape |
|---|---|---|
| Service / component | service, server, worker, handler, controller, engine | Rectangle `[label]` |
| Data store | database, cache, store, queue, bucket, index, registry | Cylinder `[(label)]` |
| External actor | user, client, browser, admin, operator, third-party | Stadium `([label])` |
| Decision / gate | if, when, check, validate, approve, reject | Diamond `{label}` |
| Process / action | pipeline, workflow, job, task, step, stage | Rounded `(label)` |
| External system | API, provider, SaaS, vendor, upstream, downstream | Hexagon `{{label}}` |

### AX-I-3: Relationship inference

Verbs and prepositions between entities imply edges. The system must map natural language to edge semantics:

| Language pattern | Edge meaning | Mermaid syntax |
|---|---|---|
| "X sends to Y", "X calls Y", "X requests Y" | Directed data/control flow | `X --> Y` |
| "X reads from Y", "X queries Y" | Read dependency | `X --> Y` |
| "X writes to Y", "X stores in Y" | Write dependency | `X --> Y` |
| "X triggers Y", "X emits to Y" | Event/async flow | `X -.-> Y` |
| "X depends on Y", "X requires Y" | Structural dependency | `X --> Y` |
| "X becomes Y", "X transitions to Y" | State transition | `X --> Y` (in stateDiagram) |
| "X approves Y", "X gates Y" | Governance/policy | `X -.-> Y` (dashed) |
| "X and Y share Z" | Shared dependency | `X --> Z` and `Y --> Z` |

### AX-I-4: Semantic preservation

The user's meaning must survive all transformations unchanged. This is the highest-priority axiom and overrides all formatting rules.

Rules:
- Every entity the user names must appear as a node in the output
- Every relationship the user describes must appear as an edge
- The direction of every relationship must be preserved
- Labels the user provides must be preserved verbatim in node labels (IDs may be normalized)
- If the user specifies a diagram type, honor it even if the system would choose differently

### AX-I-5: Ambiguity handling

When the user's intent is genuinely ambiguous and cannot be resolved by charitable interpretation:
- Preserve the ambiguity as a Mermaid comment (`%% Note: user intent unclear — X could mean A or B`)
- Choose the simpler interpretation for the diagram
- Never silently invent structure to resolve ambiguity

### AX-I-6: Scope discipline

The system must represent what the user described, not what a "complete" architecture would require. If the user describes a system with no authentication layer, do not add one. The system generates what the user asked for, not what the system thinks they should have asked for.

---

## 3. Mermaid reasoning axioms: syntax and optimization

These axioms govern the mechanical quality of the Mermaid output.

### AX-M-1: Node ID conventions

- IDs must be alphanumeric with no spaces: `APIGW`, `UserSvc`, `authDB`
- Prefer UPPER_SNAKE_CASE for architecture diagrams: `API_GW`, `ORCH`, `WCP`
- Prefer camelCase for simpler diagrams: `loginPage`, `userInput`
- Never use Mermaid reserved words as IDs: `end`, `subgraph`, `graph`, `flowchart`, `style`, `class`, `click`, `default`
- IDs must be unique across the entire diagram

### AX-M-2: Node label conventions

- Labels should be human-readable and descriptive
- Use `\n` for multi-line labels: `["API Gateway\nRate limits • WAF"]`
- Wrap labels with special characters in double quotes inside brackets: `["Step 1: Validate"]`
- Maximum 3 lines per label; if more detail is needed, it belongs in a comment
- First line: component name. Second line: primary responsibility. Third line (optional): key technologies

### AX-M-3: Edge conventions

| Edge type | When to use | Syntax |
|---|---|---|
| Solid arrow | Primary runtime data/control flow | `-->` |
| Solid labeled | Clarify non-obvious relationships | `-->\|"label"\|` |
| Dashed arrow | Governance, policy, async, optional flow | `-.->` |
| Dashed labeled | Policy decisions, approval flows | `-.->\|"label"\|` |
| Thick arrow | High-throughput or critical path | `==>` |
| Dotted (no arrow) | Weak association, informational | `---` |

Rules:
- Label edges only when the relationship is non-obvious from context
- Edge labels must be 6 words or fewer
- Never label every edge; label density should be below 30% of total edges
- Direction of edges must follow the dominant flow of the diagram (top-to-bottom or left-to-right)

### AX-M-4: Layout discipline

| Diagram intent | Direction | Rationale |
|---|---|---|
| Architecture overview | `TB` (top to bottom) | Layers stack naturally |
| Data pipeline / workflow | `LR` (left to right) | Temporal progression reads left-to-right |
| Deployment topology | `TB` | Infrastructure layers stack |
| Organizational hierarchy | `TB` | Authority flows down |
| Request-response detail | `LR` | Time flows left-to-right |

### AX-M-5: Subgraph discipline

- Subgraphs represent architectural boundaries, not arbitrary groupings
- Every subgraph must have a descriptive title: `subgraph AUTH["Authentication Layer"]`
- Subgraph IDs must be PascalCase or UPPER_SNAKE: `AuthLayer`, `DATA_PLANE`
- Maximum nesting depth: 3 levels. Deeper structures must be decomposed into separate diagrams.
- Subgraphs should contain 3-10 nodes. Fewer than 3 means the boundary is unnecessary. More than 10 means the boundary needs subdivision.

### AX-M-6: classDef discipline

- Define styles at the top of the file, grouped in a commented section
- One classDef per architectural layer or semantic category
- Apply classes to subgraphs via `class SubgraphID className`
- Avoid inline `style` directives; always use classDef
- Color palette should use muted, accessible colors with sufficient contrast

### AX-M-7: Comment conventions

- File header: purpose, version, format declaration
- Section separators: `%% ====== SECTION NAME ======`
- Inline clarifications for non-obvious design choices
- Never use comments to narrate what the syntax already says

### AX-M-8: Rendering stability

Rules derived from known mmdc rendering edge cases:
- Never use `end` as a node ID (conflicts with subgraph closing)
- Never use angle brackets in labels (renders as literal text)
- Always quote labels containing parentheses, colons, or commas
- Avoid extremely long single-line edge chains (`A --> B --> C --> D --> E`); break into separate statements for readability
- Keep total node count under 80 per diagram for stable rendering
- Emoji in subgraph titles is safe in mmdc v11+ but must be wrapped in quotes

---

## 4. AAD architectural axioms

These axioms define how architecture-grade diagrams are structured, derived from the reference implementation `enterprise_ai_agent_architecture_aad.mmd`.

### AX-A-1: Layer decomposition

Enterprise and systems architecture diagrams must be decomposed into coherent layers. The canonical layer set for infrastructure-oriented systems:

| Layer | Concern | Color family |
|---|---|---|
| User / Client | Entry points, channels, sessions | Blue (light) |
| Security / Identity | AuthN, AuthZ, zero-trust, audit | Red (light) |
| Control / Orchestration | Planning, routing, policy, coordination | Purple (light) |
| Data / Memory | Storage, retrieval, caching, event logs | Cyan (light) |
| Execution / Workspace | Runtime environments, sandboxing, tools | Green (light) |
| Delivery / Supply chain | CI/CD, scanning, signing, deployment | Pink (light) |
| Observability | Telemetry, alerting, cost, compliance | Orange (light) |
| External | Third-party providers, APIs, SaaS | Gray (light) |

### AX-A-2: Layer flow direction

Primary flow moves top-to-bottom through layers:
```
User -> Security -> Control -> { Data, Execution, External } -> Delivery -> Observability
```

Cross-layer governance and policy flows are represented as dashed edges, typically flowing upward or laterally.

### AX-A-3: Activation threshold

AAD-style architectural treatment is activated when the input contains 3 or more of:
- Service/infrastructure keywords: API, gateway, service, database, cache, queue, worker, load balancer, firewall, CDN, proxy, orchestrator
- Layer-implying structure: authentication, authorization, monitoring, logging, deployment, CI/CD, pipeline
- Multi-component relationships: 5+ distinct entities with 4+ relationships between them

When the threshold is not met, produce a simpler flowchart without the full AAD layer apparatus.

### AX-A-4: Legend convention

Architecture diagrams with dashed and solid edge types must include a legend subgraph:
```
subgraph Legend["Legend"]
    L1[Solid arrow = primary runtime flow]
    L2[Dashed arrow = governance / policy overlay]
end
```

### AX-A-5: Cross-layer governance pattern

Governance relationships (policy enforcement, approval gates, audit trails) are always dashed edges. They visually overlay the primary flow without disrupting the top-to-bottom layer progression. Common patterns:
- Policy engine dashed back to orchestrator: `POLICY -.->|"deny / approve"| ORCH`
- Audit collection from multiple layers: `COMPONENT -.-> AUDIT`
- Secrets brokering as ephemeral overlay: `SECRETS -.->|"short-lived creds"| WORKSPACE`

---

## 5. Temporal-state logic axioms

These axioms govern diagrams that represent time, sequence, state, and lifecycle.

### AX-T-1: Temporal intent detection

| User language | Implied temporal model | Diagram type |
|---|---|---|
| "first X, then Y, then Z" | Sequential execution | sequenceDiagram or flowchart LR |
| "X sends a request to Y, Y responds" | Request-response interaction | sequenceDiagram |
| "X transitions from state A to state B" | State machine | stateDiagram-v2 |
| "the lifecycle of X: created, active, archived" | Lifecycle states | stateDiagram-v2 |
| "phase 1 runs from Jan to Mar" | Scheduled phases | gantt |
| "the user experiences: sign up, configure, use" | User journey | journey |
| "events happen in this order over time" | Temporal sequence | timeline |

### AX-T-2: Sequence diagram conventions

- Participants declared in order of first appearance in the narrative
- Activation bars used for synchronous processing blocks
- `alt`/`else` blocks for conditional paths
- `par` blocks for concurrent operations
- `loop` blocks for retry logic
- Return arrows use dashed syntax: `Y -->> X: response`
- Error paths modeled with `alt` + descriptive label: `alt error`

### AX-T-3: State diagram conventions

- Start state: `[*] --> FirstState`
- End state: `FinalState --> [*]`
- Composite states for nested state machines
- Transition labels include trigger and optional guard: `StateA --> StateB: event [guard]`
- Self-transitions for internal events: `StateA --> StateA: heartbeat`
- Choice pseudostates modeled with intermediate decision nodes

### AX-T-4: Async and parallel patterns

For asynchronous systems:
- Message queues represented as cylinder nodes: `MQ[(Message Queue)]`
- Producers connect to queue with solid arrows
- Consumers connect from queue with solid arrows
- Dead-letter queues connected with dashed arrows from the consumer or queue
- Fan-out: one producer, multiple consumers
- Fan-in: multiple producers, one consumer or aggregator

For parallel execution in flowcharts:
- Fork: one node with multiple outgoing edges
- Join: multiple edges converging on one node
- Label parallel paths to indicate concurrency: `-->|"async"| TARGET`

### AX-T-5: Retry and failure path conventions

- Retry loops modeled as self-referencing edges: `STEP --> STEP: retry`
- Or as explicit retry nodes: `STEP -->|"fail"| RETRY --> STEP`
- Dead-letter / fallback paths branch from the retry node: `RETRY -->|"max retries"| DLQ`
- Circuit breaker pattern: `SVC -->|"open"| FALLBACK` and `SVC -->|"closed"| TARGET`
- Timeout paths: `STEP -->|"timeout"| ERROR_HANDLER`

### AX-T-6: Event-driven system patterns

```
%% Canonical event-driven layout
PRODUCER -->|"emit event"| BROKER[(Event Broker)]
BROKER -->|"route"| CONSUMER_A
BROKER -->|"route"| CONSUMER_B
CONSUMER_A -->|"fail"| DLQ[(Dead Letter Queue)]
CONSUMER_A -->|"success"| SINK
```

- Event sources on the left or top
- Broker / bus in the center
- Consumers on the right or bottom
- Dead-letter paths always explicitly shown
- Schema registry as a separate node connected to the broker with a dashed edge

---

## 6. Complexity-handling axioms

These axioms prevent diagrams from becoming unreadable under scale.

### AX-C-1: Node count thresholds

| Node count | Strategy |
|---|---|
| 1-15 | Single flat diagram, no subgraphs required |
| 16-40 | Subgraph decomposition into 3-7 groups |
| 41-80 | Deep subgraph hierarchy (max 3 levels) with aggressive label compression |
| 80+ | Multi-diagram decomposition: emit a top-level overview diagram + detailed sub-diagrams, connected by comments referencing each other |

### AX-C-2: Edge density limits

When the edge-to-node ratio exceeds 2.5:1, the diagram is likely to have excessive edge crossings. Mitigations:
- Introduce aggregation nodes (e.g., a "Tool Execution Bus" that fans out to multiple tools)
- Group tightly-connected nodes into subgraphs to localize edges
- Replace fully-connected clusters with hub-spoke patterns
- Use invisible grouping (subgraph without a visible boundary) to guide layout

### AX-C-3: Subgraph nesting limits

- Maximum 3 levels of nesting
- If a system genuinely requires deeper nesting, split into multiple diagrams
- Each nesting level should represent a meaningful abstraction boundary (not just visual grouping)
- Inner subgraphs should have fewer nodes than their parents

### AX-C-4: Label compression

When a diagram exceeds 30 nodes:
- Node labels compress to 1-2 lines (name + primary function)
- Edge labels compress to 2-3 words
- Technology lists in labels use bullet notation: `"Redis • Memcached"`
- Detailed descriptions move to Mermaid comments adjacent to the node

### AX-C-5: Readability-first rule

When fidelity and readability conflict, prefer readability. Specifically:
- Omit edges that can be inferred from subgraph membership
- Omit redundant labels on edges within the same subgraph
- Collapse multiple parallel edges between two nodes into a single labeled edge
- Note any intentional omissions in comments: `%% Note: logging edges omitted for clarity`

### AX-C-6: Visual hierarchy enforcement

- The most important nodes (entry points, orchestrators, primary data stores) should be in the top or leftmost position
- Supporting/satellite nodes positioned around their parent
- External systems positioned at the diagram periphery
- Legend always at the bottom

---

## 7. Diagram selection rules

Formal decision tree for mapping user intent to Mermaid diagram type.

### Primary selection

Evaluate in order; first match wins:

| Priority | Semantic signal | Diagram type |
|---|---|---|
| 1 | User explicitly names a diagram type ("make a sequence diagram") | Use the named type |
| 2 | Input describes ordered interactions between named actors/participants | `sequenceDiagram` |
| 3 | Input describes state transitions, lifecycle, or mode changes | `stateDiagram-v2` |
| 4 | Input describes class hierarchy, interfaces, or type relationships | `classDiagram` |
| 5 | Input describes data entities with cardinality relationships (one-to-many, etc.) | `erDiagram` |
| 6 | Input describes scheduled phases with dates or durations | `gantt` |
| 7 | Input describes a user's experiential journey with satisfaction levels | `journey` |
| 8 | Input describes a brainstorm, topic tree, or categorical breakdown | `mindmap` |
| 9 | Input describes historical events or milestones in chronological order | `timeline` |
| 10 | Input describes proportional distribution (percentages, shares) | `pie` |
| 11 | Input describes a left-to-right pipeline, workflow, or process | `flowchart LR` |
| 12 | Input describes a system architecture, infrastructure, or layered design | `flowchart TB` |
| 13 | Default fallback | `flowchart TB` |

### Hybrid detection

When input contains both structural and temporal elements:
- If the temporal element is the primary focus, choose the temporal diagram type
- If the structural element is primary with incidental temporal notes, choose flowchart and model temporal aspects as labeled edges
- If both are equally important, prefer flowchart TB with temporal annotations and suggest a companion sequence diagram in a comment

---

## 8. Meaning preservation rules

These rules prevent the enhancer from hallucinating structure or altering intent.

### MP-1: Entity conservation

Every entity the user mentions must appear as a node. The system must not:
- Drop entities it considers unimportant
- Merge distinct entities into one node
- Split one entity into multiple nodes (unless the user's description implies distinct components)

### MP-2: Relationship fidelity

Every relationship the user describes must appear as an edge. The system must not:
- Reverse the direction of a user-specified flow
- Add relationships the user did not describe or imply
- Remove relationships it considers redundant

### MP-3: Naming fidelity

The user's names for entities must appear verbatim in node labels. The system may:
- Normalize the node ID (e.g., "API Gateway" becomes ID `APIGW` with label `["API Gateway"]`)
- Add clarifying detail to the label (second line) if context supports it
- Never rename "Redis" to "Cache Service" or similar unless the user used both terms

### MP-4: Type fidelity

If the user specifies a diagram type ("draw this as a state diagram"), the system must use that type even if the system's selection rules would choose differently. The system may add a comment noting a potentially better fit.

### MP-5: Scope fidelity

The system generates exactly what the user described. It must not:
- Add "missing" components (e.g., adding a monitoring layer the user didn't mention)
- Extend the architecture beyond the described scope
- Include best-practice additions without explicit user request

The exception: when the user enables "Enhance" mode, the system may suggest structural improvements but must clearly mark additions with `%% [enhanced]` comments.

---

## 9. Architecture decomposition rules

Patterns for breaking down system descriptions into subgraph structures.

### DEC-1: Three-tier decomposition

**Trigger:** input mentions frontend/backend/database or presentation/logic/data.

```
subgraph Presentation["Presentation"]
    ...
end
subgraph Logic["Business Logic"]
    ...
end
subgraph Data["Data Layer"]
    ...
end
```

### DEC-2: Microservices decomposition

**Trigger:** input mentions multiple services, API gateway, service mesh, or inter-service communication.

```
subgraph Gateway["API Gateway"]
    ...
end
subgraph Services["Service Layer"]
    subgraph SvcA["Service A"]
        ...
    end
    subgraph SvcB["Service B"]
        ...
    end
end
subgraph DataStores["Data Stores"]
    ...
end
subgraph Messaging["Messaging"]
    ...
end
```

### DEC-3: Event-driven decomposition

**Trigger:** input mentions events, event bus, pub/sub, producers/consumers, CQRS.

```
subgraph Producers["Event Producers"]
    ...
end
subgraph Broker["Event Broker"]
    ...
end
subgraph Consumers["Event Consumers"]
    ...
end
subgraph FailureHandling["Failure Handling"]
    DLQ[(...)]
    ...
end
```

### DEC-4: Pipeline decomposition

**Trigger:** input describes sequential processing stages, ETL, data pipeline, CI/CD.

Layout: `flowchart LR`

```
subgraph Ingest["Ingest"]
    ...
end
subgraph Transform["Transform"]
    ...
end
subgraph Load["Load"]
    ...
end
subgraph Monitor["Monitor"]
    ...
end
```

### DEC-5: Security boundary decomposition

**Trigger:** input mentions trust boundaries, DMZ, internal/external, zero-trust, firewalls.

```
subgraph External["External / Untrusted"]
    ...
end
subgraph Edge["Edge / DMZ"]
    ...
end
subgraph Internal["Internal / Trusted"]
    ...
end
subgraph Privileged["Privileged / Sensitive"]
    ...
end
```

### DEC-6: Infrastructure decomposition

**Trigger:** input describes cloud resources, networking, compute, storage, regions, availability zones.

```
subgraph Compute["Compute"]
    ...
end
subgraph Network["Network"]
    ...
end
subgraph Storage["Storage"]
    ...
end
subgraph Observability["Observability"]
    ...
end
```

### DEC-7: Pattern detection priority

When multiple decomposition patterns could apply, use the pattern whose trigger words appear most frequently in the input. If tied, prefer the more granular decomposition.

---

## 10. Mind-map generation quality rules

### MM-1: Structural hierarchy

- Root node: the central concept, title, or question
- Level 1 (branches): 3-7 primary categories or themes
- Level 2 (sub-branches): 2-5 items per branch
- Level 3 (leaves): detail items, 1-4 words each
- Maximum depth: 4 levels
- Minimum depth: 2 levels (flat mind maps are rejected as low-quality)

### MM-2: Balance

- No single branch should have more than 3x the items of the smallest branch
- If one branch dominates, split it into 2-3 sub-branches
- Leaf nodes should be roughly evenly distributed across branches

### MM-3: Naming

- Root: noun phrase or question (5 words max)
- Level 1: category nouns or gerund phrases
- Level 2-3: concise descriptive phrases
- No full sentences in any node

### MM-4: Shape usage

Mermaid mindmap supports shape hints:
- Root: default (rectangle)
- Level 1: `(rounded)` or `[square]`
- Level 2+: default or `))bang((` for emphasis

### MM-5: Content derivation

When generating a mind map from text:
- Extract all distinct concepts mentioned
- Group related concepts using semantic similarity
- Derive branch labels from the common theme of each group
- Order branches clockwise by importance or by the order they appear in the input

---

## 11. Software and system architecture excellence rules

### EXC-1: Component labeling

Every service or component node must show its primary responsibility. Unlabeled boxes are considered defects.

Good: `AUTH["Auth Service\nJWT validation • session management"]`
Bad: `AUTH["Auth"]`

### EXC-2: Data store classification

Every data store must indicate its storage pattern:

| Pattern | Label convention |
|---|---|
| Relational | `[(PostgreSQL\nuser accounts • transactions)]` |
| Key-value | `[(Redis\nsession cache • rate limits)]` |
| Document | `[(MongoDB\nproduct catalog)]` |
| Vector / search | `[(Pinecone\nsemantic search index)]` |
| Message queue | `[(Kafka\nevent stream)]` |
| Object storage | `[(S3\nfile uploads • artifacts)]` |

### EXC-3: External dependency distinction

External systems (third-party APIs, SaaS providers, cloud services) must be visually distinct:
- Use a different shape: `{{External API}}` (hexagon) or `([External Service])` (stadium)
- Or apply a dedicated classDef with a muted fill color
- Always label with the provider name, not a generic term

### EXC-4: Cross-cutting concern representation

Cross-cutting concerns (authentication, logging, tracing, rate limiting) must not clutter the primary flow. They are represented as:
- A dedicated subgraph at the diagram periphery
- Dashed edges connecting to relevant components
- Or a single aggregation node (e.g., "Observability Pipeline") with a comment listing what it covers

### EXC-5: Protocol annotation

When components communicate over different protocols, label the edge:
- `-->|"gRPC"| TARGET`
- `-->|"REST / HTTPS"| TARGET`
- `-->|"WebSocket"| TARGET`
- `-->|"pub/sub"| TARGET`
- `-->|"SQL"| TARGET`

Only label when the protocol is non-obvious or when multiple protocols exist in the same diagram.

### EXC-6: Failure path completeness

Production-grade architecture diagrams must show:
- At least one error/failure path for critical flows
- Dead-letter or fallback mechanisms for async operations
- Circuit breaker or timeout patterns for synchronous dependencies

These are modeled as dedicated edges with descriptive labels, not hidden in comments.

---

## 12. Stress-test framework

15 architecture categories with reference prompts. Each test defines the input, expected diagram type, minimum structural requirements, and complexity indicators.

### ST-1: Layered software architecture

**Prompt:** "Design a 3-tier e-commerce platform with a React frontend, Node.js API layer with authentication and product services, and PostgreSQL + Redis backends."

**Expected:** flowchart TB, 3 subgraphs (presentation/logic/data), 8-12 nodes, protocol labels on cross-layer edges.

### ST-2: Distributed microservices

**Prompt:** "Show a microservices architecture with an API gateway, user service, order service, payment service, notification service, a shared message broker, and individual databases per service."

**Expected:** flowchart TB, 4+ subgraphs (gateway/services/data/messaging), 12-18 nodes, service-to-database edges, inter-service async edges through broker.

### ST-3: Event-driven system

**Prompt:** "Design an event-driven order processing system where order creation emits events consumed by inventory, payment, shipping, and notification services. Include dead-letter queues and a schema registry."

**Expected:** flowchart LR or TB, producer/broker/consumer/failure subgraphs, 10-16 nodes, DLQ paths shown, schema registry as dashed dependency.

### ST-4: Workflow automation

**Prompt:** "Model a CI/CD pipeline: code push triggers build, then parallel unit tests and lint, then integration tests, then security scan, then staging deploy, then manual approval, then production deploy with canary rollout."

**Expected:** flowchart LR, 10-14 nodes, fork/join for parallel stage, decision node for approval, rollback path.

### ST-5: Protocol and verification flow

**Prompt:** "Show the OAuth 2.0 authorization code flow between a browser, client app, authorization server, and resource server. Include token exchange, validation, and refresh."

**Expected:** sequenceDiagram, 4 participants, 8-12 interactions, alt block for token refresh, return arrows for responses.

### ST-6: Stateful runtime system

**Prompt:** "Model the lifecycle of a Kubernetes pod: Pending, ContainerCreating, Running, Succeeded, Failed, with transitions for scheduling, pulling images, health checks, OOM kill, and graceful shutdown."

**Expected:** stateDiagram-v2, 5-7 states, 8+ transitions with labeled triggers, start and end states, fork for success/failure.

### ST-7: Async system with retry and DLQ

**Prompt:** "Design a payment processing queue system: payment requests enter a queue, workers process them with up to 3 retries, exponential backoff, and failed payments go to a dead-letter queue for manual review."

**Expected:** flowchart LR, 6-10 nodes, retry loop, DLQ branch, counter/backoff annotation.

### ST-8: Deployment topology

**Prompt:** "Show a multi-region AWS deployment: us-east-1 and eu-west-1, each with an ALB, ECS cluster running 3 services, RDS with read replica, ElastiCache, and a global CloudFront CDN with Route53 DNS."

**Expected:** flowchart TB, region subgraphs with internal AZ or service subgraphs, 15-25 nodes, cross-region replication edges.

### ST-9: Data pipeline (ETL)

**Prompt:** "Design a data pipeline: ingest from Kafka, PostgreSQL CDC, and S3 uploads into a Spark processing layer, then load into a Snowflake warehouse and an Elasticsearch index, with Airflow orchestration and monitoring via Datadog."

**Expected:** flowchart LR, ingest/process/load/monitor subgraphs, 12-16 nodes, labeled source types on ingest edges.

### ST-10: Security boundary diagram

**Prompt:** "Show a zero-trust network architecture with an external zone (CDN, WAF), DMZ (API gateway, reverse proxy), internal zone (services, databases), and privileged zone (secrets vault, HSM, audit logs). Show trust boundaries and authentication points."

**Expected:** flowchart TB, 4 boundary subgraphs, 12-18 nodes, dashed edges for auth/policy flows, clear boundary labels.

### ST-11: Large mind map

**Prompt:** "Create a mind map for cloud-native application development covering: containerization, orchestration, service mesh, observability, CI/CD, security, storage, and networking. Each branch should have 3-5 sub-topics."

**Expected:** mindmap, 1 root + 8 branches + 24-40 leaves, balanced branch sizes, 3-level depth.

### ST-12: Multi-actor product flow

**Prompt:** "Model the user journey for an e-commerce checkout: customer browses, adds to cart, logs in or registers, enters shipping info, selects payment method, reviews order, places order, receives confirmation email, and can track delivery."

**Expected:** journey or flowchart LR, 9-12 steps, decision nodes for login vs register and payment method selection, parallel path for email notification.

### ST-13: Hybrid structural + temporal

**Prompt:** "Show a real-time trading system architecture with the order matching engine at the center, market data feeds coming in, order validation, the matching algorithm, trade execution, settlement, and risk checking. Show both the component architecture and the order lifecycle flow."

**Expected:** flowchart TB with temporal annotations on edges, 12-18 nodes, risk check as a dashed overlay, lifecycle stages as labeled edge sequence.

### ST-14: Infrastructure-as-code topology

**Prompt:** "Design a Terraform-managed infrastructure: VPC with public and private subnets, NAT gateway, bastion host, EKS cluster with node groups, RDS in private subnet, S3 for state backend, and CloudWatch for monitoring."

**Expected:** flowchart TB, VPC subgraph with subnet subgraphs inside, 12-18 nodes, network flow edges, clear public/private boundary.

### ST-15: Agent orchestration system

**Prompt:** "Design a multi-agent AI system with a planner agent, research agent, code writer agent, reviewer agent, and deployment agent. The planner breaks tasks into subtasks, assigns them to specialist agents, collects results, and synthesizes a final output. Include a shared memory store and tool registry."

**Expected:** flowchart TB, 10-15 nodes, planner as central orchestrator, dashed edges to shared memory, tool registry as a peripheral node, fan-out/fan-in pattern.

---

## 13. Validation framework

### Structural validation (automated)

| Check | Rule | Severity |
|---|---|---|
| Directive presence | First non-comment line matches a known Mermaid directive | Error |
| Bracket balance | Every `[` has `]`, `(` has `)`, `{` has `}` within node definitions | Error |
| Subgraph balance | Every `subgraph` has a matching `end` | Error |
| Unique IDs | No duplicate node IDs in the entire diagram | Error |
| Reserved word avoidance | No node ID is a Mermaid reserved word | Error |
| Label quoting | Labels with special characters are properly quoted | Warning |
| Edge syntax | All edges use valid Mermaid edge operators | Error |

### Semantic validation (automated where possible)

| Check | Rule | Severity |
|---|---|---|
| Entity preservation | Every entity named in the user input appears as a node | Error |
| Relationship preservation | Every relationship described in the user input appears as an edge | Warning |
| Direction preservation | Edge direction matches the described flow direction | Error |
| No orphan nodes | Every node has at least one connected edge (except legend nodes) | Warning |
| No island subgraphs | Every subgraph has at least one edge connecting to nodes outside it | Warning |

### Readability validation (heuristic)

| Check | Rule | Severity |
|---|---|---|
| Node count | Total nodes per diagram <= 80 | Warning (>80), Error (>120) |
| Nodes per subgraph | 3-10 nodes per subgraph | Warning if outside range |
| Edge density | Edge-to-node ratio <= 2.5 | Warning |
| Label length | Node labels <= 3 lines, edge labels <= 6 words | Warning |
| Nesting depth | Subgraph nesting <= 3 levels | Error |
| Label content | No node has an empty or single-character label | Warning |

### Compilation validation (mandatory)

| Check | Rule | Severity |
|---|---|---|
| mmdc success | Output compiles without error via `@mermaid-js/mermaid-cli` | Error |
| SVG validity | SVG viewBox has positive dimensions, no `-Infinity` or `NaN` | Error |
| SVG content | SVG contains >= 3 rendering primitives (rect, path, text, etc.) | Error |
| PNG validity | PNG file > 2KB with valid magic bytes and IDAT chunk | Error |

---

## 14. Extreme complexity test cases

### XC-1: Full enterprise platform (50+ nodes)

**Input prompt:**

"Design the complete architecture for an enterprise AI coding assistant platform. Include: multi-channel user access (web, IDE plugin, Slack), enterprise SSO with MFA, API gateway with WAF and DLP, an agent orchestrator with planning and tool routing, a policy engine with OPA, a model gateway routing to multiple LLM providers, per-tenant isolated workspaces with cloud IDE and execution sandbox, a RAG memory system with vector store and document store, a CI/CD pipeline with security scanning and artifact signing, and a full observability stack with OpenTelemetry, SIEM, and cost analytics. Show governance overlays and a legend."

**Expected structure:**
- 8 subgraphs (user, security, control, data, execution, model providers, delivery, observability)
- 40-55 nodes
- 50-70 edges (mix of solid and dashed)
- classDef per layer
- Legend subgraph
- Cross-layer governance as dashed overlay

This is the reference complexity ceiling. The system must produce a readable, layered diagram at this scale.

### XC-2: Distributed event-sourced system (35+ nodes)

**Input prompt:**

"Design an event-sourced e-commerce system with: order aggregate, payment aggregate, inventory aggregate, shipping aggregate. Each aggregate has a command handler, event store, and read model projector. Events flow through a central event bus. Include saga orchestration for the order fulfillment workflow, compensating transactions for failures, and a CQRS query API. Show the event replay mechanism and snapshot store."

**Expected structure:**
- 4 aggregate subgraphs, each with 3 internal nodes
- Central event bus with fan-out edges
- Saga orchestrator subgraph with compensating transaction paths
- CQRS query path as a separate subgraph
- 35-45 nodes, flowchart TB

### XC-3: Multi-region Kubernetes deployment (30+ nodes)

**Input prompt:**

"Show a multi-region Kubernetes deployment across 3 regions (US, EU, APAC). Each region has: a K8s cluster with 3 node pools (general, GPU, spot), an Istio service mesh, Prometheus + Grafana for monitoring, and a regional PostgreSQL with streaming replication to a global read replica. A global load balancer distributes traffic. Cert-manager handles TLS across all regions. ArgoCD manages GitOps deployment from a central repo."

**Expected structure:**
- 3 region subgraphs with identical internal structure
- Global services subgraph (LB, cert-manager, ArgoCD, central repo)
- 30-40 nodes
- Cross-region replication edges
- flowchart TB

### XC-4: Complex state machine (20+ states)

**Input prompt:**

"Model the state machine for a financial transaction: Initiated, Pending Validation, Validated, Risk Check (with sub-states: Low Risk, Medium Risk requiring manual review, High Risk auto-reject), Approved, Processing, Clearing, Settled, Disputed (with sub-states: Under Review, Escalated, Resolved), Refunded, Cancelled, Failed. Include timeout transitions, retry from Processing, and audit logging at every state change."

**Expected structure:**
- stateDiagram-v2
- 12+ top-level states
- 2 composite states (Risk Check, Disputed) with internal sub-states
- 20+ transitions including timeout, retry, and error paths
- Start and end states

### XC-5: Full-stack development workflow (25+ steps)

**Input prompt:**

"Model the complete development workflow: developer creates a feature branch, writes code, runs local tests, pushes to remote, CI runs build and unit tests in parallel, then integration tests, then SAST and DAST security scans, code review with at least 2 approvals, merge to main triggers staging deploy, automated smoke tests, manual QA sign-off, production deploy with canary at 5% then 25% then 100%, post-deploy monitoring for 30 minutes, and rollback path at any deployment stage. Include notifications to Slack at key transitions."

**Expected structure:**
- flowchart LR (pipeline orientation) or flowchart TB
- 20-28 nodes
- Fork/join for parallel CI steps
- Decision nodes for review approval and canary promotion
- Rollback paths as dashed return edges
- Slack notification as dashed side-edges

---

## 15. gpt-oss extension fine-tuning strategy

### Prompt injection by stage

Each pipeline stage (text_to_md, md_to_mmd, validate_mmd, repair) receives a tailored system prompt built from this axiom framework.

| Stage | Injected axiom sections | Temperature | Max tokens |
|---|---|---|---|
| `text_to_md` | Sections 2 (interpretation), 7 (diagram selection), 9 (decomposition), 10 (mind maps) | 0.0 | 4096 |
| `md_to_mmd` | Sections 3 (Mermaid syntax), 4 (AAD), 5 (temporal), 6 (complexity), 11 (excellence) | 0.0 | 8192 |
| `validate_mmd` | Sections 3 (Mermaid syntax), 6 (complexity), 8 (meaning preservation) | 0.0 | 4096 |
| `repair` | Sections 2 (interpretation), 3 (Mermaid syntax), 8 (meaning preservation) | 0.0 | 4096 |

### System prompt structure

```
[ROLE]
You are a Mermaid diagram generation engine. You produce syntactically valid,
architecturally correct, readable Mermaid source code.

[AXIOMS]
{injected axiom text from relevant sections}

[TASK]
{stage-specific instruction}

[INPUT]
{user content}

[OUTPUT FORMAT]
Return ONLY the Mermaid source code. No explanation, no markdown fencing,
no commentary outside of Mermaid %% comments. The first line must be a
valid Mermaid directive.
```

### Temperature and sampling

All stages use temperature 0.0. The enhancer must be deterministic: identical input produces identical output. No sampling variability.

If the underlying model supports structured output or JSON mode, use it to enforce the output schema (a single string field containing the Mermaid source).

### Evaluation metrics

| Metric | Target | How measured |
|---|---|---|
| Compilation success rate | 100% | Run mmdc on every output; binary pass/fail |
| Entity preservation rate | >= 95% | Extract entity names from input; check presence as nodes in output |
| Structural validity | 100% | Automated structural validation (section 13) |
| Readability score | >= 80% pass rate | Heuristic checks from section 13 readability rules |
| Diagram type accuracy | >= 90% | Compare selected type against human-labeled ground truth for stress tests |
| Latency p95 | < 8 seconds | End-to-end from API call to compiled output |

### Continuous evaluation

- Run the 15 stress-test prompts (section 12) as a regression suite after every model or prompt change
- Run the 5 extreme complexity cases (section 14) as a soak test
- Log every enhancer call with input hash, output hash, stage, and metrics for drift detection
- Flag any output that fails compilation for immediate review

---

## 16. Acceptance criteria for expert-grade Mermaid applicability

### Quantitative thresholds

| Criterion | Threshold | Measurement |
|---|---|---|
| AC-1: Compilation success | 100% on all 20 test cases (15 stress + 5 extreme) | mmdc exit code 0 + valid SVG |
| AC-2: Entity preservation | >= 95% aggregate across all test cases | NLP entity extraction comparison |
| AC-3: Structural validity | Zero defects on all automated structural checks | Bracket balance, directive, subgraph pairing, unique IDs |
| AC-4: Readability compliance | >= 80% of diagrams pass all readability heuristics | Node count, edge density, label length, nesting depth |
| AC-5: Diagram type accuracy | >= 90% agreement with human judgment | Labeled test set |
| AC-6: Complexity ceiling | XC-1 (50+ node enterprise platform) renders cleanly | Visual inspection + no rendering artifacts |
| AC-7: Temporal correctness | Sequence and state diagrams correctly model described flow direction | Manual review of ST-5, ST-6, XC-4 |
| AC-8: Mind map quality | ST-11 produces balanced, 3-level mind map with 30+ nodes | Structural analysis |
| AC-9: Meaning conservation | Zero hallucinated entities across all test cases | Diff input entities vs output nodes |
| AC-10: Latency budget | p95 < 8 seconds for standard cases, p95 < 15 seconds for extreme cases | Timing instrumentation |

### Qualitative bar

The output for every test case should be indistinguishable from what a senior systems architect would produce by hand given the same brief. Specifically:

- Appropriate use of subgraphs to represent boundaries
- Consistent and intentional edge styling (solid vs dashed)
- Labels that are informative without being verbose
- Layout that reads naturally in the chosen direction (TB or LR)
- No orphan nodes, no island subgraphs, no crossing edges that could be avoided
- Comments explaining non-obvious design choices

### Definition of done

The system achieves expert-grade Mermaid applicability when:
1. All 20 test cases pass AC-1 through AC-3 (hard requirements)
2. At least 16 of 20 test cases pass AC-4 and AC-5 (soft requirements)
3. XC-1 passes AC-6 (complexity ceiling)
4. Manual review of 5 randomly selected outputs confirms the qualitative bar
5. The axiom framework document is complete, reviewed, and referenced by the gpt-oss prompt templates
