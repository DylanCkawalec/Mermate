'use strict';

/**
 * TLA+ Compiler — deterministic mapping from the typed architecture plan
 * (facts + plan) to a TLA+ module and TLC configuration file.
 *
 * This is a sibling compilation target to Mermaid. Both consume the same
 * canonical intermediate representation produced in the ANALYZE phase.
 *
 * Mapping rules:
 *   facts.entities (stateful)    → VARIABLES
 *   facts.entities (config)      → CONSTANTS
 *   facts.relationships          → Named action operators in Next
 *   facts.boundaries             → Comment-delimited operator groups
 *   facts.failurePaths           → INVARIANT operators
 *   plan.nodes + entity types    → TypeInvariant state sets
 *   plan.edges                   → Action preconditions / effects
 */

const logger = require('../utils/logger');

// ---- Entity → TLA+ Variable Mapping ---------------------------------------

const STATEFUL_TYPES = new Set(['service', 'store', 'cache', 'queue', 'broker', 'gateway']);
const ACTOR_TYPES = new Set(['actor', 'external']);
const STRUCTURAL_TYPES = new Set(['decision', 'boundary']);

const DEFAULT_STATES = {
  service:  ['idle', 'processing', 'error', 'recovering'],
  store:    ['available', 'writing', 'reading', 'error'],
  cache:    ['cold', 'warm', 'hot', 'evicting'],
  queue:    ['empty', 'enqueuing', 'dequeuing', 'full'],
  broker:   ['idle', 'routing', 'error'],
  gateway:  ['open', 'throttling', 'closed', 'error'],
  actor:    ['idle', 'requesting', 'waiting'],
  external: ['available', 'unavailable'],
};

function _sanitizeId(name) {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, 'v$1')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
}

function _tlaSet(items) {
  return `{${items.map(i => `"${i}"`).join(', ')}}`;
}

function mapEntityToVariable(entity) {
  const id = _sanitizeId(entity.name);
  const states = DEFAULT_STATES[entity.type] || ['idle', 'active', 'error'];
  return {
    id,
    name: entity.name,
    type: entity.type,
    isStateful: STATEFUL_TYPES.has(entity.type) || ACTOR_TYPES.has(entity.type),
    isConstant: STRUCTURAL_TYPES.has(entity.type),
    states,
    stateSet: _tlaSet(states),
    initState: `"${states[0]}"`,
  };
}

// ---- Relationship → TLA+ Action Mapping -----------------------------------

function mapRelationshipToAction(rel, entityMap) {
  const fromId = _sanitizeId(rel.from);
  const toId = _sanitizeId(rel.to);
  const verb = _sanitizeId(rel.verb || 'interacts');
  const actionName = `${fromId}_${verb}_${toId}`;

  const fromEntity = entityMap[rel.from];
  const toEntity = entityMap[rel.to];

  const fromStates = fromEntity?.states || ['idle', 'active'];
  const toStates = toEntity?.states || ['idle', 'active'];

  const isAsync = rel.edgeType === 'async';

  return {
    actionName,
    fromId,
    toId,
    verb: rel.verb,
    edgeType: rel.edgeType,
    isAsync,
    precondition: `${fromId} = "${fromStates[0]}"`,
    fromEffect: `${fromId}' = "${fromStates[1] || fromStates[0]}"`,
    toEffect: `${toId}' = "${toStates[1] || toStates[0]}"`,
  };
}

// ---- Failure Path → TLA+ Invariant Mapping ---------------------------------

function mapFailurePathToInvariant(fp, entityMap, index) {
  const triggerId = _sanitizeId(fp.trigger);
  const handlerId = _sanitizeId(fp.handler);
  const name = `Safety_${index + 1}_${triggerId}`;

  return {
    name,
    trigger: fp.trigger,
    condition: fp.condition,
    handler: fp.handler,
    recovery: fp.recovery,
    triggerId,
    handlerId,
    tlaExpr: `${triggerId} = "error" => ${handlerId} /= "idle"`,
  };
}

