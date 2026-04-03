'use strict';

/**
 * TypeScript Runtime Validator
 *
 * Validation stack:
 *   L0: tsc compile check (router-side deterministic)
 *   L1: runtime harness execution (generated executable refinement)
 *   L2: deterministic coverage checks (entities/actions/invariants)
 *
 * Repair is bounded:
 *   - compile repairs: up to 2
 *   - test repairs: up to 1
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TSC_ENTRY = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TSX_CLI = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const TSC_TIMEOUT_MS = parseInt(process.env.MERMATE_TS_TSC_TIMEOUT_MS || '30000', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.MERMATE_TS_TEST_TIMEOUT_MS || '30000', 10);
const MAX_TSC_REPAIRS = 2;
const MAX_TEST_REPAIRS = 1;

async function _exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isAvailable() {
  const [tsc, tsx] = await Promise.all([_exists(TSC_ENTRY), _exists(TSX_CLI)]);
  return tsc && tsx;
}

function _exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cwd = opts.cwd || PROJECT_ROOT;
    const timeoutMs = opts.timeoutMs || 30000;
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        killed: false,
        wallClockMs: Date.now() - start,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        killed,
        wallClockMs: Date.now() - start,
      });
    });
  });
}

async function _writeRuntimeFiles(tsDir, fileBase, tsSource, harnessSource) {
  await fsp.mkdir(tsDir, { recursive: true });
  const sourcePath = path.join(tsDir, `${fileBase}.ts`);
  const harnessPath = path.join(tsDir, `${fileBase}.harness.ts`);
  const tsconfigPath = path.join(tsDir, 'tsconfig.runtime.json');

  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'Node',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: [`${fileBase}.ts`, `${fileBase}.harness.ts`],
  };

  await fsp.writeFile(sourcePath, tsSource, 'utf8');
  await fsp.writeFile(harnessPath, harnessSource, 'utf8');
  await fsp.writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');

  return { sourcePath, harnessPath, tsconfigPath };
}

function _parseCompileErrors(output, attempt) {
  const diagnostics = [];
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);

  const diagRe = /^(.*)\((\d+),(\d+)\):\s*error\s*TS(\d+):\s*(.*)$/i;

  for (const line of lines) {
    const m = line.match(diagRe);
    if (!m) continue;
    diagnostics.push({
      type: 'ts_compile_error',
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      code: `TS${m[4]}`,
      message: m[5],
      attempt,
      raw: line,
    });
  }

  if (diagnostics.length > 0) return diagnostics;

  if (!lines.length) {
    return [{
      type: 'ts_compile_error',
      file: null,
      line: null,
      column: null,
      code: 'TS_UNKNOWN',
      message: 'TypeScript compilation failed with empty diagnostics.',
      attempt,
      raw: '',
    }];
  }

  return [{
    type: 'ts_compile_error',
    file: null,
    line: null,
    column: null,
    code: 'TS_UNKNOWN',
    message: lines.slice(0, 5).join('\n'),
    attempt,
    raw: lines.join('\n'),
  }];
}

function checkCoverage(tsSource, coverageSpec) {
  const source = String(tsSource || '');
  const spec = coverageSpec || {};

  const missing = {
    entities: [],
    actions: [],
    actionMethods: [],
    invariants: [],
    requiredMethods: [],
    initialStates: [],
  };

  for (const entityId of (spec.entities || [])) {
    const re = new RegExp(`private\\s+${entityId}\\s*:`);
    if (!re.test(source)) missing.entities.push(entityId);
  }

  for (const action of (spec.actions || [])) {
    if (!source.includes(`"${action}"`)) missing.actions.push(action);
  }

  for (const method of (spec.actionMethods || [])) {
    const re = new RegExp(`\\b(?:public|private|protected)\\s+${method}\\s*\\(`);
    if (!re.test(source)) missing.actionMethods.push(method);
  }

  for (const method of (spec.invariants || [])) {
    const re = new RegExp(`\\b(?:public|private|protected)\\s+${method}\\s*\\(`);
    if (!re.test(source)) missing.invariants.push(method);
  }

  for (const method of (spec.requiredMethods || [])) {
    const re = new RegExp(`\\b(?:public|private|protected)\\s+${method}\\s*\\(`);
    if (!re.test(source)) missing.requiredMethods.push(method);
  }

  for (const initial of (spec.initialStates || [])) {
    const needle = `this.${initial.id} = "${initial.state}"`;
    if (!source.includes(needle)) missing.initialStates.push(initial.id);
  }

  const totalEntity = (spec.entities || []).length;
  const totalAction = (spec.actions || []).length;
  const totalInv = (spec.invariants || []).length;

  const entityCoverage = totalEntity > 0 ? (totalEntity - missing.entities.length) / totalEntity : 1;
  const actionCoverage = totalAction > 0 ? (totalAction - missing.actions.length) / totalAction : 1;
  const invariantCoverage = totalInv > 0 ? (totalInv - missing.invariants.length) / totalInv : 1;

  const ok = Object.values(missing).every((arr) => arr.length === 0);

  return {
    ok,
    entityCoverage: +entityCoverage.toFixed(3),
    actionCoverage: +actionCoverage.toFixed(3),
    invariantCoverage: +invariantCoverage.toFixed(3),
    missing,
  };
}

async function runTsc(tsDir, tsconfigPath, attempt = 0) {
  const result = await _exec(process.execPath, [TSC_ENTRY, '--project', tsconfigPath, '--pretty', 'false'], {
    cwd: tsDir,
    timeoutMs: TSC_TIMEOUT_MS,
  });

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const success = !result.killed && result.exitCode === 0;
  const errors = success ? [] : _parseCompileErrors(combined, attempt);

  return {
    success,
    timedOut: result.killed,
    exitCode: result.exitCode,
    wallClockMs: result.wallClockMs,
    stdout: result.stdout,
    stderr: result.stderr,
    errors,
  };
}

function _extractRuntimeFailure(stdout, stderr, attempt) {
  const merged = `${stdout || ''}\n${stderr || ''}`;
  const marker = merged.match(/TS_RUNTIME_FAILURE::(\{.*\})/s);
  if (marker) {
    try {
      const parsed = JSON.parse(marker[1]);
      return {
        type: parsed.type || 'ts_invariant_violation',
        message: parsed.message || 'Runtime harness failed',
        stack: parsed.stack || '',
        attempt,
      };
    } catch {
      // fall through to generic test failure
    }
  }
  return {
    type: 'ts_test_failure',
    message: (stderr || stdout || 'Runtime harness failed').trim().slice(0, 2000),
    stack: '',
    attempt,
  };
}

async function runHarness(tsDir, harnessPath, attempt = 0) {
  const result = await _exec(process.execPath, [TSX_CLI, harnessPath], {
    cwd: tsDir,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  const success = !result.killed && result.exitCode === 0;
  const trace = success ? null : _extractRuntimeFailure(result.stdout, result.stderr, attempt);

  return {
    checked: true,
    success,
    timedOut: result.killed,
    exitCode: result.exitCode,
    wallClockMs: result.wallClockMs,
    stdout: result.stdout,
    stderr: result.stderr,
    trace,
  };
}

/**
 * Full validation + bounded repair loop.
 *
 * @param {string} tsSource
 * @param {string} harnessSource
 * @param {string} tsDir
 * @param {string} fileBase
 * @param {object} coverageSpec
 * @param {Function} [repairFn] async ({ kind, tsSource, harnessSource, diagnostics, trace, attempt }) => { tsSource, harnessSource? } | null
 */
