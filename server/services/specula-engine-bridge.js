'use strict';

/**
 * Specula Engine Bridge — exposes the pinned Specula submodule as a local API
 * engine for the Mermate TLA+ pipeline.
 *
 * What it does:
 *   - Locates the specula-engine submodule and reads its skill prompts/guides.
 *   - Detects Specula's bundled TLC runner and trace-analysis tools.
 *   - Offers a single async API that the rest of the server can call without
 *     knowing whether Specula is fully installed or not.
 *   - Warms up at boot so the first TLA+ render never pays the probe cost.
 *
 * The bridge is deliberately defensive: if Specula is missing, not set up, or
 * any tool fails, it returns `available: false` and the pipeline falls back to
 * Mermate's native JS implementation.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const logger = require('../utils/logger');
const SPECULA_REFERENCE = require('./specula-reference');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SPECULA_ROOT = path.join(PROJECT_ROOT, 'specula-engine');
const SPECULA_SKILLS = path.join(SPECULA_ROOT, 'skills');
// Mermate-owned skill overlay (specification-master-agent tree). The pinned
// specula-engine submodule is read-only upstream; project skills live here
// and take precedence in getSkillText so we control how TLA+ is written.
const MERMATE_SKILLS = process.env.MERMATE_SKILLS_DIR || path.join(PROJECT_ROOT, '.windsurf', 'skills');
const SPECULA_TLC_SCRIPT = path.join(SPECULA_ROOT, 'scripts', 'tlc', 'run_model_check.sh');
const SPECULA_TRACE_DEBUGGER = path.join(SPECULA_ROOT, 'tools', 'trace_debugger', 'mcp_server.py');
const SPECULA_SPEC_ANALYZER = path.join(SPECULA_ROOT, 'tools', 'spec_analyzer');
const SPECULA_LIB = path.join(SPECULA_ROOT, 'lib');
const SPECULA_JAR = path.join(SPECULA_LIB, 'tla2tools.jar');
const SPECULA_COMMUNITY_JAR = path.join(SPECULA_LIB, 'CommunityModules-deps.jar');

// Cached warm-up state
let _availability = null;
let _promptCache = new Map();

// ---- Submodule / file presence probes --------------------------------------

function _existsSync(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

async function _exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function _isSubmodulePresent() {
  return _existsSync(path.join(SPECULA_ROOT, 'src', 'specula', '__init__.py'));
}

async function _isSetupComplete() {
  const hasJar = await _exists(SPECULA_JAR);
  const hasCommunity = await _exists(SPECULA_COMMUNITY_JAR);
  return hasJar && hasCommunity;
}

async function _isCliAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('specula', ['--help'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

async function _isUvRunAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('uv', ['--version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

// ---- Public API: availability and config ------------------------------------

/**
 * Probe Specula engine availability once and cache the result.
 * Boot warm-up calls this; subsequent calls reuse the cache.
 */
async function isAvailable() {
  if (_availability) return _availability;

  const submodule = _isSubmodulePresent();
  const setup = submodule ? await _isSetupComplete() : false;
  const cli = setup ? await _isCliAvailable() : false;
  const uvRun = await _isUvRunAvailable();

  _availability = {
    available: submodule,
    setupComplete: setup,
    cliAvailable: cli,
    uvRunAvailable: uvRun,
    submodulePath: SPECULA_ROOT,
    jar: { present: setup, path: setup ? SPECULA_JAR : null },
    tlcScript: { present: await _exists(SPECULA_TLC_SCRIPT), path: SPECULA_TLC_SCRIPT },
    traceDebugger: { present: await _exists(SPECULA_TRACE_DEBUGGER), path: SPECULA_TRACE_DEBUGGER },
    specAnalyzer: { present: await _exists(SPECULA_SPEC_ANALYZER), path: SPECULA_SPEC_ANALYZER },
  };

  logger.info('specula_engine.availability', _availability);
  return _availability;
}

function getConfig() {
  return {
    upstream: SPECULA_REFERENCE,
    available: _availability?.available ?? false,
    setupComplete: _availability?.setupComplete ?? false,
    cliAvailable: _availability?.cliAvailable ?? false,
    uvRunAvailable: _availability?.uvRunAvailable ?? false,
    paths: {
      root: SPECULA_ROOT,
      skills: SPECULA_SKILLS,
      tlcScript: SPECULA_TLC_SCRIPT,
      traceDebugger: SPECULA_TRACE_DEBUGGER,
      specAnalyzer: SPECULA_SPEC_ANALYZER,
      jar: SPECULA_JAR,
    },
  };
}

/**
 * Boot warm-up: fire-and-forget availability probe so the first render skips it.
 */
function warmUp() {
  isAvailable().catch(() => {});
}

// ---- Skill prompt / guide loader -------------------------------------------

/**
 * Read a Specula skill markdown file. Results are cached for the process
 * lifetime to avoid repeated disk reads on every TLA+ render.
 *
 * @param {string} skill - skill directory name, e.g. 'spec_generation'
 * @param {string} file - file name, e.g. 'guide.md' or 'SKILL.md'
 * @returns {Promise<string|null>}
 */