// ---- Module Generator ------------------------------------------------------

/**
 * Generate a TLA+ module from the typed architecture plan.
 *
 * @param {object} facts - Stage 1 output (entities, relationships, boundaries, failurePaths)
 * @param {object} plan - Stage 2 output (nodes, edges, subgraphs)
 * @param {string} moduleName - TLA+ module name (must match filename)
 * @returns {{ tlaSource: string, variables: object[], actions: object[], invariants: object[] }}
 */
function factsToTlaModule(facts, plan, moduleName) {
  const entities = facts?.entities || [];
  const relationships = facts?.relationships || [];
  const boundaries = facts?.boundaries || [];
  const failurePaths = facts?.failurePaths || [];

  const entityMap = {};
  for (const e of entities) {
    entityMap[e.name] = mapEntityToVariable(e);
  }

  const variables = Object.values(entityMap).filter(v => v.isStateful);
  const constants = Object.values(entityMap).filter(v => v.isConstant);
  const varIdSet = new Set(variables.map(v => v.id));

  // Only include relationships where BOTH endpoints are declared variables —
  // referencing undefined variables is the primary cause of SANY failures.
  const validRels = relationships.filter(r => {
    const fId = _sanitizeId(r.from);
    const tId = _sanitizeId(r.to);
    return varIdSet.has(fId) && varIdSet.has(tId) && fId !== tId;
  });
  const actions = validRels.map(r => mapRelationshipToAction(r, entityMap));

  // Only include invariants where trigger and handler are declared variables
  const validFPs = failurePaths.filter(fp => {
    const tId = _sanitizeId(fp.trigger);
    const hId = _sanitizeId(fp.handler);
    return varIdSet.has(tId) && varIdSet.has(hId);
  });
  const invariants = validFPs.map((fp, i) => mapFailurePathToInvariant(fp, entityMap, i));

  const lines = [];
  const date = new Date().toISOString().split('T')[0];

  // ---- Module header with documentation block (Lamport style) ----
  lines.push(`${'-'.repeat(22)} MODULE ${moduleName} ${'-'.repeat(22)}`);
  lines.push(`(${'*'.repeat(74)}`);
  lines.push(` * ${moduleName} — Formal Architecture Specification`);
  lines.push(` *`);
  lines.push(` * Generated by MERMATE Architecture Compiler from typed facts + plan.`);
  lines.push(` * Date: ${date}`);
  lines.push(` *`);
  lines.push(` * ENTITIES: ${variables.length} stateful, ${constants.length} structural`);
  lines.push(` * ACTIONS: ${actions.length} (from ${relationships.length} relationships)`);
  lines.push(` * INVARIANTS: ${invariants.length + 1} (TypeInvariant + ${invariants.length} safety)`);
  if (boundaries.length > 0) {
    lines.push(` * BOUNDARIES: ${boundaries.map(b => b.name).join(', ')}`);
  }
  lines.push(` *`);
  lines.push(` * KEY PROPERTIES VERIFIED:`);
  lines.push(` *   1. TypeInvariant — all entities remain in legal state sets`);
  lines.push(` *   2. MasterSafety — conjunction of all safety invariants`);
  for (const inv of invariants) {
    lines.push(` *   ${invariants.indexOf(inv) + 3}. ${inv.name} — ${inv.trigger}: ${inv.condition}`);
  }
  lines.push(` *`);
  lines.push(` * SPECIFICATION FRAMEWORK: Leslie Lamport's TLA+`);
  lines.push(` * VERIFICATION: SANY (syntax) + TLC (model checking)`);
  lines.push(` ${'*'.repeat(74)})`);
  lines.push(``);
  lines.push(`EXTENDS Naturals`);
  lines.push(``);

  // ---- VARIABLES ----
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* VARIABLES: one per stateful architectural entity`);
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`VARIABLES`);
  const varDecls = variables.map((v, i) => {
    const comma = i < variables.length - 1 ? ',' : '';
    return `  ${v.id}${comma}    \\* ${v.name} (${v.type}): ${v.states.join(' | ')}`;
  });
  lines.push(...varDecls);
  lines.push(``);
  lines.push(`vars == <<${variables.map(v => v.id).join(', ')}>>`);
  lines.push(``);

  // ---- State domains ----
  for (const v of variables) {
    lines.push(`${v.id}_States == ${v.stateSet}`);
  }
  lines.push(``);

  // ---- TypeInvariant (in define-style block) ----
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* INVARIANTS`);
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(``);
  lines.push(`\\* TypeInvariant: all variables remain in their legal state sets`);
  lines.push(`TypeInvariant ==`);
  const typeConstraints = variables.map((v, i) => {
    const prefix = '  /\\ ';
    return `${prefix}${v.id} \\in ${v.id}_States`;
  });
  lines.push(...typeConstraints);
  lines.push(``);

  // ---- Safety invariants from failure paths ----
  if (invariants.length > 0) {
    for (const inv of invariants) {
      lines.push(`\\* ${inv.trigger}: ${inv.condition} => ${inv.handler} handles with ${inv.recovery}`);
      lines.push(`${inv.name} ==`);
      lines.push(`  ${inv.tlaExpr}`);
      lines.push(``);
    }
  }

  // ---- MasterSafety: conjunction of all invariants ----
  lines.push(`\\* MasterSafety: conjunction of all invariants (primary verification target)`);
  lines.push(`MasterSafety ==`);
  lines.push(`  /\\ TypeInvariant`);
  for (const inv of invariants) {
    lines.push(`  /\\ ${inv.name}`);
  }
  lines.push(``);

  // ---- Init ----
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* INITIAL STATE`);
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(``);
  lines.push(`Init ==`);
  const initConstraints = variables.map((v) => {
    return `  /\\ ${v.id} = ${v.initState}`;
  });
  lines.push(...initConstraints);
  lines.push(``);

  // ---- Actions grouped by boundary ----
  const boundaryMembers = new Map();
  for (const b of boundaries) {
    for (const member of (b.members || [])) {
      boundaryMembers.set(member, b.name);
      boundaryMembers.set(_sanitizeId(member), b.name);
    }
  }

  const actionsByBoundary = new Map();
  for (const action of actions) {
    const boundary = boundaryMembers.get(action.fromId) || boundaryMembers.get(action.verb) || 'Global';
    if (!actionsByBoundary.has(boundary)) actionsByBoundary.set(boundary, []);
    actionsByBoundary.get(boundary).push(action);
  }

  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* ACTIONS: one per architectural relationship`);
  lines.push(`\\* ${'='.repeat(70)}`);

  for (const [boundary, boundaryActions] of actionsByBoundary) {
    lines.push(``);
    lines.push(`\\* ---- ${boundary} ${'─'.repeat(Math.max(1, 60 - boundary.length))}`);

    for (const action of boundaryActions) {
      lines.push(``);
      lines.push(`\\* ${action.fromId} ${action.verb} ${action.toId} (${action.edgeType})`);
      lines.push(`${action.actionName} ==`);
      lines.push(`  /\\ ${action.precondition}`);
      lines.push(`  /\\ ${action.fromEffect}`);
      lines.push(`  /\\ ${action.toEffect}`);

      const unchanged = variables
        .filter(v => v.id !== action.fromId && v.id !== action.toId)
        .map(v => v.id);
      if (unchanged.length > 0) {
        lines.push(`  /\\ UNCHANGED <<${unchanged.join(', ')}>>`);
      }
    }
  }
  lines.push(``);

  // ---- Next-State Relation ----
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* NEXT-STATE RELATION`);
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(``);
  lines.push(`Next ==`);
  if (actions.length > 0) {
    const nextDisjuncts = actions.map((a, i) => {
      const prefix = i === 0 ? '  \\/ ' : '  \\/ ';
      return `${prefix}${a.actionName}`;
    });
    lines.push(...nextDisjuncts);
  } else {
    lines.push(`  UNCHANGED vars`);
  }
  lines.push(``);

  // ---- Specification ----
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* SPECIFICATION`);
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(``);
  lines.push(`Spec == Init /\\ [][Next]_vars`);
  lines.push(``);

  // ---- Footer ----
  lines.push(`${'='.repeat(68)}`);
  lines.push(``);
  lines.push(`(${'*'.repeat(74)}`);
  lines.push(` * END OF SPECIFICATION: ${moduleName}`);
  lines.push(` *`);
  lines.push(` * USAGE:`);
  lines.push(` *   1. Syntax check: java -cp tla2tools.jar tla2sany.SANY ${moduleName}.tla`);
  lines.push(` *   2. Model check:  java -jar tla2tools.jar -config ${moduleName}.cfg ${moduleName}.tla`);
  lines.push(` *`);
  lines.push(` * GENERATED BY: MERMATE Architecture Compiler (GoT-bounded)`);
  lines.push(` * FRAMEWORK: Leslie Lamport's Temporal Logic of Actions`);
  lines.push(` ${'*'.repeat(74)})`);

  const tlaSource = lines.join('\n');

  logger.info('tla_compiler.module_generated', {
    moduleName,
    variables: variables.length,
    actions: actions.length,
    invariants: invariants.length,
    lines: lines.length,
  });

  return { tlaSource, variables, actions, invariants };
}

