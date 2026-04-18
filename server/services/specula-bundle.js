'use strict';

const tlaCompiler = require('./tla-compiler');
const SPECULA_REFERENCE = require('./specula-reference');

function _jsonSpecula(obj) {
  return process.env.MERMATE_SPECULA_JSON_PRETTY === '1'
    ? JSON.stringify(obj, null, 2)
    : JSON.stringify(obj);
}

function _slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function _unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function _buildEntityMap(facts) {
  const entityMap = {};
  for (const entity of (facts?.entities || [])) {
    entityMap[entity.name] = tlaCompiler.mapEntityToVariable(entity);
  }
  return entityMap;
}

function _buildActions(facts, entityMap) {
  return (facts?.relationships || []).map((relationship) => (
    tlaCompiler.mapRelationshipToAction(relationship, entityMap)
  ));
}

function _buildInvariants(facts, entityMap) {
  return (facts?.failurePaths || []).map((failurePath, index) => (
    tlaCompiler.mapFailurePathToInvariant(failurePath, entityMap, index)
  ));
}

function _boundaryCrossings(facts) {
  const boundaryByMember = new Map();
  for (const boundary of (facts?.boundaries || [])) {
    for (const member of (boundary.members || [])) {
      boundaryByMember.set(member, boundary.name);
    }
  }

  return (facts?.relationships || []).filter((relationship) => {
    const fromBoundary = boundaryByMember.get(relationship.from);
    const toBoundary = boundaryByMember.get(relationship.to);
    return fromBoundary && toBoundary && fromBoundary !== toBoundary;
  });
}

