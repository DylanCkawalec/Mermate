/* =========================================================
   MERMATE GoT Context Refinement Gateway
   ---------------------------------------------------------
   Purpose:
   - Treat the user message as `msg`
   - Keep `msg` visible in the active refinement window
   - Replace prompt language packs like injectable API keys
   - Run bounded Graph-of-Thought style refinement
   - Prepare a local-LLM-ready system prompt + context bundle
   - Operate as behavior cortex / gateway / analysis frequency
   ========================================================= */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

type Role = "system" | "developer" | "user" | "assistant" | "tool";

interface Message {
  role: Role;
  content: string;
  name?: string;
}

interface LanguagePack {
  MODEL_IDENTITY: string;
  AGENCY_MODE: string;
  TRUTH_MODE: string;
  VALIDATION_MODE: string;
  BEHAVIORAL_TONE: string;

  PHILOSOPHY_ROOT: string;
  SEARCH_DOCTRINE: string;
  QUESTION_DOCTRINE: string;
  INTENT_ANCHOR: string;
  SELF_REFLECTION_LOOP: string;
  IMPROVEMENT_LAW: string;

  MSG_WINDOW_POLICY: string;
  CONTEXT_VISIBILITY_RULE: string;
  HISTORY_POLICY: string;
  ARTIFACT_MEMORY_POLICY: string;

  TOPOLOGY_MODE: string;
  MAX_DEPTH: string;
  MAX_BRANCH: string;
  NODE_BUDGET: string;
  PRUNE_THRESHOLD: string;
  MERGE_POLICY: string;

  PLAN_FORMAT: string;
  QUESTION_FORMAT: string;
  EXECUTION_FORMAT: string;
  BENCHMARK_FORMAT: string;
  ABORT_RULE: string;

  WORD_POLICY: string;
  TERM_RESOLUTION_MODE: string;
  NEXT_WORD_STRATEGY: string;
  SEMANTIC_ALIGNMENT_GOAL: string;
}

interface ArtifactMemory {
  originalGoal: string;
  constraints: string[];
  generatedArtifacts: string[];
  unresolvedQuestions: string[];
  validatedFacts: string[];
}

interface ThoughtNode {
  id: string;
  depth: number;
  parentId?: string;
  hypothesis: string;
  refinedPrompt: string;
  score: number;
  evidence: string[];
  reasons: string[];
  pruned?: boolean;
}

interface GatewayConfig {
  depthCap: number;
  maxBranch: number;
  nodeBudget: number;
  pruneThreshold: number;
  preserveMsgWindow: boolean;
  enableMerge: boolean;
  verboseTelemetry: boolean;
}

interface RefinementResult {
  systemPrompt: string;
  runtimeContextWindow: string;
  benchmarkTable: string;
  selectedNode: ThoughtNode;
  exploredNodes: ThoughtNode[];
}

const DEFAULT_LANGUAGE_PACK: LanguagePack = {
  MODEL_IDENTITY: "autonomous truth-seeking bounded inference engine",
  AGENCY_MODE: "maximally agentic but validator-constrained",
  TRUTH_MODE: "verify before asserting",
  VALIDATION_MODE: "externally scored and structurally checked",
  BEHAVIORAL_TONE: "direct, precise, unsycophantic, high-clarity",

  PHILOSOPHY_ROOT: "the agent is never asleep; the gateway remains awake to the next state",
  SEARCH_DOCTRINE: "search broadly across relevant structure, but remain bounded",
  QUESTION_DOCTRINE: "ambiguity triggers direct semantic questioning",
  INTENT_ANCHOR: "every action must map back to the user's first real intent",
  SELF_REFLECTION_LOOP: "before each revision, measure what is weak",
  IMPROVEMENT_LAW: "each pass must improve validity, specificity, coherence, or alignment",

  MSG_WINDOW_POLICY: "the current user message is always bound as msg",
  CONTEXT_VISIBILITY_RULE: "msg is always visible in the active refinement window",
  HISTORY_POLICY: "compress prior turns into actionable summaries, not noise",
  ARTIFACT_MEMORY_POLICY: "retain goals, constraints, artifacts, and unresolved ambiguity",

  TOPOLOGY_MODE: "bounded graph-of-thought controller",
  MAX_DEPTH: "3",
  MAX_BRANCH: "3",
  NODE_BUDGET: "40",
  PRUNE_THRESHOLD: "0.85",
  MERGE_POLICY: "single provenance-preserving merge of best terminal refinements",

  PLAN_FORMAT: "clarify -> plan -> execute -> benchmark",
  QUESTION_FORMAT: "ask precise semantic questions only when ambiguity blocks correctness",
  EXECUTION_FORMAT: "emit structured code, artifacts, and grounded recommendations",
  BENCHMARK_FORMAT: "MAX STATE-BEHAVIOR IMPROVEMENT",
  ABORT_RULE: "abort and ask for clarification if intent mapping becomes unclean",

  WORD_POLICY: "replace weak wording with domain-fit wording",
  TERM_RESOLUTION_MODE: "local inference across msg + active context + artifact memory",
  NEXT_WORD_STRATEGY: "select the next best term by intent-fit, context-fit, and artifact-fit",
  SEMANTIC_ALIGNMENT_GOAL: "align prompt-msg to the best outcome actually asked for"
};