// ---- Config Generator ------------------------------------------------------

/**
 * Generate a TLC configuration file.
 *
 * @param {object[]} invariants - Invariant mappings from factsToTlaModule
 * @param {string} moduleName
 * @returns {string} .cfg file contents
 */
function factsToTlaCfg(invariants, moduleName) {
  const lines = [];

  lines.push(`\\* TLC configuration for ${moduleName}`);
  lines.push(`\\* Generated by MERMATE Architecture Compiler`);
  lines.push(``);
  lines.push(`SPECIFICATION Spec`);
  lines.push(``);
  lines.push(`\\* Primary verification target: conjunction of all invariants`);
  lines.push(`INVARIANT MasterSafety`);
  lines.push(``);
  lines.push(`\\* Individual invariants (also checked via MasterSafety)`);
  lines.push(`INVARIANT TypeInvariant`);

  for (const inv of invariants) {
    lines.push(`INVARIANT ${inv.name}`);
  }

  lines.push(``);
  lines.push(`CHECK_DEADLOCK FALSE`);

  const cfgSource = lines.join('\n');

  logger.info('tla_compiler.cfg_generated', {
    moduleName,
    invariants: invariants.length + 1,
  });

  return cfgSource;
}

// ---- Metrics ---------------------------------------------------------------