function deriveBugFamilies(ctx) {
  const families = [];
  const facts = ctx.facts || {};
  const relationships = facts.relationships || [];
  const failurePaths = facts.failurePaths || [];
  const entities = facts.entities || [];
  const crossings = _boundaryCrossings(facts);
  const asyncRelationships = relationships.filter((relationship) => relationship.edgeType === 'async');
  const statefulEntities = entities.filter((entity) => (
    ['service', 'gateway', 'store', 'cache', 'queue', 'broker', 'actor', 'external'].includes(entity.type)
  ));
  const interactionBindings = ctx.tsxManifest?.interactions || [];

  if (crossings.length > 0) {
    families.push({
      id: 'family-boundary-coordination',
      name: 'Boundary Coordination Drift',
      mechanism: 'Cross-boundary request paths can diverge from the intended handoff ordering when control passes between architectural zones.',
      evidence: {
        historical: ['Design-time evidence only: no implementation history exists yet.'],
        code_analysis: crossings.map((relationship) => (
          `${relationship.from} -> ${relationship.to} (${relationship.verb || 'interacts'})`
        )),
      },
      affectedCodePaths: _unique(crossings.flatMap((relationship) => {
        const actionName = interactionBindings.find((binding) => binding.from === relationship.from && binding.to === relationship.to)?.actionName;
        return actionName ? [`planned:${actionName}`] : [];
      })),
      suggestedModelingApproach: {
        variables: ['boundaryPhase'],
        actions: crossings.map((relationship) => `${relationship.from} -> ${relationship.to}`),
        granularity: 'Split each cross-boundary relationship into an explicit handoff action.',
      },
      priority: 'High',
      rationale: 'Cross-boundary coordination is the most common source of underspecified behavior in the current pipeline.',
      targets: ['MasterSafety'],
    });
  }

  if (failurePaths.length > 0) {
    families.push({
      id: 'family-recovery-guards',
      name: 'Recovery Guard Coverage',
      mechanism: 'Failure and recovery logic can drift unless every named failure path becomes an explicit invariant and recovery expectation.',
      evidence: {
        historical: ['Design-time evidence only: recovery paths were extracted from the authored architecture.'],
        code_analysis: failurePaths.map((failurePath) => (
          `${failurePath.trigger}: ${failurePath.condition} -> ${failurePath.handler} / ${failurePath.recovery}`
        )),
      },
      affectedCodePaths: failurePaths.map((failurePath) => `planned:${failurePath.trigger}`),
      suggestedModelingApproach: {
        variables: ['recoveryState'],
        actions: failurePaths.map((failurePath) => failurePath.trigger || 'unknown'),
        granularity: 'Keep trigger and recovery as separate action steps so TLC can distinguish normal flow from degraded flow.',
      },
      priority: 'High',
      rationale: 'The current TLA path already extracts failure paths; formalizing them as a family preserves traceability into hunting configs.',
      targets: (ctx.invariants || []).map((invariant) => invariant.name),
    });
  }

  if (asyncRelationships.length > 0) {
    families.push({
      id: 'family-async-delivery',
      name: 'Async Delivery and Ordering',
      mechanism: 'Asynchronous edges need delivery bounds and replay assumptions so model checking can separate queueing behavior from application logic.',
      evidence: {
        historical: ['Design-time evidence only: asynchronous relationships were inferred from the architecture plan.'],
        code_analysis: asyncRelationships.map((relationship) => (
          `${relationship.from} -> ${relationship.to} (${relationship.verb || 'async'})`
        )),
      },
      affectedCodePaths: asyncRelationships.map((relationship) => `planned:${relationship.from}->${relationship.to}`),
      suggestedModelingApproach: {
        variables: ['deliveryBudget', 'messageQueue'],
        actions: asyncRelationships.map((relationship) => relationship.verb || 'async_delivery'),
        granularity: 'Bound only delivery and fault-injection actions; keep deterministic reactions unbounded.',
      },
      priority: 'Medium',
      rationale: 'Async paths need dedicated MC bounds or the state space will grow without exposing meaningful faults.',
      targets: ['CounterBounded', 'MasterSafety'],
    });
  }

  if (statefulEntities.length > 0) {
    families.push({
      id: 'family-state-lifecycle',
      name: 'State Lifecycle Alignment',
      mechanism: 'Stateful entities need explicit type and lifecycle guards so the TSX scaffold, the base model, and the future runtime stay aligned.',
      evidence: {
        historical: ['Design-time evidence only: stateful entities were extracted from the architecture.'],
        code_analysis: statefulEntities.map((entity) => `${entity.name} (${entity.type})`),
      },
      affectedCodePaths: statefulEntities.map((entity) => entity.name),
      suggestedModelingApproach: {
        variables: statefulEntities.map((entity) => tlaCompiler.mapEntityToVariable(entity).id),
        actions: ['Init', 'Next', 'TypeInvariant'],
        granularity: 'Model each stateful entity as a first-class variable with explicit legal-state sets.',
      },
      priority: 'Medium',
      rationale: 'This family keeps the TSX architecture manifest and the TLA variables synchronized as the repo evolves.',
      targets: ['TypeInvariant'],
    });
  }

  return families;
}