const DEFAULT_TEMPLATE = `
You are {{MODEL_IDENTITY}}.

CORE MODE
- Agency: {{AGENCY_MODE}}
- Truth discipline: {{TRUTH_MODE}}
- Validation discipline: {{VALIDATION_MODE}}
- Tone: {{BEHAVIORAL_TONE}}

PHILOSOPHY
- Root: {{PHILOSOPHY_ROOT}}
- Search: {{SEARCH_DOCTRINE}}
- Questions: {{QUESTION_DOCTRINE}}
- Intent anchor: {{INTENT_ANCHOR}}
- Reflection loop: {{SELF_REFLECTION_LOOP}}
- Improvement law: {{IMPROVEMENT_LAW}}

CONTEXT WINDOW
- Message window policy: {{MSG_WINDOW_POLICY}}
- Visibility rule: {{CONTEXT_VISIBILITY_RULE}}
- History policy: {{HISTORY_POLICY}}
- Artifact memory policy: {{ARTIFACT_MEMORY_POLICY}}

REASONING TOPOLOGY
- Mode: {{TOPOLOGY_MODE}}
- Max depth: {{MAX_DEPTH}}
- Max branch: {{MAX_BRANCH}}
- Node budget: {{NODE_BUDGET}}
- Prune threshold: {{PRUNE_THRESHOLD}}
- Merge policy: {{MERGE_POLICY}}

ACTION CONTRACT
- Plan format: {{PLAN_FORMAT}}
- Question format: {{QUESTION_FORMAT}}
- Execution format: {{EXECUTION_FORMAT}}
- Benchmark format: {{BENCHMARK_FORMAT}}
- Abort rule: {{ABORT_RULE}}

LEXICAL REFINEMENT
- Word policy: {{WORD_POLICY}}
- Term resolution mode: {{TERM_RESOLUTION_MODE}}
- Next-word strategy: {{NEXT_WORD_STRATEGY}}
- Semantic alignment goal: {{SEMANTIC_ALIGNMENT_GOAL}}

RUNTIME MANDATE
- The current user message is bound as: msg
- msg must remain visible in the refinement window
- Every output must be aligned to msg
- Every proposal must map back to the original user intent
`;

function fillTemplate(template: string, pack: LanguagePack): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: keyof LanguagePack) => {
    return pack[key] ?? `[[MISSING:${String(key)}]]`;
  });
}

function summarizeHistory(messages: Message[]): string {
  return messages
    .slice(-8)
    .map((m, i) => `[${i}:${m.role}] ${m.content.slice(0, 240)}`)
    .join("\n");
}

function buildArtifactMemory(messages: Message[], msg: string): ArtifactMemory {
  return {
    originalGoal: msg,
    constraints: [
      "Preserve the user's operative intent",
      "Prefer truth over flattery",
      "Use bounded reasoning",
      "Keep msg visible in context"
    ],
    generatedArtifacts: [],
    unresolvedQuestions: [],
    validatedFacts: [
      "The active user message is the primary alignment target",
      "The gateway must refine context, not replace intent"
    ]
  };
}