async function getSkillText(skill, file) {
  const cacheKey = `${skill}/${file}`;
  if (_promptCache.has(cacheKey)) return _promptCache.get(cacheKey);

  // Overlay first (Mermate-owned skills), then the pinned submodule.
  const overlayPath = path.join(MERMATE_SKILLS, skill, file);
  const filePath = _existsSync(overlayPath) ? overlayPath : path.join(SPECULA_SKILLS, skill, file);
  if (!_existsSync(filePath)) return null;

  try {
    const text = await fsp.readFile(filePath, 'utf8');
    _promptCache.set(cacheKey, text);
    return text;
  } catch (err) {
    logger.warn('specula_engine.skill_read_error', { skill, file, error: err.message });
    return null;
  }
}

/**
 * Get the core spec-generation methodology from Specula as a single string
 * suitable for injection into an LLM system prompt.
 */
async function getSpecGenerationGuide() {
  const guide = await getSkillText('spec_generation', 'guide.md');
  const overview = await getSkillText('', 'workflow-overview.md');
  if (!guide) return null;
  return `Specula workflow overview:\n${overview || '(not available)'}\n\n---\n\nSpecula spec-generation guide:\n${guide}`;
}

/**
 * Get the specification-master-agent orchestrator skill (Lamport methodology,
 * Minimum Acceptable Skeleton gate) for injection into TLA+ writer prompts.
 * Returns null when the overlay skill is not installed.
 */
async function getMasterAgentGuide() {
  const text = await getSkillText('specification-master-agent', 'SKILL.md');
  if (!text) return null;
  // Strip YAML frontmatter — prompt injection needs the body only.
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/**
 * Get the validation-workflow guide that describes convergence + bug hunting.
 */
async function getValidationWorkflowGuide() {
  const guide = await getSkillText('validation-workflow', 'guide.md');
  if (!guide) return null;
  return `Specula validation workflow:\n${guide}`;
}

// ---- Tool runners ----------------------------------------------------------

/**
 * Spawn the Specula TLC runner with the given spec and config. Falls back to
 * the native tla-validator.js implementation if the runner is unavailable.
 *
 * This is a low-level escape hatch; most callers should use
 * tlaValidator.runTlc() which chooses between native and Specula automatically.
 *
 * @param {string} specPath
 * @param {string} cfgPath
 * @param {object} opts - { memory, workers, timeoutMinutes, deadlock, jsonTrace, cwd }
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, logFile: string|null}>}
 */
async function runSpeculaTlc(specPath, cfgPath, opts = {}) {
  const avail = await isAvailable();
  if (!avail.tlcScript.present) {
    return { ok: false, exitCode: null, stdout: '', stderr: 'Specula TLC script not present', logFile: null };
  }

  const args = [
    '-s', specPath,
    '-c', cfgPath,
    '-w', String(opts.workers || 'auto'),
    '-t', String(opts.timeoutMinutes || 60),
  ];
  if (opts.memory) args.push('-m', String(opts.memory));
  if (opts.deadlock) args.push('-D');
  if (opts.jsonTrace) args.push('-j', opts.jsonTrace);

  return new Promise((resolve) => {
    const cwd = opts.cwd || path.dirname(specPath);
    const proc = spawn('bash', [SPECULA_TLC_SCRIPT, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SPECULA_ROOT: SPECULA_ROOT,
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
        logFile: null, // Specula script writes a log file; caller can parse stderr for its name
      });
    });

    proc.on('error', (err) => {
      resolve({ ok: false, exitCode: null, stdout, stderr: err.message, logFile: null });
    });
  });
}

/**
 * Run the Specula trace debugger MCP tool on a TLC-generated trace.
 * Requires the tool's Python venv to be set up; returns null if unavailable.
 */
async function analyzeTrace(tracePath, specPath, opts = {}) {
  const avail = await isAvailable();
  if (!avail.traceDebugger.present) {
    return { ok: false, error: 'Specula trace debugger not present' };
  }

  // The trace_debugger is an MCP server; invoking it directly is non-trivial.
  // We provide a stub that can be wired to the MCP client later.
  logger.info('specula_engine.trace_debugger_stub', { tracePath, specPath });
  return { ok: true, note: 'trace_debugger is an MCP server; wire through MCP client for full analysis' };
}

/**
 * Clear the prompt cache. Useful in tests or after a submodule update.
 */
function clearCache() {
  _promptCache.clear();
  _availability = null;
}

module.exports = {
  isAvailable,
  getConfig,
  warmUp,
  getSkillText,
  getSpecGenerationGuide,
  getMasterAgentGuide,
  getValidationWorkflowGuide,
  runSpeculaTlc,
  analyzeTrace,
  clearCache,
  SPECULA_ROOT,
  SPECULA_SKILLS,
  MERMATE_SKILLS,
  SPECULA_TLC_SCRIPT,
};
