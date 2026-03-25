'use strict';

/**
 * TLA+ Validator — SANY parse check, TLC model check, trace extraction,
 * and bounded repair loop.
 *
 * Three-level validation stack (mirrors Mermaid's L0-L3):
 *   L0: SANY parse — syntax validity
 *   L1: TLC model check — invariant checking with bounded state exploration
 *   L2: Trace extraction — structured counterexample on violation
 *
 * All validation is deterministic, external, and bounded by timeout.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fsp = require('node:fs/promises');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_DIR = path.join(PROJECT_ROOT, 'vendor');
const JAR_PATH = path.join(VENDOR_DIR, 'tla2tools.jar');

const SANY_TIMEOUT_MS = parseInt(process.env.MERMATE_SANY_TIMEOUT_MS || '15000', 10);
const TLC_TIMEOUT_MS = parseInt(process.env.MERMATE_TLC_TIMEOUT_MS || '60000', 10);
const MAX_REPAIR_ATTEMPTS = 2;

// ---- Java / JAR availability -----------------------------------------------

let _javaAvailable = null;
let _jarAvailable = null;

async function checkJava() {
  if (_javaAvailable !== null) return _javaAvailable;
  try {
    const result = await _exec('java', ['-version'], { timeout: 5000 });
    _javaAvailable = result.exitCode === 0;
  } catch {
    _javaAvailable = false;
  }
  return _javaAvailable;
}

async function checkJar() {
  if (_jarAvailable !== null) return _jarAvailable;
  try {
    await fsp.access(JAR_PATH);
    _jarAvailable = true;
  } catch {
    _jarAvailable = false;
  }
  return _jarAvailable;
}

async function isAvailable() {
  const [java, jar] = await Promise.all([checkJava(), checkJar()]);
  return java && jar;
}

// ---- Process execution helper ----------------------------------------------

function _exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 30000;
    const cwd = opts.cwd || PROJECT_ROOT;

    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, killed, wallClockMs: 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message, killed: false, wallClockMs: 0 });
    });
  });
}

// ---- L0: SANY Parse Check --------------------------------------------------

/**
 * Run SANY syntax analysis on a .tla file.
 *
 * @param {string} tlaFilePath - Absolute path to the .tla file
 * @returns {Promise<{valid: boolean, errors: string[], stdout: string, stderr: string, wallClockMs: number}>}
 */
async function runSany(tlaFilePath) {
  const start = Date.now();
  const result = await _exec('java', [
    '-cp', JAR_PATH,
    'tla2sany.SANY',
    tlaFilePath,
  ], { timeout: SANY_TIMEOUT_MS, cwd: path.dirname(tlaFilePath) });

  const wallClockMs = Date.now() - start;
  const combined = result.stdout + '\n' + result.stderr;
  const errors = [];

  if (result.killed) {
    errors.push(`SANY timed out after ${SANY_TIMEOUT_MS}ms`);
  }

  // Parse SANY error messages
  const errorLines = combined.split('\n').filter(l =>
    /error|abort|could not|unknown|unexpected|illegal/i.test(l) && !/^Parsing\s+file|^Semantic\s+processing/i.test(l)
  );
  errors.push(...errorLines.map(l => l.trim()).filter(Boolean));

  const valid = result.exitCode === 0 && errors.length === 0;

  logger.info('tla_validator.sany', {
    valid,
    exitCode: result.exitCode,
    errors: errors.length,
    wallClockMs,
  });

  return { valid, errors, stdout: result.stdout, stderr: result.stderr, wallClockMs };
}

// ---- L1: TLC Model Check ---------------------------------------------------

/**
 * Run TLC model checker on a .tla file with its .cfg.
 *
 * @param {string} tlaFilePath
 * @param {string} cfgFilePath
 * @returns {Promise<object>}
 */
async function runTlc(tlaFilePath, cfgFilePath) {
  const tlaDir = path.dirname(tlaFilePath);
  const tracePath = path.join(tlaDir, 'trace.json');

  const start = Date.now();
  const result = await _exec('java', [
    '-XX:+UseParallelGC',
    '-jar', JAR_PATH,
    '-config', cfgFilePath,
    '-workers', 'auto',
    '-deadlock',
    '-dumpTrace', 'json', tracePath,
    tlaFilePath,
  ], { timeout: TLC_TIMEOUT_MS, cwd: tlaDir });

  const wallClockMs = Date.now() - start;
  const combined = result.stdout + '\n' + result.stderr;

  // Parse TLC output
  const violations = [];
  const invariantsChecked = [];
  let statesExplored = 0;

  // Extract states explored
  const statesMatch = combined.match(/(\d+)\s+states?\s+generated/i);
  if (statesMatch) statesExplored = parseInt(statesMatch[1], 10);

  // Extract invariant violations
  const violationRe = /Invariant\s+(\w+)\s+is\s+violated/gi;
  let vm;
  while ((vm = violationRe.exec(combined)) !== null) {
    violations.push(vm[1]);
  }

  // Extract checked invariants
  const checkedRe = /Checking\s+(?:invariant|temporal property)\s+(\w+)/gi;
  let cm;
  while ((cm = checkedRe.exec(combined)) !== null) {
    invariantsChecked.push(cm[1]);
  }

  // Try to read the JSON trace file
  let trace = null;
  try {
    const traceRaw = await fsp.readFile(tracePath, 'utf8');
    trace = JSON.parse(traceRaw);
  } catch { /* trace file may not exist if no violation */ }

  // Build structured violation traces
  const structuredViolations = violations.map(inv => ({
    type: 'tla_invariant_violation',
    invariant: inv,
    stateCount: statesExplored,
    traceLength: trace?.states?.length || 0,
    trace: (trace?.states || []).map((s, i) => ({
      step: i,
      variables: s?.val || s || {},
      action: s?.action?.name || 'unknown',
    })),
    tlcExitCode: result.exitCode,
    wallClockMs,
  }));

  const checked = !result.killed;
  const success = checked && violations.length === 0 && result.exitCode === 0;

  logger.info('tla_validator.tlc', {
    success,
    exitCode: result.exitCode,
    violations: violations.length,
    statesExplored,
    wallClockMs,
    timedOut: result.killed,
  });

  return {
    checked,
    success,
    invariantsChecked,
    violations: structuredViolations,
    statesExplored,
    wallClockMs,
    timedOut: result.killed,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    tracePath: trace ? tracePath : null,
  };
}