function computeTlaMetrics(variables, actions, invariants, facts) {
  const entityCount = (facts?.entities || []).length;
  const statefulEntities = (facts?.entities || []).filter(e => STATEFUL_TYPES.has(e.type) || ACTOR_TYPES.has(e.type)).length;
  const failurePathCount = (facts?.failurePaths || []).length;

  return {
    variableCount: variables.length,
    actionCount: actions.length,
    invariantCount: invariants.length,
    entityCoverage: entityCount > 0 ? +(statefulEntities / entityCount).toFixed(3) : 0,
    invariantCoverage: failurePathCount > 0 ? +(invariants.length / failurePathCount).toFixed(3) : 1,
    stateSpaceEstimate: variables.reduce((acc, v) => acc * v.states.length, 1),
  };
}

// ---- Subsystem-Level Splitting ---------------------------------------------

/**
 * Split a large architecture into independent TLA+ submodules by boundary.
 * Each boundary gets its own self-contained module with only its entities,
 * internal actions, and relevant invariants. A master module EXTENDS all
 * submodules and defines cross-boundary actions + the global Spec.
 *
 * Falls back to the single-module path when boundaries < 2.
 *
 * @param {object} facts
 * @param {object} plan
 * @param {string} masterModuleName
 * @returns {{ submodules: Array<{name, tlaSource, cfgSource}>, masterModule: {name, tlaSource, cfgSource} }}
 */
