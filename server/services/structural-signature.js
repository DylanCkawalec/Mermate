'use strict';

/**
 * Structural Signature — the canonical topology fingerprint for any
 * validated Mermaid architecture.
 *
 * This is the first invariant that causes all six architectural threads
 * to converge:
 *   - Embeddings: signatures are the vector space basis
 *   - Learning: policies are indexed by signature class
 *   - Composition: interface contracts are typed by boundary signature
 *   - Validation: graph properties are computed over the signature
 *   - Protocol: the signature is part of the compilation proof
 *   - Failure: signature classes reveal which topologies resist bounded search
 *
 * The signature is syntax-invariant: two architectures with different node
 * names but identical topology produce identical fingerprints.
 *
 * Design principle: every property must be computable from the parsed graph
 * without calling any LLM. The signature is deterministic and external.
 */

const { createHash } = require('node:crypto');

// ---- Graph Parser ----------------------------------------------------------
// Extracts a directed graph from Mermaid flowchart/graph source.

// Handles edges with optional node labels: A["label"] --> B["label"]
const EDGE_RE = /\b([A-Za-z_]\w*)(?:\s*[\[({](?:[^\])}]|\n)*[\])}])?\s*(?:-->|==>|-.->|---|--\>|==\>|-.-\>)\s*(?:\|[^|]*\|\s*)?([A-Za-z_]\w*)/g;
const SUBGRAPH_RE = /^subgraph\s+(\S+)/;
const SUBGRAPH_END_RE = /^end\s*$/;
const NODE_DEF_RE = /\b([A-Za-z_]\w*)\s*[\[({]/g;
const SKIP_IDS = new Set(['subgraph', 'classDef', 'class', 'style', 'click', 'linkStyle', 'direction', 'end']);

function parseGraph(mmdSource) {
  if (!mmdSource) return { nodes: new Set(), edges: [], subgraphs: [], nodeToSubgraph: {} };

  const nodes = new Set();
  const edges = [];
  const subgraphs = [];
  const nodeToSubgraph = {};
  const subgraphStack = [];

  const lines = mmdSource.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;

    const sgMatch = line.match(SUBGRAPH_RE);
    if (sgMatch) {
      const sgId = sgMatch[1];
      const parent = subgraphStack.length ? subgraphStack[subgraphStack.length - 1] : null;
      subgraphs.push({ id: sgId, parent, depth: subgraphStack.length });
      subgraphStack.push(sgId);
      continue;
    }

    if (SUBGRAPH_END_RE.test(line)) {
      subgraphStack.pop();
      continue;
    }

    // Extract edges
    let edgeMatch;
    const edgeRe = new RegExp(EDGE_RE.source, 'g');
    while ((edgeMatch = edgeRe.exec(line)) !== null) {
      const from = edgeMatch[1];
      const to = edgeMatch[2];
      if (SKIP_IDS.has(from) || SKIP_IDS.has(to)) continue;
      nodes.add(from);
      nodes.add(to);
      edges.push({ from, to });

      const currentSg = subgraphStack.length ? subgraphStack[subgraphStack.length - 1] : null;
      if (currentSg) {
        if (!nodeToSubgraph[from]) nodeToSubgraph[from] = currentSg;
        if (!nodeToSubgraph[to]) nodeToSubgraph[to] = currentSg;
      }
    }

    // Extract standalone node definitions
    const nodeDef = new RegExp(NODE_DEF_RE.source, 'g');
    let nodeMatch;
    while ((nodeMatch = nodeDef.exec(line)) !== null) {
      const id = nodeMatch[1];
      if (!SKIP_IDS.has(id)) {
        nodes.add(id);
        const currentSg = subgraphStack.length ? subgraphStack[subgraphStack.length - 1] : null;
        if (currentSg && !nodeToSubgraph[id]) nodeToSubgraph[id] = currentSg;
      }
    }
  }

  return { nodes, edges, subgraphs, nodeToSubgraph };
}

// ---- Degree Distribution ---------------------------------------------------

function computeDegrees(nodes, edges) {
  const inDeg = {};
  const outDeg = {};
  for (const n of nodes) { inDeg[n] = 0; outDeg[n] = 0; }

  for (const { from, to } of edges) {
    outDeg[from] = (outDeg[from] || 0) + 1;
    inDeg[to] = (inDeg[to] || 0) + 1;
  }

  const inValues = Object.values(inDeg);
  const outValues = Object.values(outDeg);
  const n = nodes.size || 1;

  return {
    avgInDegree:  +(inValues.reduce((s, v) => s + v, 0) / n).toFixed(2),
    avgOutDegree: +(outValues.reduce((s, v) => s + v, 0) / n).toFixed(2),
    maxInDegree:  Math.max(0, ...inValues),
    maxOutDegree: Math.max(0, ...outValues),
    inDeg,
    outDeg,
  };
}

// ---- Reachability & Connectivity -------------------------------------------

function computeReachability(nodes, edges) {
  const adj = {};
  const radj = {};
  for (const n of nodes) { adj[n] = []; radj[n] = []; }
  for (const { from, to } of edges) {
    if (adj[from]) adj[from].push(to);
    if (radj[to]) radj[to].push(from);
  }

  function bfs(start, graph) {
    const visited = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const curr = queue.shift();
      for (const next of (graph[curr] || [])) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return visited;
  }

  // Source nodes: in-degree 0
  const nodeArr = [...nodes];
  const sourceNodes = nodeArr.filter(n => (radj[n] || []).length === 0 && (adj[n] || []).length > 0);
  const sinkNodes = nodeArr.filter(n => (adj[n] || []).length === 0 && (radj[n] || []).length > 0);

  // Forward reachability from all sources
  const reachableFromSources = new Set();
  for (const s of sourceNodes) {
    for (const r of bfs(s, adj)) reachableFromSources.add(r);
  }

  // Unreachable nodes (not reachable from any source, excluding sources themselves)
  const unreachable = nodeArr.filter(n => !reachableFromSources.has(n) && !sourceNodes.includes(n));

  // Connected components (undirected)
  const visited = new Set();
  let components = 0;
  for (const n of nodeArr) {
    if (visited.has(n)) continue;
    components++;
    const undirected = {};
    for (const nd of nodes) undirected[nd] = [];
    for (const { from, to } of edges) {
      undirected[from].push(to);
      undirected[to].push(from);
    }
    for (const r of bfs(n, undirected)) visited.add(r);
  }

  // Cycle detection (DFS-based)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const n of nodeArr) color[n] = WHITE;
  let hasCycles = false;

  function dfs(u) {
    color[u] = GRAY;
    for (const v of (adj[u] || [])) {
      if (color[v] === GRAY) { hasCycles = true; return; }
      if (color[v] === WHITE) dfs(v);
      if (hasCycles) return;
    }
    color[u] = BLACK;
  }

  for (const n of nodeArr) {
    if (color[n] === WHITE) dfs(n);
    if (hasCycles) break;
  }

  // Max path length (longest shortest path from any source — BFS-based)
  let maxPathLength = 0;
  for (const s of sourceNodes) {
    const dist = { [s]: 0 };
    const q = [s];
    while (q.length) {
      const curr = q.shift();
      for (const next of (adj[curr] || [])) {
        if (dist[next] === undefined) {
          dist[next] = dist[curr] + 1;
          if (dist[next] > maxPathLength) maxPathLength = dist[next];
          q.push(next);
        }
      }
    }
  }

  return {
    sourceNodes: sourceNodes.length,
    sinkNodes: sinkNodes.length,
    unreachableNodes: unreachable.length,
    unreachableList: unreachable.slice(0, 10),
    connectedComponents: components,
    isFullyConnected: components <= 1,
    hasCycles,
    maxPathLength,
  };
}

// ---- Boundary Analysis -----------------------------------------------------

function computeBoundaries(edges, nodeToSubgraph) {
  let crossings = 0;
  const crossingPairs = [];

  for (const { from, to } of edges) {
    const sgFrom = nodeToSubgraph[from] || null;
    const sgTo = nodeToSubgraph[to] || null;
    if (sgFrom !== sgTo) {
      crossings++;
      crossingPairs.push({ from: sgFrom, to: sgTo });
    }
  }

  // Boundary symmetry: for each A→B crossing, check if B→A exists
  const pairSet = new Set(crossingPairs.map(p => `${p.from}→${p.to}`));
  let symmetricCount = 0;
  for (const p of crossingPairs) {
    if (pairSet.has(`${p.to}→${p.from}`)) symmetricCount++;
  }

  return {
    boundaryCrossings: crossings,
    boundaryRatio: edges.length > 0 ? +(crossings / edges.length).toFixed(3) : 0,
    boundarySymmetry: crossings > 0 ? +(symmetricCount / crossings).toFixed(3) : 1.0,
    uniqueBoundaryPairs: [...new Set(crossingPairs.map(p => `${p.from}↔${p.to}`))].length,
  };
}

// ---- Cross-Cutting Pattern Detection ---------------------------------------

function detectCrossCuttingPatterns(edges, nodeToSubgraph, inDeg) {
  // A cross-cutting pattern is a node that receives edges from many different
  // subgraphs. High fan-in from diverse boundaries = cross-cutting concern.
  const nodeSourceSubgraphs = {};
  for (const { from, to } of edges) {
    const sgFrom = nodeToSubgraph[from] || '_root';
    if (!nodeSourceSubgraphs[to]) nodeSourceSubgraphs[to] = new Set();
    nodeSourceSubgraphs[to].add(sgFrom);
  }

  const patterns = [];
  for (const [node, sgs] of Object.entries(nodeSourceSubgraphs)) {
    if (sgs.size >= 3) {
      patterns.push({
        node,
        fanInSubgraphs: sgs.size,
        totalFanIn: inDeg[node] || 0,
        type: 'hub',
      });
    }
  }

  // Also detect repeated edge patterns (same edge type appearing across
  // many subgraphs — e.g., every subgraph has a →logging edge)
  const edgeTargetBySubgraph = {};
  for (const { from, to } of edges) {
    const sg = nodeToSubgraph[from] || '_root';
    if (!edgeTargetBySubgraph[to]) edgeTargetBySubgraph[to] = new Set();
    edgeTargetBySubgraph[to].add(sg);
  }

  for (const [target, sgs] of Object.entries(edgeTargetBySubgraph)) {
    if (sgs.size >= 3 && !patterns.find(p => p.node === target)) {
      patterns.push({
        node: target,
        fanInSubgraphs: sgs.size,
        totalFanIn: inDeg[target] || 0,
        type: 'cross-cutting',
      });
    }
  }

  return patterns.sort((a, b) => b.fanInSubgraphs - a.fanInSubgraphs);
}

// ---- Topology Hash ---------------------------------------------------------
// Syntax-invariant fingerprint: sorted degree sequence + edge topology.

function computeTopologyHash(nodes, edges) {
  const nodeArr = [...nodes].sort();
  const nodeIndex = {};
  nodeArr.forEach((n, i) => { nodeIndex[n] = i; });

  // Canonical adjacency: sorted pairs of (from_index, to_index)
  const canonicalEdges = edges
    .map(({ from, to }) => [nodeIndex[from] ?? -1, nodeIndex[to] ?? -1])
    .filter(([a, b]) => a >= 0 && b >= 0)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([a, b]) => `${a}:${b}`)
    .join(',');

  return createHash('sha256').update(canonicalEdges).digest('hex').slice(0, 16);
}

// ---- Complexity Classification ---------------------------------------------

function classifyComplexity(nodeCount, edgeCount, subgraphCount, maxNesting, hasCycles, crossCuttingCount) {
  if (nodeCount <= 5 && edgeCount <= 6) return 'trivial';
  if (nodeCount <= 15 && subgraphCount <= 2 && !hasCycles) return 'simple';
  if (nodeCount <= 40 && subgraphCount <= 5) return 'moderate';
  if (nodeCount <= 80 || (crossCuttingCount >= 3)) return 'complex';
  return 'dense';
}

// ---- Flow Completeness Check -----------------------------------------------

function checkFlowCompleteness(nodes, edges, inDeg, outDeg) {
  const nodeArr = [...nodes];

  // Orphaned nodes: no edges at all
  const orphaned = nodeArr.filter(n => (inDeg[n] || 0) === 0 && (outDeg[n] || 0) === 0);

  // Dangling sources: only outgoing, never receiving (potential entry points — not always bad)
  const danglingOut = nodeArr.filter(n => (inDeg[n] || 0) === 0 && (outDeg[n] || 0) > 0);

  // Dead ends: only incoming, never sending (potential sinks — not always bad)
  const deadEnds = nodeArr.filter(n => (outDeg[n] || 0) === 0 && (inDeg[n] || 0) > 0);

  // Failure path heuristic: nodes with "error", "fail", "retry", "timeout", "fallback" in ID
  const FAILURE_RE = /error|fail|retry|timeout|fallback|dead|alert|warn|exception/i;
  const failureNodes = nodeArr.filter(n => FAILURE_RE.test(n));

  return {
    orphanedNodes: orphaned.length,
    orphanedList: orphaned.slice(0, 5),
    entryPoints: danglingOut.length,
    terminalNodes: deadEnds.length,
    failurePathNodes: failureNodes.length,
    hasExplicitFailurePaths: failureNodes.length > 0,
  };
}

// ---- Main Entry Point ------------------------------------------------------

/**
 * Extract the canonical structural signature from a Mermaid source.
 *
 * The signature is syntax-invariant: two architectures with different
 * names but identical topology produce the same topologyHash.
 *
 * @param {string} mmdSource - Validated Mermaid source
 * @returns {object} Structural signature
 */
function extract(mmdSource) {
  const { nodes, edges, subgraphs, nodeToSubgraph } = parseGraph(mmdSource);
  const nodeCount = nodes.size;
  const edgeCount = edges.length;
  const subgraphCount = subgraphs.length;
  const maxSubgraphDepth = subgraphs.length ? Math.max(...subgraphs.map(s => s.depth + 1)) : 0;

  const degrees = computeDegrees(nodes, edges);
  const reachability = computeReachability(nodes, edges);
  const boundaries = computeBoundaries(edges, nodeToSubgraph);
  const flow = checkFlowCompleteness(nodes, edges, degrees.inDeg, degrees.outDeg);
  const crossCuttingPatterns = detectCrossCuttingPatterns(edges, nodeToSubgraph, degrees.inDeg);
  const topologyHash = computeTopologyHash(nodes, edges);

  const complexityClass = classifyComplexity(
    nodeCount, edgeCount, subgraphCount,
    maxSubgraphDepth, reachability.hasCycles,
    crossCuttingPatterns.length
  );

  return {
    // Identity
    topologyHash,
    complexityClass,

    // Scale
    nodeCount,
    edgeCount,
    subgraphCount,
    maxSubgraphDepth,

    // Degree distribution
    avgInDegree: degrees.avgInDegree,
    avgOutDegree: degrees.avgOutDegree,
    maxInDegree: degrees.maxInDegree,
    maxOutDegree: degrees.maxOutDegree,

    // Connectivity
    connectedComponents: reachability.connectedComponents,
    isFullyConnected: reachability.isFullyConnected,
    hasCycles: reachability.hasCycles,
    maxPathLength: reachability.maxPathLength,
    sourceNodes: reachability.sourceNodes,
    sinkNodes: reachability.sinkNodes,
    unreachableNodes: reachability.unreachableNodes,

    // Boundaries
    boundaryCrossings: boundaries.boundaryCrossings,
    boundaryRatio: boundaries.boundaryRatio,
    boundarySymmetry: boundaries.boundarySymmetry,

    // Flow
    orphanedNodes: flow.orphanedNodes,
    entryPoints: flow.entryPoints,
    terminalNodes: flow.terminalNodes,
    failurePathNodes: flow.failurePathNodes,
    hasExplicitFailurePaths: flow.hasExplicitFailurePaths,

    // Cross-cutting
    crossCuttingPatterns: crossCuttingPatterns.slice(0, 5),
    crossCuttingCount: crossCuttingPatterns.length,
  };
}

module.exports = {
  extract,
  parseGraph,
  computeDegrees,
  computeReachability,
  computeBoundaries,
  detectCrossCuttingPatterns,
  computeTopologyHash,
  classifyComplexity,
  checkFlowCompleteness,
};