// ---- Repair Loop -----------------------------------------------------------

/**
 * Validate a TLA+ module with SANY, repair up to MAX_REPAIR_ATTEMPTS times.
 *
 * @param {string} tlaSource - TLA+ module source
 * @param {string} tlaDir - Directory for temp files
 * @param {string} moduleName
 * @param {Function} repairFn - async (tlaSource, sanyErrors) => repairedSource
 * @returns {Promise<{tlaSource: string, sanyResult: object, repairAttempts: number}>}
 */
async function validateWithRepair(tlaSource, tlaDir, moduleName, repairFn) {
  const tlaPath = path.join(tlaDir, `${moduleName}.tla`);
  let currentSource = tlaSource;
  let repairAttempts = 0;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    await fsp.writeFile(tlaPath, currentSource, 'utf8');
    const sanyResult = await runSany(tlaPath);

    if (sanyResult.valid) {
      return { tlaSource: currentSource, sanyResult, repairAttempts };
    }

    if (attempt >= MAX_REPAIR_ATTEMPTS || !repairFn) {
      return { tlaSource: currentSource, sanyResult, repairAttempts };
    }

    repairAttempts++;
    logger.info('tla_validator.repair_attempt', { attempt: repairAttempts, errors: sanyResult.errors.length });

    const repaired = await repairFn(currentSource, sanyResult.errors.join('\n'));
    if (!repaired || repaired.trim() === currentSource.trim()) {
      return { tlaSource: currentSource, sanyResult, repairAttempts };
    }
    currentSource = repaired;
  }

  return { tlaSource: currentSource, sanyResult: { valid: false, errors: ['max repair attempts reached'] }, repairAttempts };
}

/**
 * Full validation pipeline: SANY + TLC.
 *
 * @param {string} tlaSource
 * @param {string} cfgSource
 * @param {string} tlaDir
 * @param {string} moduleName
 * @param {Function} [repairFn]
 * @returns {Promise<object>}
 */
async function fullValidation(tlaSource, cfgSource, tlaDir, moduleName, repairFn) {
  await fsp.mkdir(tlaDir, { recursive: true });

  const cfgPath = path.join(tlaDir, `${moduleName}.cfg`);
  await fsp.writeFile(cfgPath, cfgSource, 'utf8');

  // L0: SANY with repair
  const sanyPhase = await validateWithRepair(tlaSource, tlaDir, moduleName, repairFn);

  if (!sanyPhase.sanyResult.valid) {
    return {
      tlaSource: sanyPhase.tlaSource,
      cfgSource,
      sany: {
        valid: false,
        errors: sanyPhase.sanyResult.errors,
        repairAttempts: sanyPhase.repairAttempts,
      },
      tlc: { checked: false, success: false, invariantsChecked: [], violations: [], statesExplored: 0, wallClockMs: 0 },
    };
  }

  // L1+L2: TLC model check
  const tlaPath = path.join(tlaDir, `${moduleName}.tla`);
  const tlcResult = await runTlc(tlaPath, cfgPath);

  return {
    tlaSource: sanyPhase.tlaSource,
    cfgSource,
    sany: {
      valid: true,
      errors: [],
      repairAttempts: sanyPhase.repairAttempts,
    },
    tlc: {
      checked: tlcResult.checked,
      success: tlcResult.success,
      invariantsChecked: tlcResult.invariantsChecked,
      violations: tlcResult.violations,
      statesExplored: tlcResult.statesExplored,
      wallClockMs: tlcResult.wallClockMs,
      timedOut: tlcResult.timedOut,
    },
    tracePath: tlcResult.tracePath,
  };
}

module.exports = {
  isAvailable,
  checkJava,
  checkJar,
  runSany,
  runTlc,
  validateWithRepair,
  fullValidation,
  JAR_PATH,
  SANY_TIMEOUT_MS,
  TLC_TIMEOUT_MS,
};
