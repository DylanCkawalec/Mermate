'use strict';

/**
 * TLA+ Axiom Prompts — composition and repair prompts for the TLA+
 * compilation target.
 *
 * These are used only when the deterministic compiler output needs
 * enrichment (richer state descriptions) or repair (SANY syntax fix).
 * The base structure is always deterministic from the typed plan.
 */

/**
 * Build a prompt to enrich a deterministically generated TLA+ module
 * with more realistic state transitions and guard conditions.
 */
function buildTlaEnrichPrompt() {
  const system = [
    `You are a TLA+ specification engineer. You receive a mechanically generated TLA+ module and the original architecture description.`,
    ``,
    `Your job is to improve the specification by:`,
    `1. Adding realistic guard conditions to actions (preconditions that reflect real system behavior).`,
    `2. Enriching state sets with domain-appropriate values.`,
    `3. Adding meaningful liveness or fairness annotations where appropriate.`,
    `4. Ensuring the TypeInvariant accurately constrains the state space.`,
    ``,
    `RULES:`,
    `- Output ONLY the complete TLA+ module. No markdown fencing. No explanation.`,
    `- Preserve the module name, VARIABLES, Init, Next, Spec structure exactly.`,
    `- Preserve ALL existing actions — do not remove any.`,
    `- Preserve ALL existing invariants — do not remove any.`,
    `- You may add new actions or invariants but do not remove existing ones.`,
    `- Every VARIABLE must appear in Init, TypeInvariant, and at least one action.`,
    `- The module must pass SANY (TLA+ syntax analyzer).`,
    `- Use standard TLA+ operators: /\\, \\/, =>, \\in, UNCHANGED, primed variables.`,
    `- Do NOT use PlusCal or any extensions beyond Naturals, Sequences, FiniteSets.`,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

/**
 * Build a user prompt for TLA+ enrichment.
 */
function buildTlaEnrichUserPrompt(tlaSource, originalDescription) {
  return [
    `[GENERATED TLA+ MODULE]`,
    tlaSource,
    ``,
    `[ORIGINAL ARCHITECTURE DESCRIPTION]`,
    originalDescription,
    ``,
    `Improve this TLA+ module with more realistic guard conditions, state sets, and transitions. Output ONLY the complete improved module.`,
  ].join('\n');
}

/**
 * Build a prompt to repair a TLA+ module that failed SANY parsing.
 */
function buildTlaRepairPrompt() {
  const system = [
    `You are a TLA+ syntax repair engine. You receive a TLA+ module that failed SANY parsing and the error messages.`,
    ``,
    `Your job is to fix the syntax errors so the module passes SANY.`,
    ``,
    `RULES:`,
    `- Output ONLY the complete fixed TLA+ module. No markdown. No explanation.`,
    `- Preserve the module name exactly (it must match the filename).`,
    `- Preserve all VARIABLES, Init, Next, Spec, and invariant operators.`,
    `- Fix only the syntax issues reported by SANY.`,
    `- Common fixes: missing commas, unbalanced parentheses, incorrect operator syntax,`,
    `  missing EXTENDS, incorrect variable priming, missing UNCHANGED clauses.`,
    `- Every action must assign a value to every variable (either primed or UNCHANGED).`,
    `- The module must start with ---- MODULE Name ---- and end with ====.`,
    `- Do NOT use PlusCal syntax.`,
  ].join('\n');

  return { system, outputFormat: 'text', temperature: 0.0 };
}

/**
 * Build a user prompt for TLA+ repair.
 */
function buildTlaRepairUserPrompt(tlaSource, sanyErrors) {
  return [
    `[FAILED TLA+ MODULE]`,
    tlaSource,
    ``,
    `[SANY ERRORS]`,
    sanyErrors,
    ``,
    `Fix the syntax errors and output the complete corrected module.`,
  ].join('\n');
}

module.exports = {
  buildTlaEnrichPrompt,
  buildTlaEnrichUserPrompt,
  buildTlaRepairPrompt,
  buildTlaRepairUserPrompt,
};
