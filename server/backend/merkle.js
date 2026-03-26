'use strict';

const crypto = require('node:crypto');

function hashContent(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashChildren(childHashes) {
  const sorted = [...childHashes].sort();
  return crypto.createHash('sha256').update(sorted.join('')).digest('hex');
}

const TYPE_GROUPS = {
  mmd:     ['mmd', 'compiled_mmd', 'md'],
  render:  ['png', 'svg'],
  tla:     ['tla', 'cfg'],
  ts:      ['ts', 'harness'],
  run:     ['run_json'],
};

function _groupKey(artifactType) {
  for (const [group, types] of Object.entries(TYPE_GROUPS)) {
    if (types.includes(artifactType)) return group;
  }
  return 'other';
}

/**
 * Build a two-level Merkle tree from a list of artifacts.
 * Returns { root, nodes } where nodes is an array of { nodeHash, parentHash, level, children }.
 */
function buildProjectTree(artifacts) {
  if (!artifacts || artifacts.length === 0) {
    const emptyRoot = hashContent(Buffer.from('empty'));
    return { root: emptyRoot, nodes: [{ nodeHash: emptyRoot, parentHash: null, level: 1, children: [] }] };
  }

  const groups = new Map();
  for (const a of artifacts) {
    const key = _groupKey(a.artifact_type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a.content_hash);
  }

  const nodes = [];
  const groupHashes = [];

  for (const [, childHashes] of groups) {
    const groupHash = hashChildren(childHashes);
    groupHashes.push(groupHash);
    nodes.push({
      nodeHash: groupHash,
      parentHash: null, // set after root computation
      level: 1,
      children: childHashes,
    });
  }

  const rootHash = hashChildren(groupHashes);
  for (const node of nodes) {
    node.parentHash = rootHash;
  }

  nodes.push({
    nodeHash: rootHash,
    parentHash: null,
    level: 2,
    children: groupHashes,
  });

  return { root: rootHash, nodes };
}

function computeRootHash(artifacts) {
  const { root } = buildProjectTree(artifacts);
  return root;
}

module.exports = { hashContent, hashChildren, buildProjectTree, computeRootHash };
