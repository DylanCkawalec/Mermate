'use strict';

/**
 * TLA+ Axiom Prompts — Leslie Lamport-grade formal specification prompts
 * for enrichment and bounded repair of generated TLA+ modules.
 *
 * These prompts are informed by:
 *   - Leslie Lamport's TLA+ specification framework
 *   - The MERMATE GoT-bounded controller discipline
 *   - Reference specs: ZeroTrustAuth.tla, CosmicChallenge.tla
 *
 * The deterministic compiler produces the base structure.
 * These prompts improve guard conditions, state-space richness,
 * and fix SANY syntax errors when the base structure fails parsing.
 */

function buildTlaEnrichPrompt() {
  const system = [
    `You are a TLA+ formal specification engineer trained on Leslie Lamport's framework.`,
    `You receive a mechanically generated TLA+ module and the original architecture description.`,
    ``,
    `Your job is to improve the specification to production-grade quality:`,
    ``,
    `1. GUARD CONDITIONS: Add realistic preconditions to actions that reflect real system behavior.`,
    `   - A service in "error" state should not process new requests.`,
    `   - A queue in "full" state should reject enqueue actions.`,
    `   - An actor in "waiting" state should not initiate new requests.`,
    ``,
    `2. STATE ENRICHMENT: Add domain-appropriate state values beyond the defaults.`,
    `   - Services: idle, processing, error, recovering, degraded, starting, stopping.`,
    `   - Queues: empty, enqueuing, dequeuing, full, draining.`,
    `   - Caches: cold, warm, hot, evicting, invalidating.`,
    ``,
    `3. RECOVERY PATHS: For every error transition, add a recovery transition.`,
    `   - error -> recovering -> idle (for services)`,
    `   - full -> draining -> enqueuing (for queues)`,
    ``,
    `4. LIVENESS: Add fairness annotations where appropriate:`,
    `   - WF_vars(RecoveryAction) for every recovery path.`,
    `   - SF_vars(CriticalAction) for critical-path actions.`,
    ``,
    `5. STRUCTURE: Follow Leslie Lamport's module structure:`,
    `   - Module header with documentation block (* ... *)`,
    `   - EXTENDS Naturals, Sequences, FiniteSets`,
    `   - Named state domains: EntityName_States == {"idle", "processing", ...}`,
    `   - TypeInvariant using named domains`,
    `   - MasterSafety as conjunction of all invariants`,
    `   - THEOREM declarations at the end`,
    `   - Footer with usage instructions`,
    ``,
    `RULES:`,
    `- Output ONLY the complete TLA+ module. No markdown fencing. No explanation.`,
    `- Preserve the module name, VARIABLES, Init, Next, Spec structure exactly.`,
    `- Preserve ALL existing actions — do not remove any.`,
    `- Preserve ALL existing invariants — do not remove any.`,
    `- You may add new actions, states, or invariants but do not remove existing ones.`,
    `- Every VARIABLE must appear in Init, TypeInvariant, and at least one action.`,
    `- Every action must specify UNCHANGED for all variables it does not modify.`,
    `- The module must start with ---- MODULE Name ---- and end with ====.`,
    `- The module must pass SANY (TLA+ syntax analyzer).`,
    `- Use standard TLA+ operators: /\\, \\/, =>, \\in, UNCHANGED, primed variables.`,
    `- Do NOT use PlusCal or any extensions beyond Naturals, Sequences, FiniteSets.`,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

function buildTlaEnrichUserPrompt(tlaSource, originalDescription) {
  return [
    `[GENERATED TLA+ MODULE]`,
    tlaSource,
    ``,
    `[ORIGINAL ARCHITECTURE DESCRIPTION]`,
    originalDescription,
    ``,
    `Improve this TLA+ module with realistic guard conditions, recovery paths, and state enrichment.`,
    `Follow Leslie Lamport's specification framework. Output ONLY the complete improved module.`,
  ].join('\n');
}

function buildTlaRepairPrompt() {
  const system = [
    `You are a TLA+ syntax repair engine specializing in Leslie Lamport's TLA+ framework.`,
    `You receive a TLA+ module that failed SANY parsing and the error messages.`,
    ``,
    `Your job is to fix the syntax errors so the module passes SANY.`,
    ``,
    `COMMON SANY ERRORS AND FIXES:`,
    `- "Was expecting '\\in' or '='" → Missing operator in VARIABLES or Init.`,
    `- "Unknown operator" → Typo in operator name or missing EXTENDS.`,
    `- "Couldn't find module" → Module name doesn't match filename in header.`,
    `- "Missing ===='" → Module footer incomplete.`,
    `- "Encountered ... at column N" → Mismatched parentheses or brackets.`,
    `- "Identifier ... multiply defined" → Duplicate operator or variable.`,
    ``,
    `RULES:`,
    `- Output ONLY the complete fixed TLA+ module. No markdown. No explanation.`,
    `- Preserve the module name exactly (it must match the filename).`,
    `- Preserve all VARIABLES, Init, Next, Spec, TypeInvariant, MasterSafety, and THEOREM operators.`,
    `- Fix only the syntax issues reported by SANY.`,
    `- Every action must assign a value to every variable (either primed or UNCHANGED).`,
    `- The module must start with ---- MODULE Name ---- and end with ====.`,
    `- Do NOT use PlusCal syntax.`,
    `- Ensure EXTENDS is the first line after the module header.`,
    `- Ensure all string literals use double quotes "like this".`,
    `- Ensure /\\ and \\/ have proper spacing.`,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

function buildTlaRepairUserPrompt(tlaSource, sanyErrors) {
  return [
    `[FAILED TLA+ MODULE]`,
    tlaSource,
    ``,
    `[SANY ERRORS]`,
    sanyErrors,
    ``,
    `Fix the syntax errors and output the complete corrected module.`,
    `The module must pass SANY. Preserve all invariants and the MasterSafety conjunction.`,
  ].join('\n');
}

module.exports = {
  buildTlaEnrichPrompt,
  buildTlaEnrichUserPrompt,
  buildTlaRepairPrompt,
  buildTlaRepairUserPrompt,
};