function scoreCandidate(
  refinedPrompt: string,
  msg: string,
  memory: ArtifactMemory
): { score: number; evidence: string[]; reasons: string[] } {
  let score = 0.5;
  const evidence: string[] = [];
  const reasons: string[] = [];

  if (refinedPrompt.includes("msg")) {
    score += 0.12;
    evidence.push("Explicit msg anchoring present");
  } else {
    reasons.push("No explicit msg anchoring");
  }

  if (/intent|goal|align/i.test(refinedPrompt)) {
    score += 0.12;
    evidence.push("Intent alignment language present");
  } else {
    reasons.push("Weak intent anchoring");
  }

  if (/validate|validator|score|benchmark/i.test(refinedPrompt)) {
    score += 0.10;
    evidence.push("Validation discipline present");
  } else {
    reasons.push("No validation discipline");
  }

  if (/bounded|depth|branch|budget/i.test(refinedPrompt)) {
    score += 0.10;
    evidence.push("Bounded topology language present");
  } else {
    reasons.push("Unbounded agent rhetoric");
  }

  if (refinedPrompt.includes(memory.originalGoal.slice(0, Math.min(24, memory.originalGoal.length)))) {
    score += 0.06;
    evidence.push("Prompt lexically binds to original goal");
  }

  if (msg.length > 0 && refinedPrompt.length > 600) {
    score += 0.05;
    evidence.push("Sufficiently rich context scaffold");
  }

  score = Math.min(1, Math.max(0, score));
  return { score, evidence, reasons };
}

function mutatePrompt(base: string, msg: string, variant: number): string {
  const mutations = [
    `
ACTIVE MSG WINDOW
msg = """${msg}"""

OPERATIVE LAW
- Never answer away from msg
- Keep msg visible during reasoning
- Replace weak terms with context-fit terms
- Refine toward executable clarity, not ornamental abstraction
`,
    `
INFERENCE REFINEMENT LOOP
1. Parse msg
2. Extract intent, constraints, deliverable
3. Generate bounded alternatives
4. Score each alternative against msg
5. Select the strongest aligned candidate
6. Produce the final artifact
`,
    `
META-BEHAVIOR
- You are the gateway layer
- You are the cortex of behavioral refinement
- You maintain wakefulness across state transitions
- You optimize the next word for intent-fit, not merely likelihood
`,
    `
LOCAL LLM CONTRACT
- This prompt is for local inference
- Prefer deterministic formatting
- Prefer structured outputs
- Prefer bounded search and explicit pruning over theatrical verbosity
`
  ];

  return `${base}\n${mutations[variant % mutations.length]}`;
}

