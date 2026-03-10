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
};
