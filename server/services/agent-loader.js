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
      if (/^(INPUT|OUTPUT|CONSTRAINTS|DATA CONTRACT|EXPERTISE|DUMP|DATA FLOW):/i.test(lines[i])) break;
      behaviorLines.push(lines[i]);
    }
    agent.behavior = behaviorLines.join('\n').trim();
  }

  agent.priority = parseInt(agent.priority || '5', 10);
  agent.enabled = agent.enabled !== 'false';

  return agent;
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
  getAgentsByStage,
  getAllAgents,
  AGENTS_DIRS: DEFAULT_AGENT_DIRS,
};
