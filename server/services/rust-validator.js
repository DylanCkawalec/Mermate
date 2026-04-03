'use strict';

/**
 * Rust Validator — cargo check, cargo build --release, binary execution.
 *
 * Validation stack:
 *   L0: cargo check (syntax + type check without linking)
 *   L1: cargo build --release (full optimized compilation)
 *   L2: Run binary, verify exit code 0 + stdout contains "MIRACLE ACHIEVED"
 *
 * Bounded repair: max 2 cargo check repairs, 1 runtime repair.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const logger = require('../utils/logger');

const CARGO_TIMEOUT_MS = parseInt(process.env.MERMATE_CARGO_TIMEOUT_MS || '120000', 10);
const RUN_TIMEOUT_MS = parseInt(process.env.MERMATE_RUST_RUN_TIMEOUT_MS || '15000', 10);
const MAX_CHECK_REPAIRS = 2;

async function isAvailable() {
  try {
    const result = await _exec('cargo', ['--version'], { timeoutMs: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function _exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = opts.timeoutMs || 30000;
    const start = Date.now();
    let stdout = '', stderr = '', killed = false;

    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}`, killed: false, wallClockMs: Date.now() - start }); });
    proc.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, killed, wallClockMs: Date.now() - start }); });
  });
}

function _parseCargoErrors(output, attempt) {
  const diagnostics = [];
  const lines = String(output || '').split('\n');
  const errRe = /^error(?:\[E\d+\])?:\s*(.+)/;

  for (const line of lines) {
    const m = line.match(errRe);
    if (m) diagnostics.push({ type: 'rust_compile_error', message: m[1].trim(), attempt, raw: line.trim() });
  }

  return diagnostics.length > 0 ? diagnostics : [{ type: 'rust_compile_error', message: output.trim().slice(0, 1000), attempt, raw: '' }];
}

async function writeProject(projectDir, mainRs, cargoToml) {
  await fsp.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(projectDir, 'src', 'main.rs'), mainRs, 'utf8');
  await fsp.writeFile(path.join(projectDir, 'Cargo.toml'), cargoToml, 'utf8');
}

async function cargoCheck(projectDir) {
  const result = await _exec('cargo', ['check'], { cwd: projectDir, timeoutMs: CARGO_TIMEOUT_MS });
  const success = !result.killed && result.exitCode === 0;
  return {
    success,
    timedOut: result.killed,
    exitCode: result.exitCode,
    wallClockMs: result.wallClockMs,
    errors: success ? [] : _parseCargoErrors(result.stderr, 0),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function cargoBuild(projectDir) {
  const result = await _exec('cargo', ['build', '--release'], { cwd: projectDir, timeoutMs: CARGO_TIMEOUT_MS });
  const success = !result.killed && result.exitCode === 0;
  return {
    success,
    timedOut: result.killed,
    exitCode: result.exitCode,
    wallClockMs: result.wallClockMs,
    errors: success ? [] : _parseCargoErrors(result.stderr, 0),
  };
}

async function runBinary(projectDir, binaryName) {
  const binPath = path.join(projectDir, 'target', 'release', binaryName);
  try {
    await fsp.access(binPath);
  } catch {
    return { success: false, error: `Binary not found: ${binPath}`, stdout: '', stderr: '' };
  }

  const result = await _exec(binPath, [], { cwd: projectDir, timeoutMs: RUN_TIMEOUT_MS });
  const success = result.exitCode === 0 && result.stdout.includes('MIRACLE ACHIEVED');

  return {
    success,
    exitCode: result.exitCode,
    wallClockMs: result.wallClockMs,
    stdout: result.stdout,
    stderr: result.stderr,
    miracleAchieved: result.stdout.includes('MIRACLE ACHIEVED'),
    timedOut: result.killed,
  };
}

async function fullValidation(mainRs, cargoToml, projectDir, binaryName, repairFn) {
  let currentMainRs = mainRs;
  let checkRepairs = 0;
  const traces = [];

  // Write initial project
  await writeProject(projectDir, currentMainRs, cargoToml);

  // L0: cargo check with repair loop
  while (true) {
    const checkResult = await cargoCheck(projectDir);
    if (checkResult.success) break;

    traces.push(...checkResult.errors);

    if (repairFn && checkRepairs < MAX_CHECK_REPAIRS) {
      const repaired = await repairFn({ kind: 'rust_compile_error', rustSource: currentMainRs, diagnostics: checkResult.errors, stderr: checkResult.stderr, attempt: checkRepairs + 1 });
      if (repaired?.rustSource && repaired.rustSource.trim() !== currentMainRs.trim()) {
        currentMainRs = repaired.rustSource;
        await fsp.writeFile(path.join(projectDir, 'src', 'main.rs'), currentMainRs, 'utf8');
        checkRepairs++;
        logger.info('rust_validator.repair_check', { attempt: checkRepairs });
        continue;
      }
    }

    return { success: false, mainRs: currentMainRs, check: { success: false, errors: checkResult.errors, repairs: checkRepairs }, build: { success: false }, run: { success: false }, traces };
  }

  // L1: cargo build --release
  const buildResult = await cargoBuild(projectDir);
  if (!buildResult.success) {
    traces.push(...buildResult.errors);
    return { success: false, mainRs: currentMainRs, check: { success: true, repairs: checkRepairs }, build: { success: false, errors: buildResult.errors, wallClockMs: buildResult.wallClockMs }, run: { success: false }, traces };
  }

  // L2: Run binary
  const runResult = await runBinary(projectDir, binaryName);
  if (!runResult.success) {
    traces.push({ type: 'rust_runtime_error', message: runResult.stderr || 'Binary exited non-zero', exitCode: runResult.exitCode });
  }

  return {
    success: runResult.success,
    mainRs: currentMainRs,
    check: { success: true, repairs: checkRepairs, wallClockMs: 0 },
    build: { success: true, wallClockMs: buildResult.wallClockMs },
    run: {
      success: runResult.success,
      miracleAchieved: runResult.miracleAchieved,
      wallClockMs: runResult.wallClockMs,
      stdout: runResult.stdout,
    },
    traces,
    binaryPath: path.join(projectDir, 'target', 'release', binaryName),
  };
}

module.exports = { isAvailable, cargoCheck, cargoBuild, runBinary, fullValidation, writeProject };