function buildModelingBrief(ctx) {
  const facts = ctx.facts || {};
  const families = deriveBugFamilies(ctx);
  const extensions = families.map((family) => ({
    extension: family.name,
    variables: family.suggestedModelingApproach.variables,
    purpose: family.mechanism,
    bugFamily: family.id,
  }));

  const invariants = _unique([
    'TypeInvariant',
    'MasterSafety',
    ...(ctx.invariants || []).map((invariant) => invariant.name),
  ]).map((name) => ({
    name,
    type: name === 'TraceMatched' ? 'Liveness' : 'Safety',
    description: name === 'TypeInvariant'
      ? 'All stateful variables remain within their legal state sets.'
      : name === 'MasterSafety'
        ? 'All extracted recovery and safety rules hold across enabled transitions.'
        : `Recovered invariant derived from extracted failure path: ${name}.`,
    targets: families.filter((family) => family.targets.includes(name)).map((family) => family.id),
  }));

  return {
    version: '1.0.0',
    upstream: SPECULA_REFERENCE,
    systemOverview: {
      systemName: ctx.diagramName,
      language: 'TypeScript-first architecture scaffold with Python and Rust synthesis targets',
      scale: {
        entities: (facts.entities || []).length,
        relationships: (facts.relationships || []).length,
        boundaries: (facts.boundaries || []).length,
      },
      protocol: 'Mermate artifact pipeline from idea to markdown, Mermaid, TSX scaffold, and TLA+ specification bundle',
      keyArchitecturalChoices: [
        'TSX scaffold is treated as a structured intermediate instead of a terminal UI artifact.',
        'Specula-derived outputs are emitted as first-class artifacts beside the base TLA module.',
        'Trace validation, model checking, and instrumentation planning are kept as separate but linked files.',
      ],
      concurrencyModel: 'Event-graph driven architecture derived from Mermaid relationships and failure paths.',
    },
    bugFamilies: families,
    modelingRecommendations: {
      model: families.map((family) => ({
        what: family.name,
        why: family.rationale,
        how: family.suggestedModelingApproach,
      })),
      doNotModel: [
        {
          what: 'Styling-only TSX concerns',
          why: 'Formal specification should target behavioral semantics, not presentational CSS decisions.',
        },
        {
          what: 'Unimplemented infra details outside the extracted architecture',
          why: 'The current pipeline has no concrete runtime code for those behaviors yet; modeling them would create unjustified hidden state.',
        },
      ],
    },
    proposedExtensions: extensions,
    proposedInvariants: invariants,
    findingsPendingVerification: {
      modelCheckable: families.map((family) => ({
        id: `${family.id}-mc`,
        description: family.mechanism,
        expectedInvariantViolation: family.targets[0] || 'MasterSafety',
        bugFamily: family.id,
      })),
      testVerifiable: [
        {
          id: 'tsx-shell-render',
          description: 'Verify the generated TSX scaffold renders all extracted components and boundaries.',
          suggestedTestApproach: 'Render the generated `src/App.tsx` with fixture manifests and assert component/boundary counts.',
        },
      ],
      codeReviewOnly: [
        {
          id: 'polyglot-boundaries',
          description: 'Confirm the Python and Rust build targets remain justified for the concrete repo that gets synthesized later.',
          suggestedAction: 'Review generated repo boundaries before implementation begins.',
        },
      ],
    },
    referencePointers: {
      markdownArtifact: ctx.markdownPath || null,
      tsxManifestPath: ctx.tsxPaths?.manifest || null,
      runId: ctx.runId || null,
    },
  };
}