async function fullValidation(tsSource, harnessSource, tsDir, fileBase, coverageSpec, repairFn) {
  let currentTsSource = tsSource;
  let currentHarness = harnessSource;
  let tscRepairs = 0;
  let testRepairs = 0;
  const traces = [];

  while (true) {
    const files = await _writeRuntimeFiles(tsDir, fileBase, currentTsSource, currentHarness);

    const compileResult = await runTsc(tsDir, files.tsconfigPath, tscRepairs + testRepairs);
    if (!compileResult.success) {
      traces.push(...compileResult.errors);

      if (repairFn && tscRepairs < MAX_TSC_REPAIRS) {
        const repaired = await repairFn({
          kind: 'ts_compile_error',
          tsSource: currentTsSource,
          harnessSource: currentHarness,
          diagnostics: compileResult.errors,
          attempt: tscRepairs + 1,
        });

        if (repaired?.tsSource && repaired.tsSource.trim() !== currentTsSource.trim()) {
          currentTsSource = repaired.tsSource;
          if (repaired.harnessSource && repaired.harnessSource.trim()) {
            currentHarness = repaired.harnessSource;
          }
          tscRepairs++;
          logger.info('ts_validator.repair_compile', { attempt: tscRepairs });
          continue;
        }
      }

      return {
        success: false,
        tsSource: currentTsSource,
        harnessSource: currentHarness,
        compile: {
          success: false,
          errors: compileResult.errors,
          wallClockMs: compileResult.wallClockMs,
          timedOut: compileResult.timedOut,
          repairs: tscRepairs,
        },
        tests: {
          checked: false,
          success: false,
          wallClockMs: 0,
          repairs: testRepairs,
          trace: null,
        },
        coverage: checkCoverage(currentTsSource, coverageSpec),
        traces,
      };
    }

    const coverage = checkCoverage(currentTsSource, coverageSpec);
    if (!coverage.ok) {
      const coverageTrace = {
        type: 'ts_coverage_failure',
        message: 'Deterministic coverage check failed',
        missing: coverage.missing,
        attempt: tscRepairs + testRepairs + 1,
      };
      traces.push(coverageTrace);
      return {
        success: false,
        tsSource: currentTsSource,
        harnessSource: currentHarness,
        compile: {
          success: true,
          errors: [],
          wallClockMs: compileResult.wallClockMs,
          timedOut: false,
          repairs: tscRepairs,
        },
        tests: {
          checked: false,
          success: false,
          wallClockMs: 0,
          repairs: testRepairs,
          trace: coverageTrace,
        },
        coverage,
        traces,
      };
    }

    const testResult = await runHarness(tsDir, files.harnessPath, tscRepairs + testRepairs + 1);
    if (!testResult.success) {
      traces.push(testResult.trace);

      if (repairFn && testRepairs < MAX_TEST_REPAIRS) {
        const repaired = await repairFn({
          kind: 'ts_test_failure',
          tsSource: currentTsSource,
          harnessSource: currentHarness,
          trace: testResult.trace,
          stdout: testResult.stdout,
          stderr: testResult.stderr,
          attempt: testRepairs + 1,
        });

        if (repaired?.tsSource && repaired.tsSource.trim() !== currentTsSource.trim()) {
          currentTsSource = repaired.tsSource;
          if (repaired.harnessSource && repaired.harnessSource.trim()) {
            currentHarness = repaired.harnessSource;
          }
          testRepairs++;
          logger.info('ts_validator.repair_test', { attempt: testRepairs });
          continue;
        }
      }

      return {
        success: false,
        tsSource: currentTsSource,
        harnessSource: currentHarness,
        compile: {
          success: true,
          errors: [],
          wallClockMs: compileResult.wallClockMs,
          timedOut: false,
          repairs: tscRepairs,
        },
        tests: {
          checked: true,
          success: false,
          passed: false,
          wallClockMs: testResult.wallClockMs,
          timedOut: testResult.timedOut,
          repairs: testRepairs,
          trace: testResult.trace,
        },
        coverage,
        traces,
      };
    }

    return {
      success: true,
      tsSource: currentTsSource,
      harnessSource: currentHarness,
      compile: {
        success: true,
        errors: [],
        wallClockMs: compileResult.wallClockMs,
        timedOut: false,
        repairs: tscRepairs,
      },
      tests: {
        checked: true,
        success: true,
        passed: true,
        wallClockMs: testResult.wallClockMs,
        timedOut: false,
        repairs: testRepairs,
        trace: null,
        output: (testResult.stdout || '').trim(),
      },
      coverage,
      traces,
    };
  }
}

module.exports = {
  isAvailable,
  runTsc,
  runHarness,
  checkCoverage,
  fullValidation,
  TSC_TIMEOUT_MS,
  TEST_TIMEOUT_MS,
};