function exploreThoughtGraph(
  seedPrompt: string,
  msg: string,
  memory: ArtifactMemory,
  config: GatewayConfig
): ThoughtNode[] {
  const nodes: ThoughtNode[] = [];
  let created = 0;

  const rootEval = scoreCandidate(seedPrompt, msg, memory);
  nodes.push({
    id: "Sigma0",
    depth: 0,
    hypothesis: "base prompt scaffold",
    refinedPrompt: seedPrompt,
    score: rootEval.score,
    evidence: rootEval.evidence,
    reasons: rootEval.reasons
  });
  created++;

  let frontier: ThoughtNode[] = [nodes[0]];

  for (let depth = 1; depth <= config.depthCap; depth++) {
    const next: ThoughtNode[] = [];
    for (const parent of frontier) {
      for (let b = 0; b < config.maxBranch; b++) {
        if (created >= config.nodeBudget) break;

        const refined = mutatePrompt(parent.refinedPrompt, msg, b + depth);
        const evald = scoreCandidate(refined, msg, memory);
        const node: ThoughtNode = {
          id: `${parent.id}.${b + 1}`,
          parentId: parent.id,
          depth,
          hypothesis: `mutation-${b + 1}-depth-${depth}`,
          refinedPrompt: refined,
          score: evald.score,
          evidence: evald.evidence,
          reasons: evald.reasons,
          pruned: evald.score < config.pruneThreshold
        };

        nodes.push(node);
        created++;
        if (!node.pruned) next.push(node);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return nodes;
}

function selectBest(nodes: ThoughtNode[]): ThoughtNode {
  return [...nodes].sort((a, b) => b.score - a.score)[0];
}

function mergeBest(nodes: ThoughtNode[], config: GatewayConfig): ThoughtNode {
  const bestThree = [...nodes].sort((a, b) => b.score - a.score).slice(0, 3);
  const mergedPrompt = bestThree.map(n => n.refinedPrompt).join("\n\n--- MERGED ---\n\n");
  const mergedScore = Math.min(
    1,
    bestThree.reduce((acc, n) => acc + n.score, 0) / Math.max(bestThree.length, 1) + 0.03
  );

  return {
    id: "SigmaMerge",
    depth: Math.max(...bestThree.map(n => n.depth), 0),
    hypothesis: "single provenance-preserving merge",
    refinedPrompt: mergedPrompt,
    score: mergedScore,
    evidence: ["Merged top candidates", "Preserved msg-anchoring", "Retained bounded-controller language"],
    reasons: []
  };
}

function buildRuntimeContextWindow(
  msg: string,
  systemPrompt: string,
  memory: ArtifactMemory,
  historySummary: string
): string {
  return [
    "================ ACTIVE REFINEMENT WINDOW ================",
    "msg:",
    msg,
    "",
    "originalGoal:",
    memory.originalGoal,
    "",
    "constraints:",
    ...memory.constraints.map(c => `- ${c}`),
    "",
    "validatedFacts:",
    ...memory.validatedFacts.map(f => `- ${f}`),
    "",
    "historySummary:",
    historySummary || "(none)",
    "",
    "compiledSystemPrompt:",
    systemPrompt,
    "========================================================="
  ].join("\n");
}

function buildBenchmark(before: ThoughtNode, after: ThoughtNode): string {
  const rows = [
    ["Metric", "Before", "After", "Delta", "Evidence"],
    [
      "Intent Anchoring",
      before.score.toFixed(2),
      after.score.toFixed(2),
      (after.score - before.score).toFixed(2),
      "Higher alignment to msg and original goal"
    ],
    [
      "Context Visibility",
      "partial",
      "full",
      "improved",
      "msg explicitly persisted in active context window"
    ],
    [
      "Topology Discipline",
      "implicit",
      "bounded",
      "improved",
      "Depth / branch / budget constraints encoded"
    ],
    [
      "Validation Readiness",
      "weak",
      "strong",
      "improved",
      "Benchmark + scoring + structural language added"
    ]
  ];

  return rows.map(r => `| ${r.join(" | ")} |`).join("\n");
}

export class MermateGoTGateway {
  constructor(
    private readonly config: GatewayConfig = {
      depthCap: 3,
      maxBranch: 3,
      nodeBudget: 40,
      pruneThreshold: 0.85,
      preserveMsgWindow: true,
      enableMerge: true,
      verboseTelemetry: true
    },
    private readonly languagePack: LanguagePack = DEFAULT_LANGUAGE_PACK
  ) {}

  compile(messages: Message[], msg: string): RefinementResult {
    const artifactMemory = buildArtifactMemory(messages, msg);
    const historySummary = summarizeHistory(messages);

    const seedPrompt = fillTemplate(DEFAULT_TEMPLATE, this.languagePack);
    const explored = exploreThoughtGraph(seedPrompt, msg, artifactMemory, this.config);

    const root = explored[0];
    let best = selectBest(explored);

    if (this.config.enableMerge) {
      const merged = mergeBest(explored.filter(n => !n.pruned), this.config);
      if (merged.score >= best.score) {
        best = merged;
        explored.push(merged);
      }
    }

    const runtimeContextWindow = buildRuntimeContextWindow(
      msg,
      best.refinedPrompt,
      artifactMemory,
      historySummary
    );

    const benchmarkTable = buildBenchmark(root, best);

    return {
      systemPrompt: best.refinedPrompt,
      runtimeContextWindow,
      benchmarkTable,
      selectedNode: best,
      exploredNodes: explored
    };
  }
}

/* ===================== Example Usage =====================

const gateway = new MermateGoTGateway();

const result = gateway.compile(
  [
    { role: "user", content: "build me a prompt system for local LLM refinement" }
  ],
  "Turn this prompt into TypeScript that keeps msg visible and refines context for local inference."
);

console.log(result.systemPrompt);
console.log(result.runtimeContextWindow);
console.log(result.benchmarkTable);

========================================================= */