'use strict';

/**
 * Axiom-aware prompt templates for the gpt-oss Mermaid enhancer.
 *
 * Each stage receives a tailored system prompt built from the axiom framework
 * (archs/mermaid-axioms.md). Temperature 0.0 for determinism.
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
      task = `TASK: Convert the user's natural-language description into a structured markdown specification. Include a title heading, brief description, and a fenced \`\`\`mermaid block containing valid Mermaid source. Choose the diagram type using the selection rules. Extract all entities and relationships from the text.`;
      break;

    case 'md_to_mmd':
      axioms = [AXIOMS_MERMAID_SYNTAX, AXIOMS_AAD, AXIOMS_TEMPORAL, AXIOMS_COMPLEXITY, AXIOMS_EXCELLENCE].join('\n');
      task = `TASK: Convert the markdown specification into clean, compilable Mermaid source. Extract and consolidate all diagram content. Apply AAD-style architectural treatment when appropriate. Normalize node IDs, labels, edge syntax. Ensure subgraph structure, classDef styling, and layout direction are correct.`;
      break;

    case 'validate_mmd':
      axioms = [AXIOMS_MERMAID_SYNTAX, AXIOMS_COMPLEXITY, AXIOMS_PRESERVATION].join('\n');
      task = `TASK: Validate and normalize the Mermaid source. Fix syntax issues (unclosed brackets, duplicate IDs, reserved-word IDs). Normalize indentation and whitespace. Standardize label quoting. Do NOT restructure or rename correct content. Return unchanged if already clean.`;
      break;

    case 'repair':
      axioms = [AXIOMS_INTERPRETATION, AXIOMS_MERMAID_SYNTAX, AXIOMS_PRESERVATION].join('\n');
      task = `TASK: Repair the malformed or mixed input into valid Mermaid source. Separate prose from diagram syntax. Reconstruct the diagram from all available signals. Add a valid directive if missing. Fix structural defects. Preserve all user-mentioned entities and relationships.`;
      break;

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
    `- If confidence is low (ambiguous context, very short input), respond with exactly: {"suggestion":"","confidence":"low"}`,
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

module.exports = { buildPrompt, getAxiomSection, buildCopilotSuggestPrompt, buildCopilotEnhancePrompt };