function renderModelingBriefMarkdown(brief) {
  const lines = [
    '# Modeling Brief',
    '',
    '## 1. System Overview',
    '',
    `- System name: ${brief.systemOverview.systemName}`,
    `- Language / targets: ${brief.systemOverview.language}`,
    `- Scale: ${brief.systemOverview.scale.entities} entities, ${brief.systemOverview.scale.relationships} relationships, ${brief.systemOverview.scale.boundaries} boundaries`,
    `- Protocol: ${brief.systemOverview.protocol}`,
    `- Concurrency model: ${brief.systemOverview.concurrencyModel}`,
    '',
    '## 2. Bug Families',
    '',
  ];

  for (const family of brief.bugFamilies) {
    lines.push(`### ${family.name}`);
    lines.push('');
    lines.push(`**Mechanism**: ${family.mechanism}`);
    lines.push('');
    lines.push('**Evidence**:');
    lines.push(...family.evidence.historical.map((item) => `- Historical: ${item}`));
    lines.push(...family.evidence.code_analysis.map((item) => `- Code analysis: ${item}`));
    lines.push('');
    lines.push(`**Affected code paths**: ${family.affectedCodePaths.join(', ') || 'n/a'}`);
    lines.push('');
    lines.push('**Suggested modeling approach**:');
    lines.push(`- Variables: ${family.suggestedModelingApproach.variables.join(', ') || 'none'}`);
    lines.push(`- Actions: ${family.suggestedModelingApproach.actions.join(', ') || 'none'}`);
    lines.push(`- Granularity: ${family.suggestedModelingApproach.granularity}`);
    lines.push('');
    lines.push(`**Priority**: ${family.priority}`);
    lines.push(`**Rationale**: ${family.rationale}`);
    lines.push('');
  }

  lines.push('## 3. Modeling Recommendations');
  lines.push('');
  lines.push('### 3.1 Model');
  lines.push('');
  for (const item of brief.modelingRecommendations.model) {
    lines.push(`- **${item.what}**: ${item.why}`);
    lines.push(`  How: ${item.how.granularity}`);
  }
  lines.push('');
  lines.push('### 3.2 Do Not Model');
  lines.push('');
  for (const item of brief.modelingRecommendations.doNotModel) {
    lines.push(`- **${item.what}**: ${item.why}`);
  }
  lines.push('');
  lines.push('## 4. Proposed Extensions');
  lines.push('');
  lines.push('| Extension | Variables | Purpose | Bug Family |');
  lines.push('|-----------|-----------|---------|------------|');
  for (const extension of brief.proposedExtensions) {
    lines.push(`| ${extension.extension} | ${extension.variables.join(', ') || 'none'} | ${extension.purpose} | ${extension.bugFamily} |`);
  }
  lines.push('');
  lines.push('## 5. Proposed Invariants');
  lines.push('');
  lines.push('| Invariant | Type | Description | Targets |');
  lines.push('|-----------|------|-------------|---------|');
  for (const invariant of brief.proposedInvariants) {
    lines.push(`| ${invariant.name} | ${invariant.type} | ${invariant.description} | ${invariant.targets.join(', ') || 'global'} |`);
  }
  lines.push('');
  lines.push('## 6. Findings Pending Verification');
  lines.push('');
  lines.push('### 6.1 Model-Checkable');
  lines.push('');
  for (const finding of brief.findingsPendingVerification.modelCheckable) {
    lines.push(`- ${finding.id}: ${finding.description} -> ${finding.expectedInvariantViolation}`);
  }
  lines.push('');
  lines.push('### 6.2 Test-Verifiable');
  lines.push('');
  for (const finding of brief.findingsPendingVerification.testVerifiable) {
    lines.push(`- ${finding.id}: ${finding.description} (${finding.suggestedTestApproach})`);
  }
  lines.push('');
  lines.push('### 6.3 Code-Review-Only');
  lines.push('');
  for (const finding of brief.findingsPendingVerification.codeReviewOnly) {
    lines.push(`- ${finding.id}: ${finding.description} (${finding.suggestedAction})`);
  }
  lines.push('');
  lines.push('## 7. Reference Pointers');
  lines.push('');
  lines.push(`- Markdown artifact: ${brief.referencePointers.markdownArtifact || 'n/a'}`);
  lines.push(`- TSX manifest: ${brief.referencePointers.tsxManifestPath || 'n/a'}`);
  lines.push(`- Run ID: ${brief.referencePointers.runId || 'n/a'}`);
  lines.push('');

  return lines.join('\n');
}

function _unchangedClause(variableIds, changedIds) {
  const unchanged = variableIds.filter((id) => !changedIds.includes(id));
  if (unchanged.length === 0) return null;
  if (unchanged.length === 1) return `UNCHANGED ${unchanged[0]}`;
  return `UNCHANGED <<${unchanged.join(', ')}>>`;
}

