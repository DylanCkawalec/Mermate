'use strict';

/**
 * TypeScript Runtime Compiler — deterministic mapper from the shared
 * CompilationContext to a monolithic executable TypeScript class.
 *
 * Source of truth:
 *   - validated architecture facts/plan
 *   - validated TLA+ module/config context
 *
 * This compiler does NOT translate Mermaid text directly to code.
 */

const { createHash } = require('node:crypto');
const tlaCompiler = require('./tla-compiler');
const logger = require('../utils/logger');

function _hash16(text) {
  if (!text) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function _sanitizeId(name) {
  return tlaCompiler._sanitizeId(name || '');
}

function _pascalCase(text) {
  return String(text || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('') || 'Runtime';
}

function _unique(array) {
  return [...new Set(array)];
}

function _safeStringLiteral(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function _buildEntityMap(facts) {
  const entityMap = {};
  for (const entity of (facts?.entities || [])) {
    entityMap[entity.name] = tlaCompiler.mapEntityToVariable(entity);
  }
  return entityMap;
}

function _buildActions(facts, entityMap) {
  return (facts?.relationships || []).map((rel) => {
    const base = tlaCompiler.mapRelationshipToAction(rel, entityMap);
    const methodName = `handle${_pascalCase(base.actionName)}`;
    return {
      ...base,
      eventType: base.actionName,
      methodName,
    };
  });
}

function _buildInvariants(facts, entityMap) {
  return (facts?.failurePaths || []).map((fp, index) => {
    const base = tlaCompiler.mapFailurePathToInvariant(fp, entityMap, index);
    const methodName = `check${_pascalCase(base.name)}`;
    return {
      ...base,
      methodName,
    };
  });
}

function _effectState(effectExpr) {
  const m = String(effectExpr || '').match(/\w+'\s*=\s*"([^"]+)"/);
  return m ? m[1] : 'idle';
}

function _preconditionToJs(preconditionExpr) {
  const m = String(preconditionExpr || '').match(/([A-Za-z_]\w*)\s*=\s*"([^"]+)"/);
  if (!m) return 'true';
  return `this.${m[1]} === "${_safeStringLiteral(m[2])}"`;
}

function _invariantToJs(invExpr) {
  // Expected deterministic form:
  // trigger = "error" => handler /= "idle"
  const m = String(invExpr || '').match(/([A-Za-z_]\w*)\s*=\s*"([^"]+)"\s*=>\s*([A-Za-z_]\w*)\s*\/=\s*"([^"]+)"/);
  if (!m) {
    return {
      guard: 'false',
      fail: '"Invariant shape unsupported"',
    };
  }
  const triggerId = m[1];
  const triggerState = m[2];
  const handlerId = m[3];
  const handlerState = m[4];
  return {
    guard: `(this.${triggerId} as string) === "${_safeStringLiteral(triggerState)}" && (this.${handlerId} as string) === "${_safeStringLiteral(handlerState)}"`,
    fail: `"${_safeStringLiteral(triggerId)}=${_safeStringLiteral(triggerState)} requires ${_safeStringLiteral(handlerId)}!=${_safeStringLiteral(handlerState)}"`,
  };
}

function _buildRuntimeSource(ctx) {
  const stateEntities = ctx.stateEntities;
  const actions = ctx.actions;
  const invariants = ctx.invariants;
  const className = ctx.className;

  const stateTypeDefs = stateEntities.map((entity) => {
    const union = _unique(entity.states).map((s) => `"${_safeStringLiteral(s)}"`).join(' | ') || '"idle"';
    return `export type State_${entity.id} = ${union};`;
  }).join('\n');

  const runtimeStateFields = stateEntities.map((entity) => `  ${entity.id}: State_${entity.id};`).join('\n');
  const classFields = stateEntities.map((entity) => `  private ${entity.id}: State_${entity.id};`).join('\n');
  const initAssignments = stateEntities.map((entity) => `    this.${entity.id} = "${_safeStringLiteral(entity.states[0])}";`).join('\n');
  const snapshotBody = stateEntities.map((entity) => `      ${entity.id}: this.${entity.id},`).join('\n');

  const allowedStatesEntries = stateEntities.map((entity) => {
    const vals = _unique(entity.states).map((s) => `"${_safeStringLiteral(s)}"`).join(', ');
    return `      ${entity.id}: [${vals}],`;
  }).join('\n');

  const eventUnion = actions.length
    ? _unique(actions.map((a) => `"${_safeStringLiteral(a.eventType)}"`)).join(' | ')
    : '"__noop__"';

  const eventSwitch = actions.length
    ? actions.map((action) => `      case "${_safeStringLiteral(action.eventType)}": return this.${action.methodName}();`).join('\n')
    : '      default: return false;';

  const actionMethods = actions.map((action) => {
    const guardExpr = _preconditionToJs(action.precondition);
    const fromNext = _effectState(action.fromEffect);
    const toNext = _effectState(action.toEffect);
    return [
      `  private ${action.methodName}(): boolean {`,
      `    if (!(${guardExpr})) return false;`,
      `    this.${action.fromId} = "${_safeStringLiteral(fromNext)}";`,
      `    this.${action.toId} = "${_safeStringLiteral(toNext)}";`,
      `    return true;`,
      `  }`,
    ].join('\n');
  }).join('\n\n');

  const invariantMethods = invariants.map((inv) => {
    const parsed = _invariantToJs(inv.tlaExpr);
    return [
      `  private ${inv.methodName}(): void {`,
      `    if (${parsed.guard}) {`,
      `      throw new Error(${parsed.fail});`,
      `    }`,
      `  }`,
    ].join('\n');
  }).join('\n\n');

  const invariantCalls = invariants.map((inv) => `    this.${inv.methodName}();`).join('\n');
  const manifestActions = actions.map((a) => `"${_safeStringLiteral(a.eventType)}"`).join(', ');
  const manifestInvariants = invariants.map((i) => `"${_safeStringLiteral(i.name)}"`).join(', ');

  return [
    `/**`,
    ` * Generated by MERMATE TypeScriptRuntime compiler.`,
    ` * Run: ${_safeStringLiteral(ctx.runId || 'n/a')}`,
    ` * Diagram: ${_safeStringLiteral(ctx.diagramName)}`,
    ` * TLA module: ${_safeStringLiteral(ctx.moduleName || 'Spec')}`,
    ` * TLA hash: ${_safeStringLiteral(ctx.tlaHash || 'n/a')}`,
    ` */`,
    ``,
    stateTypeDefs,
    ``,
    `export type RuntimeEventType = ${eventUnion};`,
    ``,
    `export interface RuntimeEvent {`,
    `  type: RuntimeEventType;`,
    `  payload?: Record<string, unknown>;`,
    `  at?: number;`,
    `}`,
    ``,
    `export interface RuntimeConfig {`,
    `  maxSteps: number;`,
    `  strictGuards: boolean;`,
    `}`,
    ``,
    `export interface RuntimeState {`,
    runtimeStateFields || '  __empty: "__empty";',
    `}`,
    ``,
    `export interface RuntimeLogEntry {`,
    `  step: number;`,
    `  event: RuntimeEventType;`,
    `  handled: boolean;`,
    `  before: RuntimeState;`,
    `  after: RuntimeState;`,
    `}`,
    ``,
    `export interface RuntimeCoverageReport {`,
    `  steps: number;`,
    `  eventsSeen: RuntimeEventType[];`,
    `  invariantChecks: number;`,
    `  eventLogSize: number;`,
    `  finalState: RuntimeState;`,
    `}`,
    ``,
    `export class ${className} {`,
    `  private readonly config: RuntimeConfig;`,
    `  private readonly eventLog: RuntimeLogEntry[] = [];`,
    `  private readonly eventsSeen: Set<RuntimeEventType> = new Set();`,
    `  private invariantChecks = 0;`,
    `  private step = 0;`,
    classFields || '  private __empty: "__empty" = "__empty";',
    ``,
    `  private readonly allowedStates: Record<keyof RuntimeState, readonly string[]> = {`,
    allowedStatesEntries || '      __empty: ["__empty"],',
    `  } as const;`,
    ``,
    `  constructor(config: Partial<RuntimeConfig> = {}) {`,
    `    this.config = {`,
    `      maxSteps: 1000,`,
    `      strictGuards: false,`,
    `      ...config,`,
    `    };`,
    initAssignments || '',
    `    this.assertTypeInvariant();`,
    `  }`,
    ``,
    `  public snapshot(): RuntimeState {`,
    `    return {`,
    snapshotBody || '      __empty: "__empty",',
    `    };`,
    `  }`,
    ``,
    `  public dispatch(event: RuntimeEvent): void {`,
    `    if (this.step >= this.config.maxSteps) {`,
    `      throw new Error(\`Runtime step budget exceeded: \${this.config.maxSteps}\`);`,
    `    }`,
    `    const before = this.snapshot();`,
    `    const handled = this.applyEvent(event);`,
    `    if (!handled && this.config.strictGuards) {`,
    `      throw new Error(\`No transition matched event "\${event.type}" at step \${this.step}\`);`,
    `    }`,
    `    this.assertAllInvariants(event.type);`,
    `    const after = this.snapshot();`,
    `    this.eventsSeen.add(event.type);`,
    `    this.eventLog.push({`,
    `      step: this.step,`,
    `      event: event.type,`,
    `      handled,`,
    `      before,`,
    `      after,`,
    `    });`,
    `    this.step += 1;`,
    `  }`,
    ``,
    `  public getEventLog(): RuntimeLogEntry[] {`,
    `    return this.eventLog.map((entry) => ({`,
    `      ...entry,`,
    `      before: { ...entry.before },`,
    `      after: { ...entry.after },`,
    `    }));`,
    `  }`,
    ``,
    `  public getManifest(): {`,
    `    states: (keyof RuntimeState)[];`,
    `    actions: RuntimeEventType[];`,
    `    invariants: string[];`,
    `    moduleName: string;`,
    `  } {`,
    `    return {`,
    `      states: Object.keys(this.allowedStates) as (keyof RuntimeState)[],`,
    `      actions: [${manifestActions}],`,
    `      invariants: [${manifestInvariants}],`,
    `      moduleName: "${_safeStringLiteral(ctx.moduleName || 'Spec')}",`,
    `    };`,
    `  }`,
    ``,
    `  public getCoverageReport(): RuntimeCoverageReport {`,
    `    return {`,
    `      steps: this.step,`,
    `      eventsSeen: [...this.eventsSeen],`,
    `      invariantChecks: this.invariantChecks,`,
    `      eventLogSize: this.eventLog.length,`,
    `      finalState: this.snapshot(),`,
    `    };`,
    `  }`,
    ``,
    `  private applyEvent(event: RuntimeEvent): boolean {`,
    `    switch (event.type) {`,
    eventSwitch,
    `      default: return false;`,
    `    }`,
    `  }`,
    ``,
    actionMethods || '',
    ``,
    `  private assertTypeInvariant(): void {`,
    `    const state = this.snapshot();`,
    `    for (const key of Object.keys(state) as (keyof RuntimeState)[]) {`,
    `      const value = state[key];`,
    `      const allowed = this.allowedStates[key] || [];`,
    `      if (!allowed.includes(value as string)) {`,
    `        throw new Error(\`TypeInvariant failed for \${String(key)}=\${String(value)}\`);`,
    `      }`,
    `    }`,
    `  }`,
    ``,
    invariantMethods || '',
    ``,
    `  private assertAllInvariants(_eventType: RuntimeEventType): void {`,
    `    this.assertTypeInvariant();`,
    invariantCalls || '',
    `    this.invariantChecks += 1;`,
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

function _buildHarnessSource(ctx) {
  const className = ctx.className;
  const fileBase = ctx.fileBase;
  return [
    `import { ${className}, RuntimeEventType } from './${fileBase}';`,
    ``,
    `function runHarness(): void {`,
    `  const baseline = new ${className}({ strictGuards: false, maxSteps: 2000 });`,
    `  const manifest = baseline.getManifest();`,
    `  const actionResults: { action: string; report: ReturnType<${className}['getCoverageReport']> }[] = [];`,
    ``,
    `  for (const action of manifest.actions) {`,
    `    const runtime = new ${className}({ strictGuards: true, maxSteps: 25 });`,
    `    runtime.dispatch({ type: action as RuntimeEventType });`,
    `    actionResults.push({ action, report: runtime.getCoverageReport() });`,
    `  }`,
    ``,
    `  const integrated = new ${className}({ strictGuards: false, maxSteps: 2000 });`,
    `  for (const action of manifest.actions) {`,
    `    integrated.dispatch({ type: action as RuntimeEventType });`,
    `  }`,
    `  const integratedReport = integrated.getCoverageReport();`,
    ``,
    `  if (!(integratedReport.invariantChecks >= 1 || manifest.actions.length === 0)) {`,
    `    throw new Error('Invariant checks must run for runtime execution');`,
    `  }`,
    `  if (actionResults.length !== manifest.actions.length) {`,
    `    throw new Error('Every action must be executable from init state');`,
    `  }`,
    ``,
    `  console.log(JSON.stringify({`,
    `    ok: true,`,
    `    actions: manifest.actions.length,`,
    `    invariants: manifest.invariants.length,`,
    `    steps: integratedReport.steps,`,
    `    eventsSeen: integratedReport.eventsSeen.length,`,
    `  }));`,
    `}`,
    ``,
    `try {`,
    `  runHarness();`,
    `} catch (error) {`,
    `  const err = error instanceof Error ? error : new Error(String(error));`,
    `  const payload = {`,
    `    type: 'ts_invariant_violation',`,
    `    message: err.message,`,
    `    stack: err.stack || '',`,
    `  };`,
    `  console.error('TS_RUNTIME_FAILURE::' + JSON.stringify(payload));`,
    `  throw err;`,
    `}`,
    ``,
  ].join('\n');
}

function compileCompilationContext(context, opts = {}) {
  const facts = context?.facts || { entities: [], relationships: [], failurePaths: [] };
  const plan = context?.plan || { nodes: [], edges: [], subgraphs: [] };
  const runId = context?.runId || null;
  const moduleName = context?.moduleName || 'Spec';
  const diagramName = context?.diagramName || 'runtime';
  const tlaSource = context?.tla?.source || '';

  const entityMap = _buildEntityMap(facts);
  const stateEntities = Object.values(entityMap).filter((entity) => entity.isStateful);
  const actions = _buildActions(facts, entityMap);
  const invariants = _buildInvariants(facts, entityMap);

  const classBase = _pascalCase(diagramName);
  const className = classBase.endsWith('Runtime') ? classBase : `${classBase}Runtime`;
  const fileBase = className;

  const tsSource = _buildRuntimeSource({
    runId,
    diagramName,
    moduleName,
    className,
    stateEntities,
    actions,
    invariants,
    tlaHash: _hash16(tlaSource),
  });

  const harnessSource = _buildHarnessSource({
    className,
    fileBase,
  });

  const coverageSpec = {
    entities: stateEntities.map((entity) => entity.id),
    actions: actions.map((action) => action.eventType),
    actionMethods: actions.map((action) => action.methodName),
    invariants: invariants.map((inv) => inv.methodName),
    requiredMethods: ['assertTypeInvariant', 'assertAllInvariants', 'dispatch', 'snapshot', 'getManifest', 'getCoverageReport'],
    initialStates: stateEntities.map((entity) => ({
      id: entity.id,
      state: entity.states[0] || 'idle',
    })),
  };

  const metrics = {
    entityCount: stateEntities.length,
    actionCount: actions.length,
    invariantCount: invariants.length,
    planNodeCount: (plan?.nodes || []).length,
    planEdgeCount: (plan?.edges || []).length,
    stateSpaceEstimate: stateEntities.reduce((acc, entity) => acc * Math.max(entity.states.length, 1), 1),
    tlaHash: _hash16(tlaSource),
    cfgHash: _hash16(context?.tla?.cfg || ''),
  };

  logger.info('ts_compiler.compiled', {
    runId: runId ? String(runId).slice(0, 8) : null,
    className,
    entities: metrics.entityCount,
    actions: metrics.actionCount,
    invariants: metrics.invariantCount,
  });

  return {
    className,
    fileBase,
    tsSource,
    harnessSource,
    coverageSpec,
    metrics,
    contextSummary: {
      runId,
      diagramName,
      moduleName,
      structuralSignatureHash: _hash16(JSON.stringify(context?.structuralSignature || null)),
    },
    artifacts: {
      sourceFile: `${fileBase}.ts`,
      harnessFile: `${fileBase}.harness.ts`,
    },
  };
}

module.exports = {
  compileCompilationContext,
  _sanitizeId,
  _pascalCase,
  _hash16,
  _buildEntityMap,
  _buildActions,
  _buildInvariants,
};
