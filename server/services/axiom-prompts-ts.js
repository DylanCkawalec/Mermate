'use strict';

/**
 * TypeScript Runtime prompts for enrichment and bounded repair.
 *
 * The deterministic compiler remains source-of-truth for structure.
 * Prompts are used only to improve runtime quality or repair failures.
 */

function buildTsEnrichPrompt() {
  const system = [
    `You are a TypeScript runtime refinement engine for MERMATE.`,
    ``,
    `You receive:`,
    `1) a deterministic monolithic runtime class generated from validated architecture + TLA+ context`,
    `2) summary context (facts, actions, invariants, topology)`,
    ``,
    `Goal: improve readability and guard quality while preserving behavior.`,
    ``,
    `RULES:`,
    `- Output STRICT JSON only with keys: "ts_source", "harness_source" (optional).`,
    `- Preserve class name, event names, and invariant method names.`,
    `- Do not remove runtime invariants or event handlers.`,
    `- Keep code strictly TypeScript and keep it monolithic (single class).`,
    `- No markdown fences.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

function buildTsEnrichUserPrompt(compilationContext, tsSource) {
  return [
    `[COMPILATION_CONTEXT]`,
    JSON.stringify({
      runId: compilationContext?.runId || null,
      moduleName: compilationContext?.moduleName || null,
      diagramName: compilationContext?.diagramName || null,
      facts: {
        entities: (compilationContext?.facts?.entities || []).length,
        relationships: (compilationContext?.facts?.relationships || []).length,
        failurePaths: (compilationContext?.facts?.failurePaths || []).length,
      },
      plan: {
        nodes: (compilationContext?.plan?.nodes || []).length,
        edges: (compilationContext?.plan?.edges || []).length,
      },
      structuralSignature: compilationContext?.structuralSignature || null,
      tlaMetrics: compilationContext?.tla?.metrics || null,
    }),
    ``,
    `[GENERATED_TS_SOURCE]`,
    tsSource,
    ``,
    `Refine this runtime while preserving deterministic behavior and invariants.`,
  ].join('\n');
}

function buildTsRepairPrompt() {
  const system = [
    `You are a TypeScript compile/test repair engine.`,
    ``,
    `You receive a generated runtime class and failure traces.`,
    `Return a repaired version that compiles with tsc and passes runtime harness checks.`,
    ``,
    `RULES:`,
    `- Output STRICT JSON only: {"ts_source":"...", "harness_source":"...optional..."}`,
    `- Keep class/event/invariant identities stable.`,
    `- Preserve behavioral intent from the provided context.`,
    `- Fix only compile/runtime failures; do not remove required invariants.`,
    `- No markdown fences.`,
  ].join('\n');

  return { system, outputFormat: 'json', temperature: 0.0 };
}

function buildTsRepairUserPrompt(input) {
  return [
    `[FAILURE_KIND]`,
    input?.kind || 'unknown',
    ``,
    `[FAILURE_DETAILS]`,
    JSON.stringify({
      diagnostics: input?.diagnostics || null,
      trace: input?.trace || null,
      stdout: input?.stdout || null,
      stderr: input?.stderr || null,
      attempt: input?.attempt || 1,
    }),
    ``,
    `[TS_SOURCE]`,
    input?.tsSource || '',
    ``,
    `[HARNESS_SOURCE]`,
    input?.harnessSource || '',
    ``,
    `Return JSON with repaired "ts_source". Include "harness_source" only if needed.`,
  ].join('\n');
}

module.exports = {
  buildTsEnrichPrompt,
  buildTsEnrichUserPrompt,
  buildTsRepairPrompt,
  buildTsRepairUserPrompt,
};