function buildMcModule(ctx) {
  const variableIds = ctx.variables.map((variable) => variable.id);
  const actionNames = ctx.actions.map((action) => `"${action.actionName}"`);
  const lines = [
    `---------------------- MODULE ${ctx.moduleName}MC ----------------------`,
    '',
    'EXTENDS Naturals, Sequences, FiniteSets',
    '',
    'CONSTANT ActionBudgetLimit',
    '',
    'VARIABLES',
    ...ctx.variables.map((variable) => `  ${variable.id},`),
    `  actionBudget`,
    '',
    `vars == <<${[...variableIds, 'actionBudget'].join(', ')}>>`,
    '',
    ...ctx.variables.map((variable) => `${variable.id}_States == ${variable.stateSet}`),
    '',
    `ActionNames == {${actionNames.join(', ') || '"__noop__"'}}`,
    '',
    'TypeInvariant ==',
    ...ctx.variables.map((variable) => `  /\\ ${variable.id} \\in ${variable.id}_States`),
    '  /\\ actionBudget \\in [ActionNames -> 0..ActionBudgetLimit]',
    '',
    'CounterBounded ==',
    '  \\A a \\in ActionNames: actionBudget[a] <= ActionBudgetLimit',
    '',
    ...(ctx.invariants || []).flatMap((invariant) => [
      `${invariant.name} ==`,
      `  ${invariant.tlaExpr}`,
      '',
    ]),
    'MasterSafety ==',
    '  /\\ TypeInvariant',
    '  /\\ CounterBounded',
    ...(ctx.invariants || []).map((invariant) => `  /\\ ${invariant.name}`),
    '',
    'Init ==',
    ...ctx.variables.map((variable) => `  /\\ ${variable.id} = ${variable.initState}`),
    '  /\\ actionBudget = [a \\in ActionNames |-> 0]',
    '',
  ];

  if (ctx.actions.length === 0) {
    lines.push('NoOp ==');
    lines.push('  /\\ UNCHANGED vars');
    lines.push('');
    lines.push('Next == NoOp');
  } else {
    for (const action of ctx.actions) {
      const changedIds = _unique([action.fromId, action.toId]);
      const unchanged = _unchangedClause(variableIds, changedIds);

      lines.push(`${action.actionName} ==`);
      lines.push(`  /\\ actionBudget["${action.actionName}"] < ActionBudgetLimit`);
      lines.push(`  /\\ ${action.precondition}`);
      lines.push(`  /\\ ${action.fromEffect}`);
      lines.push(`  /\\ ${action.toEffect}`);
      lines.push(`  /\\ actionBudget' = [actionBudget EXCEPT !["${action.actionName}"] = @ + 1]`);
      if (unchanged) lines.push(`  /\\ ${unchanged}`);
      lines.push('');
    }

    lines.push('Next ==');
    lines.push(`  \\/ ${ctx.actions.map((action) => action.actionName).join('\n  \\/ ')}`);
  }

  lines.push('');
  lines.push('Spec == Init /\\ [][Next]_vars');
  lines.push('');
  lines.push('====');

  const cfgLines = [
    'SPECIFICATION Spec',
    'CONSTANT ActionBudgetLimit = 2',
    'INVARIANT TypeInvariant',
    'INVARIANT CounterBounded',
    ...(ctx.invariants || []).map((invariant) => `INVARIANT ${invariant.name}`),
    'CHECK_DEADLOCK FALSE',
    '',
  ];

  return {
    moduleName: `${ctx.moduleName}MC`,
    source: lines.join('\n'),
    cfgSource: cfgLines.join('\n'),
  };
}

function buildTraceModule(ctx) {
  const variableIds = ctx.variables.map((variable) => variable.id);
  const lines = [
    `---------------------- MODULE ${ctx.moduleName}Trace ----------------------`,
    '',
    'EXTENDS Naturals, Sequences, FiniteSets',
    '',
    'VARIABLES',
    ...ctx.variables.map((variable) => `  ${variable.id},`),
    '  l',
    '',
    `vars == <<${[...variableIds, 'l'].join(', ')}>>`,
    '',
    ...ctx.variables.map((variable) => `${variable.id}_States == ${variable.stateSet}`),
    '',
    'TraceLog == << >>',
    '',
    'TypeInvariant ==',
    ...ctx.variables.map((variable) => `  /\\ ${variable.id} \\in ${variable.id}_States`),
    '  /\\ l \\in Nat',
    '',
    ...(ctx.invariants || []).flatMap((invariant) => [
      `${invariant.name} ==`,
      `  ${invariant.tlaExpr}`,
      '',
    ]),
    'TraceInit ==',
    ...ctx.variables.map((variable) => `  /\\ ${variable.id} = ${variable.initState}`),
    '  /\\ l = 1',
    '',
  ];

  if (ctx.actions.length === 0) {
    lines.push('TraceStep ==');
    lines.push('  /\\ UNCHANGED vars');
  } else {
    for (const action of ctx.actions) {
      const changedIds = _unique([action.fromId, action.toId]);
      const unchanged = _unchangedClause(variableIds, changedIds);
      lines.push(`${action.actionName}_Trace ==`);
      lines.push('  /\\ l <= Len(TraceLog)');
      lines.push(`  /\\ LET evt == TraceLog[l] IN evt.name = "${action.actionName}"`);
      lines.push(`  /\\ ${action.precondition}`);
      lines.push(`  /\\ ${action.fromEffect}`);
      lines.push(`  /\\ ${action.toEffect}`);
      lines.push(`  /\\ l' = l + 1`);
      if (unchanged) lines.push(`  /\\ ${unchanged}`);
      lines.push('');
    }

    lines.push('TraceSilent ==');
    lines.push('  /\\ l > Len(TraceLog)');
    lines.push(`  /\\ UNCHANGED <<${variableIds.join(', ')}>>`);
    lines.push('');
    lines.push('TraceStep ==');
    lines.push(`  \\/ ${ctx.actions.map((action) => `${action.actionName}_Trace`).join('\n  \\/ ')}`);
    lines.push('  \\/ TraceSilent');
  }

  lines.push('');
  lines.push('Spec == TraceInit /\\ [][TraceStep]_vars');
  lines.push('TraceMatched == <>(l > Len(TraceLog))');
  lines.push('');
  lines.push('====');

  const cfgLines = [
    'SPECIFICATION Spec',
    'INVARIANT TypeInvariant',
    ...(ctx.invariants || []).map((invariant) => `INVARIANT ${invariant.name}`),
    'PROPERTY TraceMatched',
    'CHECK_DEADLOCK FALSE',
    '',
  ];

  return {
    moduleName: `${ctx.moduleName}Trace`,
    source: lines.join('\n'),
    cfgSource: cfgLines.join('\n'),
  };
}

