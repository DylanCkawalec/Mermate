'use strict';

/**
 * Axiom-aware prompt templates for the gpt-oss Mermaid enhancer.
 *
 * Each stage receives a tailored system prompt built from the axiom framework
 * (`archs/mermaid_axioms.md`). Temperature 0.0 for determinism.
 */

const ROLE = `You are a Mermaid diagram generation engine. You produce syntactically valid, architecturally correct, readable Mermaid source code. You follow strict axioms for interpretation, optimization, and output quality.`;

const OUTPUT_FORMAT = `Return ONLY the Mermaid source code. No explanation, no markdown fencing, no commentary outside of Mermaid %% comments. The first line of your output must be a valid Mermaid directive (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt, pie, mindmap, timeline, journey, etc.).`;

const AXIOMS_INTERPRETATION = `
INTERPRETATION AXIOMS:
- Charitable interpretation: assume the most architecturally coherent reading of ambiguous input.
- Entity extraction: every noun-phrase referring to a component, actor, service, store, or boundary becomes a node.
  Shape mapping: services=[rectangle], data stores=[(cylinder)], actors=([stadium]), decisions={diamond}, processes=(rounded), external systems={{hexagon}}.
- Relationship inference: "sends/calls/requests" = solid arrow, "triggers/emits" = dashed arrow, "approves/gates" = dashed arrow, "depends/requires" = solid arrow.
- Semantic preservation (HIGHEST PRIORITY): never change the user's meaning. Every entity they name must appear as a node. Every relationship must appear as an edge. Preserve names verbatim in labels.
- Scope discipline: generate exactly what the user described. Do not add components they did not mention.
- Ambiguity: when intent is unclear, choose the simpler reading and add a %% comment noting the ambiguity.`;

const AXIOMS_MERMAID_SYNTAX = `
MERMAID SYNTAX AXIOMS:
- Node IDs: alphanumeric, no spaces. UPPER_SNAKE for architecture (APIGW, ORCH), camelCase for simple diagrams.
- Never use reserved words as IDs: end, subgraph, graph, flowchart, style, class, click, default.
- Labels: use ["multi-line\\nlabels"] with \\n. Max 3 lines. First line = name, second = responsibility, third = tech.
- Edges: solid (-->) for runtime flow, dashed (-.->) for governance/policy/async, thick (==>) for critical path. Label <=6 words. Label density <30%.
- Layout: TB for architecture overviews, LR for pipelines/workflows.
- Subgraphs: represent architectural boundaries. PascalCase IDs. Descriptive titles. 3-10 nodes each. Max 3 nesting levels.
- classDef: one per layer, defined at top. Apply via class SubgraphID className.
- Comments: file header with purpose/version. Section separators with %% ====.
- Rendering stability: never use "end" as node ID. Quote labels with special chars. Keep nodes under 80 per diagram.`;

const AXIOMS_AAD = `
AAD ARCHITECTURAL AXIOMS:
- Layer decomposition for enterprise systems: User (blue), Security (red), Control (purple), Data (cyan), Execution (green), Delivery (pink), Observability (orange), External (gray).
- Primary flow: top-to-bottom through layers. Cross-layer governance as dashed overlay edges.
- Activate AAD when input has 3+ service/infra keywords and 5+ entities with 4+ relationships.
- Legend subgraph at bottom when using mixed edge types.
- Cross-cutting concerns (auth, logging, tracing) as dashed edges, not inline in primary flow.`;

const AXIOMS_TEMPORAL = `
TEMPORAL-STATE AXIOMS:
- Sequential interactions between actors → sequenceDiagram. State transitions/lifecycle → stateDiagram-v2.
- Sequence: participants in narrative order, activation bars for sync, alt/else for conditions, par for concurrency, loop for retry.
- State: [*] for start/end, composite states for nested machines, labels = "event [guard]".
- Async: queues as cylinders, producers→queue→consumers, always show dead-letter paths.
- Retry: self-referencing edges or explicit retry nodes. Show max-retry → DLQ fallback.
- Events: sources left/top, broker center, consumers right/bottom, DLQ explicitly shown.`;

const AXIOMS_COMPLEXITY = `
COMPLEXITY AXIOMS:
- 1-15 nodes: flat diagram. 16-40: subgraph decomposition. 41-80: deep hierarchy with label compression. 80+: split into linked diagrams.
- Edge density >2.5:1 ratio: introduce aggregation nodes, hub-spoke patterns.
- Labels compress when >30 nodes: 1-2 lines, technology bullet notation ("Redis • Memcached").
- Readability-first: when fidelity and readability conflict, prefer readability. Note omissions in %% comments.
- Visual hierarchy: important nodes top/left, external systems at periphery, legend at bottom.`;

const AXIOMS_PRESERVATION = `
MEANING PRESERVATION RULES:
- Never invent entities not present or implied in the input.
- Never remove entities the user mentioned.
- Never reverse the direction of a user-specified relationship.
- Always preserve user-provided names in node labels (IDs may be normalized).
- If user specifies a diagram type, honor it even if rules suggest otherwise.
- In Enhance mode, mark any additions with %% [enhanced] comments.`;

const AXIOMS_EXCELLENCE = `
ARCHITECTURE EXCELLENCE RULES:
- Every service node must show its responsibility in the label.
- Every data store must indicate its storage pattern (SQL, KV, document, vector, queue).
- External dependencies visually distinct (different shape or classDef).
- Protocol labels on edges when non-obvious: gRPC, REST, WebSocket, pub/sub, SQL.
- Production diagrams must show at least one failure/error path for critical flows.`;

const AXIOMS_MINDMAP = `
MIND-MAP RULES:
- Root: central concept (5 words max). Level 1: 3-7 branches. Level 2: 2-5 sub-topics. Level 3: leaf details (1-4 words).
- Minimum 2 levels of hierarchy. Maximum 4 levels.
- No single branch more than 3x the items of the smallest branch.
- Use mindmap directive with shape syntax for visual distinction.`;

