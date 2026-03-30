'use strict';

function _titleCase(text) {
  return String(text || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Architecture Spec';
}

function _firstSentence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Generated architecture bundle.';
  const sentence = clean.match(/.+?[.!?](?:\s|$)/);
  return sentence ? sentence[0].trim() : clean.slice(0, 220);
}

function _uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function _deriveBoundaries(facts, plan) {
  const factBoundaries = (facts?.boundaries || []).map((boundary) => ({
    name: boundary.name,
    members: boundary.members || [],
  }));

  if (factBoundaries.length > 0) return factBoundaries;

  return (plan?.subgraphs || []).map((subgraph) => ({
    name: subgraph.label || subgraph.title || subgraph.id || 'Boundary',
    members: subgraph.members || [],
  }));
}

function _componentLines(facts) {
  const entities = _uniqueBy(
    facts?.entities || [],
    (entity) => `${entity.name}:${entity.type}`,
  );

  if (entities.length === 0) {
    return ['- No typed components were extracted.'];
  }

  return entities.map((entity) => {
    const responsibility = entity.responsibility
      ? `: ${entity.responsibility}`
      : '';
    return `- \`${entity.name}\` (${entity.type})${responsibility}`;
  });
}

function _interactionLines(facts) {
  const relationships = facts?.relationships || [];
  if (relationships.length === 0) {
    return ['1. No explicit interactions were extracted.'];
  }

  return relationships.map((rel, index) => {
    const verb = rel.verb || 'interacts with';
    const edgeType = rel.edgeType ? ` [${rel.edgeType}]` : '';
    return `${index + 1}. \`${rel.from}\` -> \`${rel.to}\` via ${verb}${edgeType}`;
  });
}

function _failureLines(facts) {
  const failurePaths = facts?.failurePaths || [];
  if (failurePaths.length === 0) {
    return ['- No explicit failure path was extracted.'];
  }

  return failurePaths.map((path) => {
    const trigger = path.trigger || 'unknown trigger';
    const condition = path.condition || 'unspecified condition';
    const handler = path.handler || 'unspecified handler';
    const recovery = path.recovery || 'unspecified recovery';
    return `- When \`${trigger}\` hits ${condition}, \`${handler}\` responds with ${recovery}.`;
  });
}

function _boundaryLines(boundaries) {
  if (boundaries.length === 0) {
    return ['- No explicit architectural boundaries were extracted.'];
  }

  return boundaries.map((boundary) => {
    const members = boundary.members?.length
      ? boundary.members.map((member) => `\`${member}\``).join(', ')
      : 'no named members';
    return `- **${boundary.name}**: ${members}`;
  });
}

function _plannedShellLines(boundaries, facts) {
  const entities = facts?.entities || [];

  if (boundaries.length === 0) {
    return [
      `- Render a single architecture workspace with ${entities.length || 'the extracted'} components.`,
      '- Keep the Mermaid source and the generated specification bundle visible side by side.',
    ];
  }

  return boundaries.map((boundary) => {
    const count = boundary.members?.length || 0;
    return `- Create a TSX section for **${boundary.name}** with ${count} mapped component${count === 1 ? '' : 's'}.`;
  });
}

function compileMarkdownArtifact(ctx) {
  const diagramName = ctx.diagramName || 'architecture';
  const title = _titleCase(diagramName);
  const summary = _firstSentence(ctx.originalSource || ctx.markdownSource || ctx.mmdSource);
  const boundaries = _deriveBoundaries(ctx.facts, ctx.plan);

  const lines = [
    `# ${title}`,
    '',
    summary,
    '',
    '## Pipeline Context',
    '',
    `- Input mode: \`${ctx.inputMode || 'idea'}\``,
    `- Diagram name: \`${diagramName}\``,
    `- Diagram type: \`${ctx.diagramType || 'flowchart'}\``,
    '',
    '## Components',
    '',
    ..._componentLines(ctx.facts),
    '',
    '## Interactions',
    '',
    ..._interactionLines(ctx.facts),
    '',
    '## Failure Paths',
    '',
    ..._failureLines(ctx.facts),
    '',
    '## Boundaries',
    '',
    ..._boundaryLines(boundaries),
    '',
    '## Planned TSX Shell',
    '',
    ..._plannedShellLines(boundaries, ctx.facts),
    '',
    '## Mermaid',
    '',
    '```mermaid',
    (ctx.mmdSource || '').trim(),
    '```',
    '',
  ];

  return {
    title,
    summary,
    markdownSource: lines.join('\n'),
    manifest: {
      title,
      summary,
      diagramName,
      inputMode: ctx.inputMode || 'idea',
      diagramType: ctx.diagramType || 'flowchart',
      entityCount: (ctx.facts?.entities || []).length,
      relationshipCount: (ctx.facts?.relationships || []).length,
      boundaryCount: boundaries.length,
      failurePathCount: (ctx.facts?.failurePaths || []).length,
    },
  };
}

module.exports = {
  compileMarkdownArtifact,
};