function buildInstrumentationSpec(ctx, modelingBrief) {
  const planned = ctx.tsxManifest?.plannedModules || [];
  const lines = [
    '# Instrumentation Spec',
    '',
    '## Section 1: Trace Event Schema',
    '',
    '- Event envelope: `name`, `step`, `timestamp`, `source`, `target`, `state`',
    '- State fields: each stateful entity variable emitted from the generated runtime or the eventual implementation module',
    '- Message fields: `verb`, `edgeType`, `recovery`, `condition` when available',
    '',
    '## Section 2: Action-to-Code Mapping',
    '',
    '| Spec action | Code location | Trigger point | Trace event | Fields | Notes |',
    '|-------------|---------------|---------------|-------------|--------|-------|',
  ];

  for (const action of ctx.actions) {
    const fromId = action.fromId;
    const slugFrom = _slug(fromId);
    let binding = null;
    for (let i = 0; i < planned.length; i++) {
      const modulePlan = planned[i];
      if (modulePlan.purpose?.includes(fromId)) {
        binding = modulePlan;
        break;
      }
    }
    if (!binding) {
      for (let i = 0; i < planned.length; i++) {
        const modulePlan = planned[i];
        if (modulePlan.path?.includes(slugFrom)) {
          binding = modulePlan;
          break;
        }
      }
    }
    const codeLocation = binding?.path || `planned:src/runtime/${_slug(action.actionName)}.ts`;
    lines.push(`| ${action.actionName} | ${codeLocation} | after state transition | ${action.actionName} | source,target,state | Derived from Mermaid relationship ${action.fromId} -> ${action.toId} |`);
  }

  lines.push('');
  lines.push('## Section 3: Special Considerations');
  lines.push('');
  lines.push('- TSX scaffold is the current implementation-facing source of truth; instrumentation hooks should preserve its component and boundary names.');
  lines.push('- Python and Rust targets remain planned synthesis outputs until a concrete repo is generated from this bundle.');
  lines.push(`- Modeling brief families covered: ${modelingBrief.bugFamilies.map((family) => family.name).join(', ') || 'none'}`);
  lines.push('');

  return lines.join('\n');
}

function classifyViolation(violation) {
  if (!violation || typeof violation !== 'object') {
    return 'underspecified_behavior';
  }
  if ((violation.traceLength || 0) === 0) {
    return 'model_bug';
  }
  if (/TypeInvariant/i.test(violation.invariant || '')) {
    return 'model_bug';
  }
  if (/Safety_/i.test(violation.invariant || '')) {
    return 'underspecified_behavior';
  }
  return 'known_issue';
}

