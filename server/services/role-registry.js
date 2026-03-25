'use strict';

/**
 * Role Registry — read-only runtime metadata for configured agent roles.
 *
 * Loads ARCHITECT_AI_{N}_* env vars into a frozen lookup table.
 * This module does NOT schedule agents, launch workers, or execute
 * inference. It is strictly a metadata registry that the provider
 * layer and controller can query when deciding which credentials
 * and model to use for a given stage.
 *
 * The registry is populated once at first access and then frozen.
 */

const logger = require('../utils/logger');

/**
 * @typedef {Object} RoleDefinition
 * @property {number} index       - 1-based index from env
 * @property {string} name        - ARCHITECT_AI_{N}_NAME
 * @property {string} apiKey      - ARCHITECT_AI_{N}_API_KEY (may be a ref like {MERMATE})
 * @property {string} model       - ARCHITECT_AI_{N}_MODEL
 * @property {string} domain      - ARCHITECT_AI_{N}_DOMAIN
 * @property {boolean} enabled    - ARCHITECT_AI_{N}_ENABLED
 */

const MAX_ROLES = 30;

let _roles = null;
let _byName = null;
let _byDomain = null;

function _load() {
  const e = process.env;
  // Single shared key — no per-agent keys
  const sharedApiKey = e.OPENAI_API_KEY || e.MERMATE_AI_API_KEY || '';
  const roles = [];

  for (let i = 1; i <= MAX_ROLES; i++) {
    const name = e[`ARCHITECT_AI_${i}_NAME`];
    if (!name) continue;

    // Per-agent API key is deprecated. If still present (legacy), use it;
    // otherwise fall back to the single shared key.
    const legacyKey = e[`ARCHITECT_AI_${i}_API_KEY`] || '';
    const apiKey = (legacyKey && !legacyKey.startsWith('{')) ? legacyKey : sharedApiKey;

    const model   = e[`ARCHITECT_AI_${i}_MODEL`] || 'gpt-4o';
    const domain  = e[`ARCHITECT_AI_${i}_DOMAIN`] || 'general';
    const tier    = e[`ARCHITECT_AI_${i}_TIER`] || 'worker';
    const enabled = ['true', '1', 'yes'].includes(
      (e[`ARCHITECT_AI_${i}_ENABLED`] || 'false').toLowerCase(),
    );

    roles.push(Object.freeze({
      index: i,
      name,
      apiKey,
      model,
      domain,
      tier,
      enabled,
    }));
  }

  return Object.freeze(roles);
}

function _buildIndexes(roles) {
  const byName = new Map();
  const byDomain = new Map();

  for (const role of roles) {
    byName.set(role.name.toLowerCase(), role);
    const domainKey = role.domain.toLowerCase();
    if (!byDomain.has(domainKey)) byDomain.set(domainKey, []);
    byDomain.get(domainKey).push(role);
  }

  return { byName, byDomain };
}

function _ensureLoaded() {
  if (!_roles) {
    _roles = _load();
    const indexes = _buildIndexes(_roles);
    _byName = indexes.byName;
    _byDomain = indexes.byDomain;

    const enabledCount = _roles.filter(r => r.enabled).length;
    logger.info('role.registry.loaded', {
      totalRoles: _roles.length,
      enabledRoles: enabledCount,
      domains: [..._byDomain.keys()],
    });
  }
}

function getRoles() {
  _ensureLoaded();
  return _roles;
}

function getEnabledRoles() {
  _ensureLoaded();
  return _roles.filter(r => r.enabled);
}

function getRoleByName(name) {
  _ensureLoaded();
  return _byName.get(name.toLowerCase()) || null;
}

function getRolesByDomain(domain) {
  _ensureLoaded();
  return _byDomain.get(domain.toLowerCase()) || [];
}

function isRoleEnabled(name) {
  const role = getRoleByName(name);
  return role ? role.enabled : false;
}

function _reset() {
  _roles = null;
  _byName = null;
  _byDomain = null;
}

module.exports = {
  getRoles,
  getEnabledRoles,
  getRoleByName,
  getRolesByDomain,
  isRoleEnabled,
  _reset,
};
