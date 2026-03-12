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
  const actions = relationships.map(r => mapRelationshipToAction(r, entityMap));
  const invariants = failurePaths.map((fp, i) => mapFailurePathToInvariant(fp, entityMap, i));

  const lines = [];

  // Header
  lines.push(`${'----'} MODULE ${moduleName} ${'----'}`);
  lines.push(`EXTENDS Naturals, Sequences, FiniteSets`);
  lines.push(``);

  // Variables
  lines.push(`\\* --- Variables: one per stateful architectural entity ---`);
  lines.push(`VARIABLES`);
  const varDecls = variables.map((v, i) => {
    const comma = i < variables.length - 1 ? ',' : '';
    return `  ${v.id}${comma}    \\* ${v.name} (${v.type})`;
  });
  lines.push(...varDecls);
  lines.push(``);
  lines.push(`vars == <<${variables.map(v => v.id).join(', ')}>>`);
  lines.push(``);

  // Type invariant
  lines.push(`\\* --- Type Invariant: legal state values for each entity ---`);
  lines.push(`TypeInvariant ==`);
  const typeConstraints = variables.map((v, i) => {
    const prefix = i === 0 ? '  /\\ ' : '  /\\ ';
    return `${prefix}${v.id} \\in ${v.stateSet}`;
  });
  lines.push(...typeConstraints);
  lines.push(``);

  // Init
  lines.push(`\\* --- Initial State ---`);
  lines.push(`Init ==`);
  const initConstraints = variables.map((v, i) => {
    const prefix = i === 0 ? '  /\\ ' : '  /\\ ';
    return `${prefix}${v.id} = ${v.initState}`;
  });
  lines.push(...initConstraints);
  lines.push(``);

  // Actions grouped by boundary
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

  lines.push(`\\* --- Actions: one per architectural relationship ---`);

  for (const [boundary, boundaryActions] of actionsByBoundary) {
    lines.push(``);
    lines.push(`\\* ---- ${boundary} ----`);

    for (const action of boundaryActions) {
      lines.push(``);
      lines.push(`\\* ${action.fromId} ${action.verb} ${action.toId} (${action.edgeType})`);
      lines.push(`${action.actionName} ==`);
      lines.push(`  /\\ ${action.precondition}`);
      lines.push(`  /\\ ${action.fromEffect}`);
      lines.push(`  /\\ ${action.toEffect}`);

      // UNCHANGED for all other variables
      const unchanged = variables
        .filter(v => v.id !== action.fromId && v.id !== action.toId)
        .map(v => v.id);
      if (unchanged.length > 0) {
        lines.push(`  /\\ UNCHANGED <<${unchanged.join(', ')}>>`);
      }
    }
  }
  lines.push(``);

  // Next
  lines.push(`\\* --- Next-State Relation ---`);
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

  // Spec
  lines.push(`\\* --- Specification ---`);
  lines.push(`Spec == Init /\\ [][Next]_vars`);
  lines.push(``);

  // Safety invariants from failure paths
  if (invariants.length > 0) {
    lines.push(`\\* --- Safety Invariants (from failure paths) ---`);
    for (const inv of invariants) {
      lines.push(``);
      lines.push(`\\* ${inv.trigger}: ${inv.condition} => ${inv.handler} handles with ${inv.recovery}`);
      lines.push(`${inv.name} ==`);
      lines.push(`  ${inv.tlaExpr}`);
    }
    lines.push(``);
  }

  // Footer
  lines.push(`${'===='}`);

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
  lines.push(`SPECIFICATION Spec`);
  lines.push(``);
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