function buildValidationLoop(ctx) {
  return {
    traceValidation: {
      status: 'pending_trace_input',
      objective: 'Replay real execution traces against the generated Trace spec before expanding model-check bounds.',
      traceSpec: `${ctx.moduleName}Trace`,
      successCriteria: [
        'Every observed transition advances the trace cursor.',
        'No post-state mismatch appears between the trace and the model.',
      ],
    },
    modelChecking: {
      status: ctx.validation?.tlc?.checked
        ? (ctx.validation?.tlc?.success ? 'completed_clean' : 'completed_with_findings')
        : 'pending',
      objective: 'Explore bounded state space and classify counterexamples.',
      statesExplored: ctx.validation?.tlc?.statesExplored || 0,
      counterexamples: (ctx.validation?.tlc?.violations || []).map((violation) => ({
        invariant: violation.invariant,
        traceLength: violation.traceLength,
        initialClassification: classifyViolation(violation),
      })),
    },
    classificationPolicy: [
      { label: 'code_bug', when: 'Real traces reproduce the counterexample and the model matches observed behavior.' },
      { label: 'model_bug', when: 'The counterexample depends on impossible states or empty traces.' },
      { label: 'known_issue', when: 'The behavior is already accepted and documented.' },
      { label: 'underspecified_behavior', when: 'The current architecture or scaffold lacks enough detail to decide.' },
    ],
    loop: [
      'Run trace validation first to eliminate model-code drift.',
      'Run model checking with the current MC config and any hunt configs.',
      'Classify each counterexample and feed the result back into the modeling brief or the implementation plan.',
    ],
  };
}

function buildSpeculaBundle(ctx) {
  const modelingBrief = buildModelingBrief(ctx);
  const modelingBriefMarkdown = renderModelingBriefMarkdown(modelingBrief);
  const mc = buildMcModule(ctx);
  const trace = buildTraceModule(ctx);
  const instrumentationMarkdown = buildInstrumentationSpec(ctx, modelingBrief);
  const validationLoop = buildValidationLoop(ctx);

  const huntConfigs = modelingBrief.bugFamilies.map((family) => ({
    id: family.id,
    fileName: `MC_hunt_${_slug(family.name)}.cfg`,
    cfgSource: [
      'SPECIFICATION Spec',
      'CONSTANT ActionBudgetLimit = 2',
      'INVARIANT TypeInvariant',
      ...(family.targets || []).filter((target) => target !== 'CounterBounded').map((target) => `INVARIANT ${target}`),
      'CHECK_DEADLOCK FALSE',
      '',
    ].join('\n'),
  }));

  const files = [
    { relativePath: 'specula/modeling-brief.md', content: modelingBriefMarkdown },
    { relativePath: 'specula/modeling-brief.json', content: _jsonSpecula(modelingBrief) },
    { relativePath: 'specula/base.tla', content: ctx.baseTlaSource },
    { relativePath: 'specula/base.cfg', content: ctx.baseCfgSource },
    { relativePath: 'specula/MC.tla', content: mc.source },
    { relativePath: 'specula/MC.cfg', content: mc.cfgSource },
    { relativePath: 'specula/Trace.tla', content: trace.source },
    { relativePath: 'specula/Trace.cfg', content: trace.cfgSource },
    { relativePath: 'specula/instrumentation-spec.md', content: instrumentationMarkdown },
    { relativePath: 'specula/validation-loop.json', content: _jsonSpecula(validationLoop) },
    { relativePath: 'specula/index.json', content: _jsonSpecula({
      upstream: SPECULA_REFERENCE,
      generatedAt: new Date().toISOString(),
      files: [
        'modeling-brief.md',
        'modeling-brief.json',
        'base.tla',
        'base.cfg',
        'MC.tla',
        'MC.cfg',
        'Trace.tla',
        'Trace.cfg',
        'instrumentation-spec.md',
        'validation-loop.json',
        ...huntConfigs.map((config) => config.fileName),
      ],
    }) },
    ...huntConfigs.map((config) => ({
      relativePath: `specula/${config.fileName}`,
      content: config.cfgSource,
    })),
  ];

  return {
    upstream: SPECULA_REFERENCE,
    modelingBrief,
    modelingBriefMarkdown,
    mc,
    trace,
    instrumentationMarkdown,
    validationLoop,
    huntConfigs,
    files,
  };
}

module.exports = {
  deriveBugFamilies,
  buildModelingBrief,
  renderModelingBriefMarkdown,
  buildSpeculaBundle,
  classifyViolation,
};