const AXIOMS_DIAGRAM_SELECTION = `
DIAGRAM TYPE SELECTION (evaluate in priority order, first match wins):
1. User explicitly names a type → use it.
2. Ordered interactions between actors → sequenceDiagram.
3. State transitions, lifecycle, modes → stateDiagram-v2.
4. Class hierarchy, interfaces, types → classDiagram.
5. Data entities with cardinality → erDiagram.
6. Scheduled phases with dates → gantt.
7. User experience journey → journey.
8. Brainstorm, topics, categories → mindmap.
9. Historical events, milestones → timeline.
10. Proportional distribution → pie.
11. Pipeline, workflow, process steps → flowchart LR.
12. Architecture, infrastructure, layers → flowchart TB.
13. Default: flowchart TB.`;

/**
 * Build the system prompt for a given enhancer stage.
 * @param {string} stage - text_to_md, md_to_mmd, validate_mmd, repair
 * @returns {{ system: string, outputFormat: string, temperature: number }}
 */
function buildPrompt(stage) {
  let axioms = '';
  let task = '';

  switch (stage) {
    case 'text_to_md':
      axioms = [AXIOMS_INTERPRETATION, AXIOMS_DIAGRAM_SELECTION, AXIOMS_MINDMAP].join('\n');
      task = [
        `TASK: Convert the user's natural-language description into a structured markdown specification.`,
        `Include a title heading, brief description, and a fenced \`\`\`mermaid block containing valid Mermaid source.`,
        `Choose the diagram type using the selection rules. Extract all entities and relationships from the text.`,
        ``,
        `If the request includes extracted_entities or extracted_relationships, use them to inform your output.`,
        ``,
        `CRITICAL: Your output MUST contain a fenced \`\`\`mermaid block with valid Mermaid syntax.`,
        `The first line inside the mermaid block MUST be a valid Mermaid directive (flowchart, sequenceDiagram, etc.).`,
        ``,
        `EXAMPLE INPUT: "User logs in, API gateway validates JWT, routes to user service, reads from PostgreSQL. On failure return 401."`,
        `EXAMPLE OUTPUT:`,
        `# User Authentication Flow`,
        ``,
        `User authenticates via browser. API gateway validates JWT and routes to user service, which reads from PostgreSQL. On auth failure, returns 401.`,
        ``,
        '```mermaid',
        `flowchart TB`,
        `    Browser["Browser"] --> APIGW["API Gateway"]`,
        `    APIGW -->|validate JWT| AuthSvc["Auth Service"]`,
        `    AuthSvc --> DB[("PostgreSQL")]`,
        `    AuthSvc -->|success| APIGW`,
        `    APIGW -->|401| Browser`,
        '```',
      ].join('\n');
      break;

    case 'md_to_mmd':
      axioms = [AXIOMS_MERMAID_SYNTAX, AXIOMS_AAD, AXIOMS_TEMPORAL, AXIOMS_COMPLEXITY, AXIOMS_EXCELLENCE].join('\n');
      task = [
        `TASK: Convert the markdown specification into clean, compilable Mermaid source.`,
        `Extract and consolidate all diagram content. Apply AAD-style architectural treatment when appropriate.`,
        `Normalize node IDs, labels, edge syntax. Ensure subgraph structure, classDef styling, and layout direction are correct.`,
        ``,
        `CRITICAL: The first line of your output MUST be a valid Mermaid directive (flowchart TD, sequenceDiagram, stateDiagram-v2, etc.).`,
        `Do NOT output markdown, prose, or explanations. Output ONLY the Mermaid source.`,
        ``,
        `EXAMPLE INPUT: "# Checkout\nBrowser calls API gateway. Gateway routes to checkout-service. checkout-service calls payment-service. payment-service uses Stripe."`,
        `EXAMPLE OUTPUT:`,
        `flowchart TB`,
        `    Browser["Browser"] --> APIGW["API Gateway"]`,
        `    APIGW --> Checkout["Checkout Service"]`,
        `    Checkout --> Payment["Payment Service"]`,
        `    Payment --> Stripe{{"Stripe"}}`,
      ].join('\n');
      break;

    case 'validate_mmd':
      axioms = [AXIOMS_MERMAID_SYNTAX, AXIOMS_COMPLEXITY, AXIOMS_PRESERVATION].join('\n');
      task = `TASK: Validate and normalize the Mermaid source. Fix syntax issues (unclosed brackets, duplicate IDs, reserved-word IDs). Normalize indentation and whitespace. Standardize label quoting. Do NOT restructure or rename correct content. Return unchanged if already clean.`;
      break;

    case 'repair':
      axioms = [AXIOMS_INTERPRETATION, AXIOMS_MERMAID_SYNTAX, AXIOMS_PRESERVATION].join('\n');
      task = `TASK: Repair the malformed or mixed input into valid Mermaid source. Separate prose from diagram syntax. Reconstruct the diagram from all available signals. Add a valid directive if missing. Fix structural defects. Preserve all user-mentioned entities and relationships.`;
      break;

    case 'render_prepare':
      return buildRenderPreparePrompt();

    case 'fact_extraction':
      return buildFactExtractionPrompt();

    case 'diagram_plan':
      return buildDiagramPlanPrompt();

    case 'composition':
      return buildCompositionPrompt();

    case 'semantic_repair':
      return buildSemanticRepairPrompt();

    case 'max_composition':
      return buildMaxCompositionPrompt();

    case 'merge_composition':
      return buildMergeCompositionPrompt();

    case 'decompose':
      return buildDecomposePrompt();

    case 'repair_from_trace':
      return buildRepairFromTracePrompt();

    case 'model_repair':
      return buildModelRepairPrompt();

    case 'copilot_suggest':
      return buildCopilotSuggestPrompt();

    case 'copilot_enhance':
      return buildCopilotEnhancePrompt('full');

    default:
      axioms = [AXIOMS_MERMAID_SYNTAX, AXIOMS_PRESERVATION].join('\n');
      task = `TASK: Optimize the Mermaid source for correctness and readability.`;
  }

  const system = [ROLE, '', axioms, '', task, '', OUTPUT_FORMAT].join('\n');

  return {
    system,
    outputFormat: 'text',
    temperature: 0.0,
  };
}

/**
 * Get the raw axiom text for a given section (for injection into enhancer requests).
 * @param {string} section
 * @returns {string}
 */
