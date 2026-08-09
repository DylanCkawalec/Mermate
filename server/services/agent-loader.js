'use strict';

/**
 * Agent Loader — reads agent behavioral specifications from the MERMATE
 * agents directory at startup. Provides a registry of agent definitions
 * that can be queried by stage, role, or name.
 *
 * Agent files are plain text with a structured header format:
 *   AGENT: Name
 *   ROLE: Description
 *   STAGE: stage number or ALL
 *   PRIORITY: number
 *   BEHAVIOR: ...
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AGENT_DIRS = [
  process.env.MERMATE_AGENTS_DIR,
  path.join(PROJECT_ROOT, 'agents'),
  path.join(PROJECT_ROOT, '.cursor', 'agents'),
  path.resolve(os.homedir(), 'Desktop', 'MERMATE'),
].filter(Boolean);

let _agents = null;

function _parseAgentFile(content, filename) {
  const lines = content.split('\n');
  const agent = { filename, raw: content };

  for (const line of lines) {
    const match = line.match(/^(AGENT|ROLE|DOMAIN|STAGE|PRIORITY|MODEL|API_KEY|ENABLED):\s*(.+)/i);
    if (match) {
      const key = match[1].toLowerCase().replace(/_/g, '');
      agent[key] = match[2].trim();
    }
  }

  const behaviorIdx = lines.findIndex(l => /^BEHAVIOR:/i.test(l));
  if (behaviorIdx >= 0) {
    const behaviorLines = [];
    for (let i = behaviorIdx + 1; i < lines.length; i++) {
      if (/^(INPUT|OUTPUT|CONSTRAINTS|DATA CONTRACT|EXPERTISE( SIGNALS)?|DUMP|DATA FLOW|MODEL|API[_ ]?KEY|ENABLED):/i.test(lines[i])) break;
      behaviorLines.push(lines[i]);
    }
    agent.behavior = behaviorLines.join('\n').trim();
  }

  // Expertise signals: the questions this specialist instinctively asks.
  // Injected after the behavior bullets — they shape *how* the model
  // interrogates the architecture, not just what it does.
  const signalsIdx = lines.findIndex(l => /^EXPERTISE SIGNALS:/i.test(l));
  if (signalsIdx >= 0) {
    const signals = [];
    for (let i = signalsIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || /^[A-Z_][A-Z_ ]*:/.test(lines[i])) break;
      if (t.startsWith('-')) signals.push(t.replace(/^-\s*/, '').replace(/^"(.*)"$/, '$1'));
    }
    if (signals.length) agent.signals = signals;
  }

  agent.priority = parseInt(agent.priority || '5', 10);
  agent.enabled = agent.enabled !== 'false';
  agent.promptBlock = _buildPromptBlock(agent);

  return agent;
}

// Compact, token-efficient doctrine block for prompt injection.
// Identity line + behavior bullets (the operational core) + signature
// questions, capped at whole-line boundaries near 1200 chars — roughly
// 260 tokens. Built once at load time, never per-call.
const PROMPT_BLOCK_MAX_CHARS = 1200;

function _buildPromptBlock(agent) {
  if (!agent.behavior) return '';
  const lines = [];
  if (agent.agent && agent.role) {
    lines.push(`You are ${agent.agent}, ${agent.role.toLowerCase()}. Think in your discipline; every judgment must come from it.`);
  }
  const bullets = agent.behavior
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-'));
  if (bullets.length) lines.push(...bullets);
  else lines.push(agent.behavior.trim());
  if (agent.signals?.length) {
    lines.push('Interrogate the architecture with your signature questions:');
    lines.push(...agent.signals.map(s => `- ${s}`));
  }
  // Trim at line boundaries — never mid-sentence.
  const out = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > PROMPT_BLOCK_MAX_CHARS) break;
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

// Fuzzy domain match: role-registry domains (e.g. `computational_ecology`)
// and agent-file domains (e.g. `computational_material_ecology`) drifted
// apart historically. Exact match first, then token-overlap.
function getAgentByDomain(domain) {
  if (!_agents || !domain) return null;
  const want = domain.toLowerCase();
  const agents = [..._agents.values()].filter(a => a.enabled && a.domain);
  const exact = agents.find(a => a.domain.toLowerCase() === want);
  if (exact) return exact;
  const wantTokens = new Set(want.split('_'));
  let best = null;
  let bestOverlap = 1; // require at least 2 shared tokens
  for (const a of agents) {
    const overlap = a.domain.toLowerCase().split('_').filter(t => wantTokens.has(t)).length;
    if (overlap > bestOverlap) { best = a; bestOverlap = overlap; }
  }
  return best;
}

async function loadAgents() {
  if (_agents) return _agents;

  _agents = new Map();
  const loadedDirs = [];
  const missingDirs = [];

  for (const dir of DEFAULT_AGENT_DIRS) {
    try {
      const entries = await fsp.readdir(dir);
      const agentFiles = entries.filter(
        (file) => file.startsWith('agent_') && (file.endsWith('.txt') || !file.includes('.')),
      );

      if (agentFiles.length > 0) {
        loadedDirs.push(dir);
      }

      for (const file of agentFiles) {
        try {
          const content = await fsp.readFile(path.join(dir, file), 'utf8');
          if (!content.trim()) continue;
          const agent = _parseAgentFile(content, file);
          const key = file.replace(/^agent_/, '').replace(/\.txt$/, '').toLowerCase();
          if (!_agents.has(key)) {
            _agents.set(key, agent);
          }
        } catch {
          /* skip unreadable files */
        }
      }
    } catch (err) {
      missingDirs.push({ dir, error: err.message });
    }
  }

  logger.info('agent_loader.loaded', {
    dirs: loadedDirs,
    missingDirs,
    count: _agents.size,
    agents: [..._agents.keys()],
  });

  return _agents;
}

function getAgent(key) {
  return _agents?.get(key.toLowerCase()) || null;
}

function getAgentsByStage(stage) {
  if (!_agents) return [];
  return [..._agents.values()].filter(a => {
    const s = String(a.stage || '').toLowerCase();
    return s === 'all' || s.includes(String(stage));
  }).sort((a, b) => a.priority - b.priority);
}

function getAllAgents() {
  if (!_agents) return [];
  return [..._agents.values()].sort((a, b) => a.priority - b.priority);
}

module.exports = {
  loadAgents,
  getAgent,
  getAgentByDomain,
  getAgentsByStage,
  getAllAgents,
  AGENTS_DIRS: DEFAULT_AGENT_DIRS,
};
