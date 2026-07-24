'use strict';

/**
 * server/services/ports.js — Ports & Adapters Architecture Contracts for Mermate
 *
 * Defines the abstractions separating pure pipeline logic from infrastructure:
 *   - InferencePort: LLM calls (OpenAI, Ollama, Enhancer, or Fake)
 *   - RunTrackerPort: Telemetry & agent call tracing
 *   - CompilerPort: Diagram compiling & syntax validation
 *   - PipelinePorts: Master composition object injected into pipeline functions
 */

/**
 * @typedef {object} InferencePort
 * @property {(stage: string, context: object) => Promise<{output: string|null, provider: string, noOp: boolean, model: string, latencyMs: number}>} infer
 * @property {(stage: string, context: object) => Promise<{output: string|null, provider: string, noOp: boolean, model: string, latencyMs: number}>} inferMax
 * @property {(stage: string, context: object, roleName: string) => Promise<{output: string|null, provider: string, noOp: boolean, model: string, latencyMs: number}>} [inferWithRole]
 */

/**
 * @typedef {object} RunTrackerPort
 * @property {(runId: string, stage: string) => void} addStage
 * @property {(runId: string, call: object) => void} recordAgentCall
 * @property {(runId: string, event: object) => void} recordRateEvent
 * @property {(runId: string, mergeInfo: object) => void} [recordMerge]
 */

/**
 * @typedef {object} CompilerPort
 * @property {(mmd: string, dir: string, name: string) => Promise<{ok: boolean, error?: string, svg?: string, png?: string}>} compile
 * @property {(mmd: string) => {valid: boolean, stats: object, errors: array}} validate
 */

/**
 * @typedef {object} PipelinePorts
 * @property {InferencePort} inference
 * @property {RunTrackerPort} [runTracker]
 * @property {CompilerPort} compiler
 * @property {object} [audit]
 */

function createProductionPorts(overrides = {}) {
  const inferenceProvider = require('./inference-provider');
  const runTracker = require('./run-tracker');
  const compiler = require('./mermaid-compiler');
  const validator = require('./mermaid-validator');

  return {
    inference: overrides.inference || {
      infer: (stage, ctx) => inferenceProvider.infer(stage, ctx),
      inferMax: (stage, ctx) => inferenceProvider.inferMax(stage, ctx),
      inferWithRole: (stage, ctx, role) => inferenceProvider.inferWithRole(stage, ctx, role),
    },
    runTracker: overrides.runTracker || runTracker,
    compiler: overrides.compiler || {
      compile: (mmd, dir, name) => compiler.compile(mmd, dir, name),
      validate: (mmd) => validator.validate(mmd),
    },
    audit: overrides.audit || null,
  };
}

module.exports = {
  createProductionPorts,
};
