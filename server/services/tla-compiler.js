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
  const actions = relationships.map(r => mapRelationshipToAction(r, entityMap));
  const invariants = failurePaths.map((fp, i) => mapFailurePathToInvariant(fp, entityMap, i));

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
  lines.push(`EXTENDS Naturals, Sequences, FiniteSets`);
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
    }
  }

  const actionsByBoundary = new Map();
  for (const action of actions) {
    const boundary = boundaryMembers.get(action.fromId) || 'Global';
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

  // ---- Formal Verification Theorems (Lamport style) ----
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(`\\* FORMAL VERIFICATION THEOREMS`);
  lines.push(`\\* ${'='.repeat(70)}`);
  lines.push(``);
  lines.push(`THEOREM Spec => []TypeInvariant`);
  lines.push(`  \\* Type safety: all entities remain in legal state sets`);
  lines.push(``);
  lines.push(`THEOREM Spec => []MasterSafety`);
  lines.push(`  \\* Comprehensive safety: all invariants hold in all reachable states`);
  lines.push(``);
  for (const inv of invariants) {
    lines.push(`THEOREM Spec => []${inv.name}`);
    lines.push(`  \\* ${inv.trigger} ${inv.condition}: ${inv.handler} handles with ${inv.recovery}`);
    lines.push(``);
  }

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

module.exports = {
  factsToTlaModule,
  factsToTlaCfg,
  mapEntityToVariable,
  mapRelationshipToAction,
  mapFailurePathToInvariant,
  computeTlaMetrics,
  _sanitizeId,
};