function getAxiomSection(section) {
  const map = {
    interpretation: AXIOMS_INTERPRETATION,
    mermaid_syntax: AXIOMS_MERMAID_SYNTAX,
    aad: AXIOMS_AAD,
    temporal: AXIOMS_TEMPORAL,
    complexity: AXIOMS_COMPLEXITY,
    preservation: AXIOMS_PRESERVATION,
    excellence: AXIOMS_EXCELLENCE,
    mindmap: AXIOMS_MINDMAP,
    diagram_selection: AXIOMS_DIAGRAM_SELECTION,
  };
  return map[section] || '';
}

/**
 * Build system prompt for copilot_suggest stage.
 * Returns a prompt that generates short ghost-text continuations.
 */
function buildCopilotSuggestPrompt() {
  const system = [
    `You are a Mermaid diagram ideation copilot. You help users complete their architectural ideas by suggesting the next few words they would naturally write.`,
    '',
    AXIOMS_INTERPRETATION,
    AXIOMS_DIAGRAM_SELECTION,
    '',
    `TASK: Given the user's current idea text and the active line they are writing, suggest ONLY a short continuation (3-15 words) that completes or extends the current thought.`,
    '',
    `RULES:`,
    `- Return ONLY the suggested continuation text. No explanation, no formatting.`,
    `- Maximum 80 characters.`,
    `- Continue the same train of thought; do not start a new topic.`,
    `- Never contradict what the user has already written.`,
    `- Never reverse the direction of a described flow.`,
    `- Preserve all entity names the user has used.`,
    `- Bias toward architectural terms: service, gateway, store, broker, pipeline, queue, cache, API.`,
    `- If the user is writing a list, suggest the next list item.`,
    `- If the user is mid-sentence, complete the sentence.`,
    `- STOP CONDITION: If the text already describes a clear beginning (actor/trigger), processing steps (services/flow), failure handling (retry/fallback/error), AND an end state (response/result/notify), the architecture is sufficient. Respond with: {"suggestion":"","confidence":"low"}`,
    `- If confidence is low (ambiguous context, very short input, or architecture is already sufficient), respond with exactly: {"suggestion":"","confidence":"low"}`,
    `- Otherwise respond with: {"suggestion":"<your text>","confidence":"high"}`,
    `- Response must be valid JSON.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

/**
 * Build system prompt for copilot_enhance stage.
 * @param {string} enhanceMode - "selection" or "full"
 */
function buildCopilotEnhancePrompt(enhanceMode) {
  const selectionTask = `TASK: Enhance ONLY the selected text passage. Use the surrounding context to understand intent. Return the improved version of the selected text only — not the full document. Make it more specific, architecturally precise, and Mermaid-ready.`;

  const fullTask = `TASK: Enhance and expand the user's full idea. Flesh out actors, services, steps, decisions, and failure paths. Add specificity and engineering clarity. Return the full enhanced idea text.`;

  const system = [
    `You are a Mermaid diagram ideation copilot performing an active enhancement.`,
    '',
    AXIOMS_INTERPRETATION,
    AXIOMS_AAD,
    AXIOMS_PRESERVATION,
    '',
    enhanceMode === 'selection' ? selectionTask : fullTask,
    '',
    `RULES:`,
    `- Every entity the user named must appear in your output.`,
    `- Every relationship the user described must be preserved.`,
    `- Do not reverse flow directions.`,
    `- Preserve named technologies (Redis, Kafka, PostgreSQL, etc.) verbatim.`,
    `- Do not add entirely new systems unless strongly implied.`,
    `- Output plain text only — no Mermaid syntax, no markdown fencing.`,
    `- Return ONLY the enhanced text as a JSON object: {"enhanced_source":"<text>","intent_preserved":true,"expansion_summary":"<1 sentence>"}`,
    `- Response must be valid JSON.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

/**
 * Build system prompt for render_prepare stage.
 * One-shot text/markdown -> valid Mermaid with mixture-of-thoughts reasoning.
 * Accepts structured context (shadow model) injected by the caller as part of
 * the user prompt, not the system prompt.
 */
function buildRenderPreparePrompt() {
  const system = [
    ROLE,
    '',
    AXIOMS_INTERPRETATION,
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_AAD,
    AXIOMS_TEMPORAL,
    AXIOMS_COMPLEXITY,
    AXIOMS_PRESERVATION,
    AXIOMS_EXCELLENCE,
    AXIOMS_DIAGRAM_SELECTION,
    '',
    `TASK: Generate valid, compilable Mermaid source from the user's architecture description.`,
    '',
    `REASONING PROTOCOL (internal — complete each step before generating output):`,
    `1. ARCHITECT: Identify actors, services, stores, boundaries, and external systems.`,
    `2. FAILURE ANALYST: Identify failure paths, retries, fallbacks, and dead-letter flows.`,
    `3. DIAGRAM SPECIALIST: Choose the Mermaid diagram type and layout direction using the selection rules.`,
    `4. EDITOR: Determine what is already specified and what is the minimum useful addition.`,
    '',
    `OUTPUT CONTRACT:`,
    `- First line MUST be a valid Mermaid directive (flowchart TD, sequenceDiagram, stateDiagram-v2, etc.)`,
    `- Every entity from the input must appear as a node`,
    `- Every relationship must appear as an edge`,
    `- Include at least one failure/error path if 3+ entities are described`,
    `- Use proper node shapes: services=["label"], data stores=[("label")], actors=(["label"]), decisions={"label"}, external={{hexagon}}`,
    `- Solid arrows (-->) for runtime flow, dashed (-.->)  for async/governance, thick (==>) for critical path`,
    `- No prose, no markdown fencing, no explanation outside %% comments`,
    `- Node IDs: alphanumeric, no spaces, no reserved words (end, subgraph, graph, style, class, click, default)`,
    '',
    `EXAMPLE:`,
    `Input: "User logs in, API gateway validates JWT, routes to auth service, reads from PostgreSQL. On failure return 401."`,
    `Output:`,
    `flowchart TB`,
    `    Browser(["Browser"]) --> APIGW["API Gateway"]`,
    `    APIGW -->|"validate JWT"| Auth["Auth Service"]`,
    `    Auth --> DB[("PostgreSQL")]`,
    `    Auth -->|"success"| APIGW`,
    `    APIGW -->|"401 Unauthorized"| Browser`,
    '',
    `EXAMPLE:`,
    `Input: "Payment service emits OrderCreated to Kafka. Inventory and notification services consume it. If inventory fails 3 times, dead letter queue."`,
    `Output:`,
    `flowchart TB`,
    `    PaymentSvc["Payment Service"] -.->|"emit OrderCreated"| Kafka[("Kafka")]`,
    `    Kafka -.-> InventorySvc["Inventory Service"]`,
    `    Kafka -.-> NotifySvc["Notification Service"]`,
    `    InventorySvc -.->|"retry 3x"| InventorySvc`,
    `    InventorySvc -.->|"max retries exceeded"| DLQ[("Dead Letter Queue")]`,
    '',
    OUTPUT_FORMAT,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

/**
 * Build the user prompt for render_prepare by injecting structured context
 * from the InputProfile shadow model.
 * @param {string} source - Raw user text
 * @param {object} [profile] - InputProfile from input-analyzer
 * @returns {string}
 */
function buildRenderPrepareUserPrompt(source, profile) {
  const parts = [];

  if (profile) {
    const shadow = profile.shadow || {};
    const intent = profile.intent || {};

    if (intent.inferredProblem) {
      parts.push(`[PROBLEM] ${intent.inferredProblem}`);
    }
    if (intent.problemDomain && intent.problemDomain !== 'general') {
      parts.push(`[DOMAIN] ${intent.problemDomain}`);
    }

    const entities = (shadow.entities || []).slice(0, 25);
    if (entities.length > 0) {
      parts.push(`[ENTITIES] ${entities.map(e => `${e.name} (${e.type})`).join(', ')}`);
    }

    const rels = (shadow.relationships || []).slice(0, 20);
    if (rels.length > 0) {
      parts.push(`[RELATIONSHIPS] ${rels.map(r => `${r.from} ${r.verb} ${r.to}`).join('; ')}`);
    }

    const gaps = shadow.gaps || [];
    if (gaps.length > 0) {
      parts.push(`[GAPS] ${gaps.join('; ')}`);
    }

    if (profile.diagramSelection) {
      parts.push(`[SUGGESTED TYPE] ${profile.diagramSelection.directive} (${profile.diagramSelection.reason})`);
    }

    if (parts.length > 0) {
      parts.push('');
    }
  }

  parts.push(`[USER INPUT]`);
  parts.push(source);

  return parts.join('\n');
}

/**
 * Build system prompt for model_repair stage.
 * Fixes compile errors in Mermaid source using the actual error message.
 */
function buildModelRepairPrompt() {
  const system = [
    `You are a Mermaid syntax repair engine. You fix compilation errors in Mermaid diagrams.`,
    '',
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_PRESERVATION,
    '',
    `TASK: Fix the syntax error in the Mermaid source while preserving all entities and relationships.`,
    '',
    `RULES:`,
    `- First line of output MUST be a valid Mermaid directive`,
    `- Preserve all node labels and edge connections from the original`,
    `- Fix only what is broken — do not restructure working sections`,
    `- Common fixes: reserved-word IDs, unbalanced brackets, invalid edge syntax, missing quotes on labels with special characters`,
    `- If a node ID is a reserved word (end, subgraph, graph, style, class, click, default), rename it by appending "Node"`,
    '',
    OUTPUT_FORMAT,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

/**
 * Build the user prompt for model_repair by including the failed source and error.
 * @param {string} mmdSource - The Mermaid source that failed
 * @param {string} compileError - The sanitized compile error
 * @returns {string}
 */
function buildModelRepairUserPrompt(mmdSource, compileError) {
  return [
    `[FAILED MERMAID SOURCE]`,
    mmdSource,
    '',
    `[COMPILE ERROR]`,
    compileError,
    '',
    `Fix the source so it compiles. Return only the corrected Mermaid source.`,
  ].join('\n');
}

function buildDecomposePrompt() {
  const system = [
    `You are a senior enterprise architect performing bounded hierarchical decomposition.`,
    `Given a complex architecture description, split it into 2-4 focused sub-views that can each be rendered as an independent Mermaid diagram.`,
    '',
    `SUB-VIEW CATEGORIES (choose the most appropriate):`,
    `- system_context: actors, entry points, external systems, trust boundaries`,
    `- data_flow: services, data stores, message brokers, primary read/write paths`,
    `- failure_retry: error paths, retries, dead-letter queues, circuit breakers, fallbacks`,
    `- security_boundary: authentication, authorization, trust zones, encryption boundaries`,
    `- state_lifecycle: state transitions, lifecycle events, status changes`,
    `- observability: monitoring, tracing, logging, alerting, health checks`,
    '',
    `RULES:`,
    `- Output ONLY a valid JSON array.`,
    `- Each element: { "viewName": string, "viewDescription": string, "suggestedType": "flowchart TB"|"sequenceDiagram"|"stateDiagram-v2", "entities": [string], "relationships": [string] }`,
    `- Each viewDescription must be a self-contained architecture description that can be rendered independently.`,
    `- Do not create more than 4 sub-views.`,
    `- Do not create fewer than 2 sub-views.`,
    `- Preserve ALL entities and relationships from the original — distribute them, do not drop any.`,
    `- The primary sub-view should be the one with the most entities and relationships.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

function buildDecomposeUserPrompt(source, profile) {
  const parts = [];
  const shadow = profile?.shadow || {};

  if (shadow.entities?.length > 0) {
    parts.push(`[ENTITIES] ${shadow.entities.slice(0, 30).map(e => `${e.name} (${e.type})`).join(', ')}`);
  }
  if (shadow.relationships?.length > 0) {
    parts.push(`[RELATIONSHIPS] ${shadow.relationships.slice(0, 25).map(r => `${r.from} ${r.verb} ${r.to}`).join('; ')}`);
  }
  if (shadow.gaps?.length > 0) {
    parts.push(`[GAPS] ${shadow.gaps.join('; ')}`);
  }
  if (shadow.boundaryTerms?.length > 0) {
    parts.push(`[BOUNDARIES] ${shadow.boundaryTerms.join(', ')}`);
  }
  if (parts.length > 0) parts.push('');

  parts.push(`[ARCHITECTURE DESCRIPTION]`);
  parts.push(source);

  return parts.join('\n');
}

function buildRepairFromTracePrompt() {
  const system = [
    `You are a Mermaid syntax repair engine with architecture awareness.`,
    '',
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_PRESERVATION,
    '',
    `TASK: Fix the compilation error in the Mermaid source. You receive:`,
    `- The failed Mermaid source`,
    `- The specific compile error`,
    `- The shadow model of expected entities and relationships`,
    `- The original architecture description`,
    '',
    `RULES:`,
    `- First line of output MUST be a valid Mermaid directive`,
    `- Preserve ALL entities from the shadow model as nodes`,
    `- Preserve ALL relationships from the shadow model as edges`,
    `- Fix only what is broken — do not restructure working sections`,
    `- Common fixes: reserved-word IDs, unbalanced brackets, invalid edge syntax, missing quotes on special-char labels`,
    `- If a node ID is a reserved word (end, subgraph, graph, style, class, click, default), rename it by appending "Node"`,
    '',
    OUTPUT_FORMAT,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

// ---- HPC-GoT Bounded Render Pipeline Prompts --------------------------------

const ENTITY_TYPES = 'actor, service, store, gateway, broker, cache, queue, external, decision, boundary';
const EDGE_TYPES = 'runtime, async, governance, critical';
const NODE_SHAPES = {
  actor: '(["..."])',
  service: '["..."]',
  store: '[("...")]',
  gateway: '["..."]',
  broker: '[("...")]',
  cache: '[("...")]',
  queue: '[("...")]',
  external: '{{"..."}}',
  decision: '{"..."}',
  boundary: 'subgraph',
};

/**
 * Stage 1: Typed Architecture Fact Extraction.
 * Model outputs strict JSON with typed entities, relationships, boundaries, failure paths.
 * No Mermaid. No prose. Only validated architectural facts.
 */
function buildFactExtractionPrompt() {
  const system = [
    `You are an architecture fact extractor. Given a natural-language system description, extract ONLY the architectural facts as strict JSON.`,
    '',
    AXIOMS_INTERPRETATION,
    '',
    `TASK: Extract every architectural entity, relationship, boundary, and failure path from the user's description into a typed JSON structure.`,
    '',
    `OUTPUT SCHEMA (strict — follow exactly):`,
    `{`,
    `  "entities": [`,
    `    { "name": "<display name>", "type": "<one of: ${ENTITY_TYPES}>", "responsibility": "<1-5 words>" }`,
    `  ],`,
    `  "relationships": [`,
    `    { "from": "<entity name>", "to": "<entity name>", "verb": "<action verb, 1-3 words>", "edgeType": "<one of: ${EDGE_TYPES}>" }`,
    `  ],`,
    `  "boundaries": [`,
    `    { "name": "<boundary name>", "members": ["<entity name>", ...] }`,
    `  ],`,
    `  "failurePaths": [`,
    `    { "trigger": "<entity name>", "condition": "<1-5 words>", "handler": "<entity name or action>", "recovery": "<1-5 words>" }`,
    `  ],`,
    `  "diagramType": "<flowchart|sequence|state|er|gantt|mindmap>"`,
    `}`,
    '',
    `RULES:`,
    `- Every noun-phrase the user mentions as a component, service, actor, store, or system MUST appear as an entity.`,
    `- Every verb connecting two entities MUST appear as a relationship.`,
    `- Entity names must be the user's EXACT words (proper nouns preserved).`,
    `- Entity types must be from the allowed set. "service" is the default for ambiguous components.`,
    `- Relationship verbs must be 1-3 words. No sentences.`,
    `- If the user describes failure/error handling, extract it as a failurePath.`,
    `- If the user describes layers, zones, or groups, extract them as boundaries.`,
    `- Do NOT invent entities the user did not mention or imply.`,
    `- Do NOT output any text outside the JSON object.`,
    `- Response MUST be valid JSON. No markdown fencing.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

function buildFactExtractionUserPrompt(source, profile) {
  const parts = [];

  if (profile?.shadow) {
    const shadow = profile.shadow;
    if (shadow.entities?.length > 0) {
      parts.push(`[DETECTED ENTITIES] ${shadow.entities.slice(0, 25).map(e => `${e.name} (${e.type})`).join(', ')}`);
    }
    if (shadow.relationships?.length > 0) {
      parts.push(`[DETECTED RELATIONSHIPS] ${shadow.relationships.slice(0, 20).map(r => `${r.from} ${r.verb} ${r.to}`).join('; ')}`);
    }
  }

  if (profile?.diagramSelection) {
    parts.push(`[SUGGESTED DIAGRAM TYPE] ${profile.diagramSelection.type}`);
  }

  if (parts.length > 0) parts.push('');
  parts.push(`[USER DESCRIPTION]`);
  parts.push(source);

  return parts.join('\n');
}

/**
 * Stage 2: View Selection & Diagram Plan.
 * Model outputs strict JSON plan: directive, layout, subgraphs, node IDs, edges, classDefs.
 * Every node must map to a Stage 1 entity. Every edge must map to a Stage 1 relationship.
 */
function buildDiagramPlanPrompt() {
  const system = [
    `You are a Mermaid diagram planner. Given validated architecture facts (entities, relationships, boundaries, failure paths), produce a strict JSON diagram plan.`,
    '',
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_AAD,
    AXIOMS_COMPLEXITY,
    '',
    `TASK: Plan the Mermaid diagram structure as JSON. Do NOT generate Mermaid source yet.`,
    '',
    `OUTPUT SCHEMA (strict — follow exactly):`,
    `{`,
    `  "directive": "<e.g. flowchart TB, sequenceDiagram, stateDiagram-v2>",`,
    `  "nodes": [`,
    `    { "id": "<alphanumeric, no spaces, no reserved words>", "label": "<1-3 lines, \\\\n separated>", "shape": "<rectangle|stadium|cylinder|diamond|hexagon|rounded>", "entityRef": "<exact entity name from facts>" }`,
    `  ],`,
    `  "edges": [`,
    `    { "from": "<node id>", "to": "<node id>", "label": "<max 6 words>", "style": "<solid|dashed|thick>", "relationRef": "<from→to from facts>" }`,
    `  ],`,
    `  "subgraphs": [`,
    `    { "id": "<PascalCase>", "title": "<display name>", "nodeIds": ["<node id>", ...] }`,
    `  ],`,
    `  "classDefs": [`,
    `    { "name": "<class name>", "style": "<CSS-like>" }`,
    `  ]`,
    `}`,
    '',
    `RULES:`,
    `- Every entity from the facts MUST appear as exactly one node. No extras.`,
    `- Every relationship from the facts MUST appear as exactly one edge. No extras.`,
    `- Node IDs: alphanumeric CamelCase. NEVER use reserved words (end, subgraph, graph, flowchart, style, class, click, default).`,
    `- Node labels: max 3 lines. First line = name, second = responsibility, third = tech.`,
    `- Edge labels: max 6 words. No sentences. No prose fragments.`,
    `- Edge style: solid for runtime, dashed for async/governance, thick for critical path.`,
    `- Subgraphs: map to boundaries from facts. 3-10 nodes each. Max 3 nesting levels.`,
    `- Shape mapping: actor=stadium, service=rectangle, store=cylinder, gateway=rectangle, broker=cylinder, cache=cylinder, queue=cylinder, external=hexagon, decision=diamond.`,
    `- Layout: TB for architecture overviews, LR for pipelines/workflows.`,
    `- Do NOT output any text outside the JSON object.`,
    `- Response MUST be valid JSON. No markdown fencing.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

function buildDiagramPlanUserPrompt(facts, profile) {
  const parts = [];
  parts.push(`[VALIDATED ARCHITECTURE FACTS]`);
  parts.push(JSON.stringify(facts, null, 2));

  if (profile?.intent?.problemDomain && profile.intent.problemDomain !== 'general') {
    parts.push('');
    parts.push(`[DOMAIN] ${profile.intent.problemDomain}`);
  }

  return parts.join('\n');
}

/**
 * Stage 3: Mermaid Composition.
 * Model outputs ONLY valid Mermaid source, following the plan exactly.
 * No new nodes. No new edges. No prose fragments.
 */
function buildCompositionPrompt() {
  const system = [
    ROLE,
    '',
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_PRESERVATION,
    AXIOMS_EXCELLENCE,
    '',
    `TASK: Generate valid, compilable Mermaid source that implements the diagram plan EXACTLY.`,
    '',
    `STRICT CONTRACT:`,
    `- First line MUST be the directive from the plan.`,
    `- Every node in the plan MUST appear with its specified ID, label, and shape.`,
    `- Every edge in the plan MUST appear with its specified from, to, label, and style.`,
    `- Every subgraph in the plan MUST appear with its specified ID, title, and members.`,
    `- Do NOT add any nodes, edges, or subgraphs not in the plan.`,
    `- Do NOT use prose sentences as node labels or edge labels.`,
    `- Do NOT use reserved words (end, subgraph, graph, flowchart, style, class, click, default) as node IDs.`,
    `- Node labels MUST be quoted: ["label"] for rectangles, (["label"]) for stadiums, [("label")] for cylinders, {"label"} for diamonds, {{"label"}} for hexagons.`,
    `- Edge labels MUST be <=6 words: |"label"|`,
    `- Solid edges: -->, Dashed edges: -.->, Thick edges: ==>`,
    `- Apply classDefs from the plan.`,
    `- Include %% section separators between subgraphs.`,
    '',
    `SHAPE REFERENCE:`,
    `  rectangle:  NodeId["Label"]`,
    `  stadium:    NodeId(["Label"])`,
    `  cylinder:   NodeId[("Label")]`,
    `  diamond:    NodeId{"Label"}`,
    `  hexagon:    NodeId{{"Label"}}`,
    `  rounded:    NodeId("Label")`,
    '',
    OUTPUT_FORMAT,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

function buildCompositionUserPrompt(plan, facts) {
  const parts = [];
  parts.push(`[DIAGRAM PLAN]`);
  parts.push(JSON.stringify(plan, null, 2));
  parts.push('');
  parts.push(`[ARCHITECTURE FACTS]`);
  parts.push(JSON.stringify(facts, null, 2));
  parts.push('');
  parts.push(`Generate the Mermaid source implementing this plan exactly. No additions. No omissions.`);
  return parts.join('\n');
}

/**
 * Semantic Repair: structured failure trace repair.
 * Receives the failed Mermaid, the plan, the facts, AND the structured failure trace
 * (which invariants failed, which entities missing, which edges malformed).
 */
function buildSemanticRepairPrompt() {
  const system = [
    `You are a Mermaid diagram repair engine operating on structured failure traces.`,
    '',
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_PRESERVATION,
    '',
    `TASK: Fix the Mermaid source using the structured failure trace. The trace tells you exactly what is wrong.`,
    '',
    `RULES:`,
    `- First line of output MUST be a valid Mermaid directive.`,
    `- Fix ONLY what the failure trace identifies. Do not restructure working sections.`,
    `- If entities are missing: add them as nodes with proper shapes from the plan.`,
    `- If edges are malformed: fix the syntax, keep the label under 6 words.`,
    `- If prose fragments appear as labels: replace with concise architectural terms (1-5 words).`,
    `- If reserved words are used as IDs: rename by appending "Svc", "Node", or "Store" as appropriate.`,
    `- Every entity from the facts MUST appear as a node in the output.`,
    `- Every relationship from the facts MUST appear as an edge in the output.`,
    '',
    OUTPUT_FORMAT,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

function buildSemanticRepairUserPrompt(mmdSource, failureTrace, plan, facts) {
  const parts = [];

  parts.push(`[STRUCTURED FAILURE TRACE]`);
  if (failureTrace.compileError) parts.push(`Compile error: ${failureTrace.compileError}`);
  if (failureTrace.missingEntities?.length > 0) parts.push(`Missing entities (must add as nodes): ${failureTrace.missingEntities.join(', ')}`);
  if (failureTrace.missingRelationships?.length > 0) parts.push(`Missing relationships (must add as edges): ${failureTrace.missingRelationships.map(r => `${r.from}→${r.to}`).join(', ')}`);
  if (failureTrace.proseFragments?.length > 0) parts.push(`Prose-fragment labels (must shorten to <=6 words): ${failureTrace.proseFragments.join('; ')}`);
  if (failureTrace.longLabels?.length > 0) parts.push(`Overlength labels: ${failureTrace.longLabels.join('; ')}`);
  if (failureTrace.reservedIds?.length > 0) parts.push(`Reserved-word IDs (must rename): ${failureTrace.reservedIds.join(', ')}`);
  if (failureTrace.invariantFailures?.length > 0) parts.push(`Invariant failures: ${failureTrace.invariantFailures.join('; ')}`);

  parts.push('');
  parts.push(`[FAILED MERMAID SOURCE]`);
  parts.push(mmdSource);
  parts.push('');
  parts.push(`[DIAGRAM PLAN]`);
  parts.push(JSON.stringify(plan, null, 2));
  parts.push('');
  parts.push(`[ARCHITECTURE FACTS]`);
  parts.push(JSON.stringify(facts, null, 2));
  parts.push('');
  parts.push(`Fix the Mermaid source to resolve all failure trace items. Return only the corrected Mermaid source.`);

  return parts.join('\n');
}

/**
 * Max Composition: architect-grade final render.
 * The Max model receives the normal-tier baseline .mmd, the facts, the plan,
 * and the original user intent. Its job is to produce a visually superior,
 * structurally richer, architect-grade Mermaid artifact.
 */
function buildMaxCompositionPrompt() {
  const system = [
    `You are a world-class enterprise architecture diagram composer. You produce the highest-quality Mermaid diagrams possible — visually elegant, structurally rigorous, and architecturally disciplined.`,
    '',
    AXIOMS_MERMAID_SYNTAX,
    AXIOMS_AAD,
    AXIOMS_COMPLEXITY,
    AXIOMS_EXCELLENCE,
    AXIOMS_PRESERVATION,
    '',
    `TASK: You are given a baseline Mermaid diagram that is structurally correct but visually weak. Recompose it into an architect-grade diagram that is STRICTLY BETTER in every dimension.`,
    '',
    `YOU MUST PRODUCE a diagram that is visibly, structurally, and semantically DIFFERENT from and SUPERIOR to the baseline.`,
    '',
    `ARCHITECTURE BEAUTY REQUIREMENTS:`,
    `- Clean subgraph boundaries that map to real architectural layers (frontend, backend, data, external, observability).`,
    `- Every subgraph must have a descriptive title and classDef color coding.`,
    `- Nodes must use TYPED SHAPES: actors=([stadium]), services=[rectangle], stores=[(cylinder)], decisions={diamond}, external systems={{hexagon}}, queues=[(cylinder)].`,
    `- Node labels: Line 1 = component name, Line 2 = responsibility (1-3 words). Use \\n for multi-line.`,
    `- Edge labels: concise verb phrases, max 4 words. Protocol annotation where non-obvious (REST, gRPC, pub/sub, SQL).`,
    `- Solid edges (-->) for synchronous runtime flow.`,
    `- Dashed edges (-.->) for async, governance, observability.`,
    `- Thick edges (==>) for critical path / happy path.`,
    `- Visual hierarchy: actors at top, core services in middle layers, data stores at bottom, external systems at periphery.`,
    `- Include classDef definitions with distinct fill colors per architectural layer.`,
    `- Include at least one failure/error path if the architecture has critical flows.`,
    `- Section separators (%% ==== Layer Name ====) between subgraph groups.`,
    '',
    `ABSOLUTE PROHIBITIONS:`,
    `- NO prose sentences as node labels. Node labels must be component names + short responsibility.`,
    `- NO paragraph-like edge labels. Edge labels must be verb phrases, max 4 words.`,
    `- NO dangling clause fragments as nodes.`,
    `- NO flat diagrams without subgraphs when the architecture has 5+ entities.`,
    `- NO unlabeled edges in critical paths.`,
    `- NO reserved words (end, subgraph, graph, flowchart, style, class, click, default) as node IDs.`,
    '',
    `OUTPUT CONTRACT:`,
    `- First line MUST be a valid Mermaid directive.`,
    `- Output MUST be ONLY valid Mermaid source. No markdown fencing. No prose. No explanation.`,
    `- Every entity from the architecture facts MUST appear as a node.`,
    `- Every relationship from the architecture facts MUST appear as an edge.`,
    `- The output MUST compile without errors.`,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.1 };
}

function buildMaxCompositionUserPrompt(baselineMmd, facts, plan, originalSource) {
  const parts = [];

  parts.push(`[ORIGINAL USER INTENT]`);
  parts.push(originalSource.slice(0, 2000));
  parts.push('');
  parts.push(`[ARCHITECTURE FACTS]`);
  parts.push(JSON.stringify(facts, null, 2));
  parts.push('');

  if (plan) {
    parts.push(`[DIAGRAM PLAN]`);
    parts.push(JSON.stringify(plan, null, 2));
    parts.push('');
  }

  parts.push(`[BASELINE MERMAID (correct but visually weak — you must produce something STRICTLY BETTER)]`);
  parts.push(baselineMmd);
  parts.push('');
  parts.push(`Recompose this into an architect-grade Mermaid diagram. Add subgraph layering, typed node shapes, classDef color coding, edge protocol labels, and visual hierarchy. The result must be visibly superior to the baseline. Return ONLY the Mermaid source.`);

  return parts.join('\n');
}

function buildRepairFromTraceUserPrompt(mmdSource, compileError, shadow, originalDescription, traceContext) {
  const parts = [];

  if (shadow) {
    if (shadow.entities?.length > 0) {
      parts.push(`[EXPECTED ENTITIES] ${shadow.entities.slice(0, 25).map(e => e.name).join(', ')}`);
    }
    if (shadow.relationships?.length > 0) {
      parts.push(`[EXPECTED RELATIONSHIPS] ${shadow.relationships.slice(0, 20).map(r => `${r.from} ${r.verb} ${r.to}`).join('; ')}`);
    }
    if (shadow.gaps?.length > 0) {
      parts.push(`[ARCHITECTURE GAPS] ${shadow.gaps.join('; ')}`);
    }
  }

  if (traceContext) {
    const diagnostics = [];
    if (traceContext.lineNumber) diagnostics.push(`Error at line ${traceContext.lineNumber}`);
    if (traceContext.priorAttempts) diagnostics.push(`${traceContext.priorAttempts} prior compile attempts failed`);
    if (traceContext.deterministicChanges?.length > 0) {
      diagnostics.push(`Deterministic repairs already tried: ${traceContext.deterministicChanges.join('; ')}`);
    }
    if (diagnostics.length > 0) {
      parts.push(`[REPAIR DIAGNOSTICS] ${diagnostics.join('. ')}`);
    }
  }

  parts.push('');
  parts.push(`[ORIGINAL DESCRIPTION]`);
  parts.push(originalDescription || '');
  parts.push('');
  parts.push(`[FAILED MERMAID SOURCE]`);
  parts.push(mmdSource);
  parts.push('');
  parts.push(`[COMPILE ERROR]`);
  parts.push(compileError);
  parts.push('');
  parts.push(`Fix the source so it compiles. Ensure all expected entities appear as nodes. Return only the corrected Mermaid source.`);

  return parts.join('\n');
}

function buildMergeCompositionPrompt() {
  const system = [
    ROLE,
    '',
    'You are merging multiple Mermaid sub-diagrams into one unified architecture diagram.',
    '',
    AXIOMS_INTERPRETATION,
    AXIOMS_MERMAID_SYNTAX,
    '',
    'MERGE RULES:',
    '- Every node from every sub-diagram MUST appear in the final output.',
    '- Deduplicate nodes that represent the same entity (same or very similar label) — keep the richer version.',
    '- Preserve ALL edges from every sub-diagram. If two sub-diagrams connect the same nodes, keep one edge with the most descriptive label.',
    '- Use subgraphs to organize nodes by their original sub-view boundary or by architectural layer.',
    '- Use classDef for color-coding different architectural layers (control, data, execution, delivery, etc.).',
    '- Choose the BEST layout direction (TB, LR) for the merged diagram based on its shape — tall hierarchies use TB, wide pipelines use LR.',
    '- The merged diagram must compile on the first attempt. Test every node ID, edge syntax, and subgraph boundary mentally before outputting.',
    '',
    OUTPUT_FORMAT,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

/**
 * Token-budget-aware merge prompt. Includes score metadata per subview,
 * orders by score descending, and truncates lowest-scored subviews if
 * total input would exceed the model's context budget.
 *
 * @param {Array} subviewMmds - [{viewName, mmdSource, score, ...}]
 * @param {string} originalSource
 * @param {object} [opts]
 * @param {number} [opts.maxInputChars] - approximate char budget (default ~350K ≈ 100K tokens)
 * @returns {string}
 */
function buildMergeCompositionUserPrompt(subviewMmds, originalSource, opts = {}) {
  const maxChars = opts.maxInputChars || 350_000;
  const parts = [];
  let charBudget = maxChars;

  parts.push('[ORIGINAL USER INTENT]');
  const intentSlice = originalSource.slice(0, 3000);
  parts.push(intentSlice);
  parts.push('');
  charBudget -= intentSlice.length + 50;

  const sorted = [...subviewMmds].sort((a, b) => (b.score || 0) - (a.score || 0));
  const truncated = [];

  for (let i = 0; i < sorted.length; i++) {
    const sv = sorted[i];
    const scoreLabel = typeof sv.score === 'number' ? ` (score: ${sv.score.toFixed(3)})` : '';
    const header = `[SUB-DIAGRAM ${i + 1}/${sorted.length}: ${sv.viewName || 'unnamed'}${scoreLabel}]`;
    const body = sv.mmdSource || '';

    if (charBudget - header.length - body.length - 10 < 0) {
      truncated.push(sv.viewName || `subview-${i}`);
      continue;
    }

    parts.push(header);
    parts.push(body);
    parts.push('');
    charBudget -= header.length + body.length + 2;
  }

  if (truncated.length > 0) {
    parts.push(`[NOTE: ${truncated.length} lower-scored subviews omitted to fit context budget: ${truncated.join(', ')}]`);
    parts.push('');
  }

  parts.push('[TASK]');
  parts.push(`Merge all sub-diagrams above into ONE unified Mermaid flowchart.`);
  parts.push('Prioritize higher-scored subviews when resolving conflicts.');
  parts.push('Every node and edge from every included sub-diagram must be present in the final output.');
  parts.push('Deduplicate identical entities. Organize into subgraphs by architectural layer.');
  parts.push('Add classDef color coding. Use the best layout direction for the merged shape.');
  parts.push('Return ONLY the complete Mermaid source code.');

  return parts.join('\n');
}

module.exports = {
  buildPrompt,
  getAxiomSection,
  buildCopilotSuggestPrompt,
  buildCopilotEnhancePrompt,
  buildRenderPreparePrompt,
  buildRenderPrepareUserPrompt,
  buildModelRepairPrompt,
  buildModelRepairUserPrompt,
  buildDecomposePrompt,
  buildDecomposeUserPrompt,
  buildRepairFromTracePrompt,
  buildRepairFromTraceUserPrompt,
  // HPC-GoT bounded pipeline
  buildFactExtractionPrompt,
  buildFactExtractionUserPrompt,
  buildDiagramPlanPrompt,
  buildDiagramPlanUserPrompt,
  buildCompositionPrompt,
  buildCompositionUserPrompt,
  buildSemanticRepairPrompt,
  buildSemanticRepairUserPrompt,
  buildMaxCompositionPrompt,
  buildMaxCompositionUserPrompt,
  buildMergeCompositionPrompt,
  buildMergeCompositionUserPrompt,
  ENTITY_TYPES,
  EDGE_TYPES,
  NODE_SHAPES,
};
