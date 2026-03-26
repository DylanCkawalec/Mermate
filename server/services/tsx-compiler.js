'use strict';

function _pascalCase(text) {
  return String(text || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || 'Architecture';
}

function _slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function _safeString(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function _boundaryMap(facts, plan) {
  const byEntity = new Map();
  for (const boundary of (facts?.boundaries || [])) {
    for (const member of (boundary.members || [])) {
      byEntity.set(member, boundary.name);
    }
  }

  if (byEntity.size === 0) {
    for (const subgraph of (plan?.subgraphs || [])) {
      for (const member of (subgraph.members || [])) {
        byEntity.set(member, subgraph.label || subgraph.title || subgraph.id || 'Architecture');
      }
    }
  }

  return byEntity;
}

function _modulePathForEntity(entity, boundaryName) {
  const base = boundaryName ? `src/features/${_slug(boundaryName)}` : 'src/features/core';
  if (entity.type === 'actor' || entity.type === 'external') {
    return `src/integrations/${_slug(entity.name)}.ts`;
  }
  if (entity.type === 'store' || entity.type === 'cache' || entity.type === 'queue' || entity.type === 'broker') {
    return `src/data/${_slug(entity.name)}.ts`;
  }
  return `${base}/${_slug(entity.name)}.ts`;
}

function _buildManifest(ctx) {
  const boundaryLookup = _boundaryMap(ctx.facts, ctx.plan);
  const components = (ctx.facts?.entities || []).map((entity) => {
    const boundary = boundaryLookup.get(entity.name) || 'Architecture';
    return {
      id: _slug(entity.name),
      name: entity.name,
      type: entity.type,
      responsibility: entity.responsibility || null,
      boundary,
      plannedModulePath: _modulePathForEntity(entity, boundary),
    };
  });

  const boundaries = [...new Set(components.map((component) => component.boundary))].map((name) => ({
    id: _slug(name),
    name,
    components: components.filter((component) => component.boundary === name).map((component) => component.id),
  }));

  const interactions = (ctx.facts?.relationships || []).map((relationship) => ({
    id: _slug(`${relationship.from}-${relationship.verb}-${relationship.to}`),
    from: relationship.from,
    to: relationship.to,
    verb: relationship.verb || 'interacts',
    edgeType: relationship.edgeType || 'runtime',
    actionName: _pascalCase(`${relationship.from} ${relationship.verb || 'interacts'} ${relationship.to}`),
  }));

  const failurePaths = (ctx.facts?.failurePaths || []).map((path, index) => ({
    id: `failure-${index + 1}`,
    trigger: path.trigger || 'unknown',
    condition: path.condition || 'unspecified condition',
    handler: path.handler || 'unspecified handler',
    recovery: path.recovery || 'unspecified recovery',
  }));

  const plannedModules = components.map((component) => ({
    id: component.id,
    language: 'typescript',
    path: component.plannedModulePath,
    purpose: component.responsibility || `Implement ${component.name}`,
  }));

  const polyglotTargets = [
    {
      language: 'typescript',
      path: 'src/',
      purpose: 'Application shell, orchestration surface, and UI refinement.',
    },
    {
      language: 'python',
      path: 'services/specula_worker/',
      purpose: 'Trace normalization, external tool orchestration, and analysis adapters.',
    },
    {
      language: 'rust',
      path: 'crates/spec_kernel/',
      purpose: 'High-throughput event validation and runtime-safe instrumentation helpers.',
    },
  ];

  return {
    version: '1.0.0',
    diagramName: ctx.diagramName,
    title: ctx.title,
    summary: ctx.summary,
    markdownPath: ctx.markdownPath || null,
    components,
    boundaries,
    interactions,
    failurePaths,
    plannedModules,
    polyglotTargets,
  };
}

function _buildSpecSource(manifest) {
  return [
    `export const architectureShell = ${JSON.stringify(manifest, null, 2)} as const`,
    '',
    'export type ArchitectureShell = typeof architectureShell',
    '',
  ].join('\n');
}

function _buildAppSource() {
  return `import './index.css'
import { architectureShell } from './spec'

const componentMap = new Map(architectureShell.components.map((component) => [component.id, component]))

export default function App() {
  return (
    <main className="architecture-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">TSX Architecture Scaffold</p>
          <h1>{architectureShell.title}</h1>
          <p className="lead">{architectureShell.summary}</p>
        </div>

        <div className="hero-stats">
          <article>
            <span>Components</span>
            <strong>{architectureShell.components.length}</strong>
          </article>
          <article>
            <span>Boundaries</span>
            <strong>{architectureShell.boundaries.length}</strong>
          </article>
          <article>
            <span>Failure paths</span>
            <strong>{architectureShell.failurePaths.length}</strong>
          </article>
        </div>
      </section>

      <section className="boundary-grid">
        {architectureShell.boundaries.map((boundary) => (
          <article className="panel" key={boundary.id}>
            <header>
              <span className="eyebrow">Boundary</span>
              <h2>{boundary.name}</h2>
            </header>

            <div className="component-stack">
              {boundary.components.map((componentId) => {
                const component = componentMap.get(componentId)
                if (!component) return null

                return (
                  <div className="component-card" key={component.id}>
                    <strong>{component.name}</strong>
                    <p>{component.type}</p>
                    <code>{component.plannedModulePath}</code>
                  </div>
                )
              })}
            </div>
          </article>
        ))}
      </section>

      <section className="detail-grid">
        <article className="panel">
          <header>
            <span className="eyebrow">Interactions</span>
            <h2>Runtime edges</h2>
          </header>
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>Verb</th>
                  <th>To</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {architectureShell.interactions.map((interaction) => (
                  <tr key={interaction.id}>
                    <td>{interaction.from}</td>
                    <td>{interaction.verb}</td>
                    <td>{interaction.to}</td>
                    <td>{interaction.actionName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <header>
            <span className="eyebrow">Validation focus</span>
            <h2>Failure and recovery</h2>
          </header>
          <div className="failure-stack">
            {architectureShell.failurePaths.length === 0 ? (
              <p className="empty-state">No failure paths were extracted for this scaffold.</p>
            ) : (
              architectureShell.failurePaths.map((failurePath) => (
                <div className="failure-card" key={failurePath.id}>
                  <strong>{failurePath.trigger}</strong>
                  <p>{failurePath.condition}</p>
                  <span>{failurePath.handler} -> {failurePath.recovery}</span>
                </div>
              ))
            )}
          </div>
        </article>

        <article className="panel">
          <header>
            <span className="eyebrow">Polyglot build plan</span>
            <h2>Implementation targets</h2>
          </header>
          <div className="target-stack">
            {architectureShell.polyglotTargets.map((target) => (
              <div className="target-card" key={target.language}>
                <strong>{target.language}</strong>
                <code>{target.path}</code>
                <p>{target.purpose}</p>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  )
}
`;
}

function _buildStyleSource() {
  return `:root {
  color-scheme: light;
  --bg: #f6f0e8;
  --panel: rgba(255, 251, 246, 0.92);
  --line: rgba(30, 24, 18, 0.1);
  --ink: #231811;
  --muted: #7a6557;
  --accent: #c2561a;
  --accent-soft: rgba(194, 86, 26, 0.12);
  font: 16px/1.5 "IBM Plex Sans", "Avenir Next", sans-serif;
  background:
    radial-gradient(circle at top left, rgba(194, 86, 26, 0.18), transparent 35%),
    linear-gradient(180deg, #fcf7f1, #f6f0e8 48%, #efe5d8);
  color: var(--ink);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.architecture-shell {
  min-height: 100vh;
  padding: 40px;
}

.hero,
.panel {
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--panel);
  box-shadow: 0 20px 60px rgba(54, 39, 26, 0.08);
}

.hero {
  display: grid;
  gap: 24px;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.9fr);
  padding: 32px;
}

.eyebrow {
  margin: 0 0 10px;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
  color: var(--muted);
}

.hero h1,
.panel h2 {
  margin: 0;
  font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
}

.lead {
  max-width: 64ch;
  color: var(--muted);
}

.hero-stats,
.boundary-grid,
.detail-grid {
  display: grid;
  gap: 18px;
}

.hero-stats {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.hero-stats article,
.component-card,
.failure-card,
.target-card {
  border-radius: 18px;
  border: 1px solid var(--line);
  background: white;
  padding: 16px;
}

.hero-stats span,
.component-card p,
.failure-card span,
.target-card p {
  color: var(--muted);
}

.hero-stats strong {
  display: block;
  margin-top: 8px;
  font-size: 1.6rem;
}

.boundary-grid {
  margin-top: 22px;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.panel {
  padding: 22px;
}

.component-stack,
.failure-stack,
.target-stack {
  display: grid;
  gap: 12px;
}

.detail-grid {
  margin-top: 22px;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.table-shell {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
  text-align: left;
}

code {
  display: inline-block;
  margin-top: 8px;
  color: var(--accent);
  font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
}

.empty-state {
  color: var(--muted);
}

@media (max-width: 900px) {
  .architecture-shell {
    padding: 20px;
  }

  .hero {
    grid-template-columns: 1fr;
  }

  .hero-stats {
    grid-template-columns: 1fr;
  }
}
`;
}

function compileTsxArchitectureScaffold(ctx) {
  const manifest = _buildManifest(ctx);
  const appSource = _buildAppSource();
  const specSource = _buildSpecSource(manifest);
  const styleSource = _buildStyleSource();

  return {
    manifest,
    appSource,
    specSource,
    styleSource,
    metrics: {
      componentCount: manifest.components.length,
      boundaryCount: manifest.boundaries.length,
      interactionCount: manifest.interactions.length,
      failurePathCount: manifest.failurePaths.length,
      plannedModuleCount: manifest.plannedModules.length,
    },
    files: {
      'src/App.tsx': appSource,
      'src/spec.ts': specSource,
      'src/index.css': styleSource,
    },
  };
}

module.exports = {
  compileTsxArchitectureScaffold,
};