function factsToTlaSubmodules(facts, plan, masterModuleName) {
  const boundaries = facts?.boundaries || [];

  if (boundaries.length < 2) {
    const result = factsToTlaModule(facts, plan, masterModuleName);
    const cfg = factsToTlaCfg(result.invariants, masterModuleName);
    return {
      submodules: [],
      masterModule: { name: masterModuleName, tlaSource: result.tlaSource, cfgSource: cfg },
    };
  }

  const entities = facts?.entities || [];
  const relationships = facts?.relationships || [];
  const failurePaths = facts?.failurePaths || [];

  const entityMap = {};
  for (const e of entities) {
    entityMap[e.name] = mapEntityToVariable(e);
  }

  const memberToBoundary = new Map();
  for (const b of boundaries) {
    for (const member of (b.members || [])) {
      memberToBoundary.set(member, b.name);
    }
  }

  const boundaryEntities = new Map();
  const unboundedEntities = [];
  for (const e of entities) {
    const bName = memberToBoundary.get(e.name) || memberToBoundary.get(_sanitizeId(e.name));
    if (bName) {
      if (!boundaryEntities.has(bName)) boundaryEntities.set(bName, []);
      boundaryEntities.get(bName).push(e);
    } else {
      unboundedEntities.push(e);
    }
  }

  const submodules = [];

  for (const [bName, bEntities] of boundaryEntities) {
    const bEntityNames = new Set(bEntities.map(e => e.name));
    const bEntityIds = new Set(bEntities.map(e => _sanitizeId(e.name)));
    const subName = `${masterModuleName}_${_sanitizeId(bName)}`;

    const bRels = relationships.filter(r => bEntityNames.has(r.from) && bEntityNames.has(r.to));
    const bFPs = failurePaths.filter(fp => bEntityNames.has(fp.trigger) || bEntityNames.has(fp.handler));

    const subFacts = {
      entities: bEntities,
      relationships: bRels,
      boundaries: [],
      failurePaths: bFPs,
    };

    const result = factsToTlaModule(subFacts, plan, subName);
    const cfg = factsToTlaCfg(result.invariants, subName);

    submodules.push({
      name: subName,
      boundary: bName,
      tlaSource: result.tlaSource,
      cfgSource: cfg,
      variables: result.variables,
      actions: result.actions,
      invariants: result.invariants,
    });
  }

  const allSubVars = new Set();
  const allSubActions = new Set();
  for (const sub of submodules) {
    for (const v of sub.variables) allSubVars.add(v.id);
    for (const a of sub.actions) allSubActions.add(a.actionName);
  }

  const crossRels = relationships.filter(r => {
    const fromB = memberToBoundary.get(r.from);
    const toB = memberToBoundary.get(r.to);
    return fromB !== toB || !fromB;
  });

  const masterVars = unboundedEntities.map(e => entityMap[e.name]).filter(v => v && v.isStateful);
  const crossActions = crossRels.map(r => mapRelationshipToAction(r, entityMap));
  const crossFPs = failurePaths.filter(fp => {
    const tB = memberToBoundary.get(fp.trigger);
    const hB = memberToBoundary.get(fp.handler);
    return tB !== hB || !tB;
  });
  const crossInvariants = crossFPs.map((fp, i) => mapFailurePathToInvariant(fp, entityMap, i));

  const allVariables = [];
  for (const sub of submodules) allVariables.push(...sub.variables);
  allVariables.push(...masterVars);

  const allActions = [];
  for (const sub of submodules) allActions.push(...sub.actions);
  allActions.push(...crossActions);

  const allInvariants = [];
  for (const sub of submodules) allInvariants.push(...sub.invariants);
  allInvariants.push(...crossInvariants);

  const masterLines = [];
  const date = new Date().toISOString().split('T')[0];

  masterLines.push(`${'-'.repeat(22)} MODULE ${masterModuleName} ${'-'.repeat(22)}`);
  masterLines.push(`(${'*'.repeat(74)}`);
  masterLines.push(` * ${masterModuleName} — Master Specification (boundary-split)`);
  masterLines.push(` * Date: ${date}`);
  masterLines.push(` * Submodules: ${submodules.map(s => s.name).join(', ')}`);
  masterLines.push(` ${'*'.repeat(74)})`);
  masterLines.push(``);
  masterLines.push(`EXTENDS Naturals`);
  masterLines.push(``);

  masterLines.push(`\\* All variables across all subsystems`);
  masterLines.push(`VARIABLES`);
  const allVarDecls = allVariables.map((v, i) => {
    const comma = i < allVariables.length - 1 ? ',' : '';
    return `  ${v.id}${comma}    \\* ${v.name} (${v.type})`;
  });
  masterLines.push(...allVarDecls);
  masterLines.push(``);
  masterLines.push(`vars == <<${allVariables.map(v => v.id).join(', ')}>>`);
  masterLines.push(``);

  for (const v of allVariables) {
    masterLines.push(`${v.id}_States == ${v.stateSet}`);
  }
  masterLines.push(``);

  masterLines.push(`TypeInvariant ==`);
  for (const v of allVariables) {
    masterLines.push(`  /\\ ${v.id} \\in ${v.id}_States`);
  }
  masterLines.push(``);

  for (const inv of allInvariants) {
    masterLines.push(`${inv.name} ==`);
    masterLines.push(`  ${inv.tlaExpr}`);
    masterLines.push(``);
  }

  masterLines.push(`MasterSafety ==`);
  masterLines.push(`  /\\ TypeInvariant`);
  for (const inv of allInvariants) {
    masterLines.push(`  /\\ ${inv.name}`);
  }
  masterLines.push(``);

  masterLines.push(`Init ==`);
  for (const v of allVariables) {
    masterLines.push(`  /\\ ${v.id} = ${v.initState}`);
  }
  masterLines.push(``);

  masterLines.push(`\\* Cross-boundary actions`);
  for (const action of crossActions) {
    masterLines.push(``);
    masterLines.push(`${action.actionName} ==`);
    masterLines.push(`  /\\ ${action.precondition}`);
    masterLines.push(`  /\\ ${action.fromEffect}`);
    masterLines.push(`  /\\ ${action.toEffect}`);
    const unchanged = allVariables
      .filter(v => v.id !== action.fromId && v.id !== action.toId)
      .map(v => v.id);
    if (unchanged.length > 0) {
      masterLines.push(`  /\\ UNCHANGED <<${unchanged.join(', ')}>>`);
    }
  }
  masterLines.push(``);

  masterLines.push(`Next ==`);
  if (allActions.length > 0) {
    for (const a of allActions) {
      masterLines.push(`  \\/ ${a.actionName}`);
    }
  } else {
    masterLines.push(`  UNCHANGED vars`);
  }
  masterLines.push(``);

  masterLines.push(`Spec == Init /\\ [][Next]_vars`);
  masterLines.push(``);
  masterLines.push(`THEOREM Spec => []MasterSafety`);
  masterLines.push(``);
  masterLines.push(`${'='.repeat(68)}`);

  const masterTlaSource = masterLines.join('\n');
  const masterCfgSource = factsToTlaCfg(allInvariants, masterModuleName);

  logger.info('tla_compiler.submodules_generated', {
    masterModuleName,
    submoduleCount: submodules.length,
    totalVariables: allVariables.length,
    crossActions: crossActions.length,
    crossInvariants: crossInvariants.length,
  });

  return {
    submodules: submodules.map(s => ({
      name: s.name,
      boundary: s.boundary,
      tlaSource: s.tlaSource,
      cfgSource: s.cfgSource,
    })),
    masterModule: {
      name: masterModuleName,
      tlaSource: masterTlaSource,
      cfgSource: masterCfgSource,
    },
  };
}

module.exports = {
  factsToTlaModule,
  factsToTlaCfg,
  factsToTlaSubmodules,
  mapEntityToVariable,
  mapRelationshipToAction,
  mapFailurePathToInvariant,
  computeTlaMetrics,
  _sanitizeId,
};
