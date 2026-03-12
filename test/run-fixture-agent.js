'use strict';

/**
 * Fixture Agent Runner
 *
 * Runs each .mmd fixture through the full Mermaid Max Agent pipeline:
 *   1. POST /api/agent/run  (optimize-mmd mode) — SSE stream → preview_ready
 *   2. POST /api/agent/finalize — SSE stream → final_render (Max mode PNG)
 *   3. Writes the final compiled .mmd back to the fixture file
 *
 * Usage: node test/run-fixture-agent.js
 */

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const PORT     = process.env.PORT || 3333;
const BASE_URL = `http://localhost:${PORT}`;
const ROOT     = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const ARCHS    = path.join(ROOT, 'archs');

const FIXTURE_FILES = [
  'flowchart-simple.mmd',
  'state-diagram.mmd',
  'sequence-diagram.mmd',
  'class-diagram.mmd',
  'er-diagram.mmd',
  'gantt-chart.mmd',
  'pie-chart.mmd',
  'mindmap.mmd',
];

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
  orange: '\x1b[38;5;208m',
};
const log   = (msg)  => console.log(`${C.gray}[fixture]${C.reset} ${msg}`);
const ok    = (msg)  => console.log(`${C.green}✓${C.reset} ${msg}`);
const warn  = (msg)  => console.log(`${C.yellow}⚠${C.reset} ${msg}`);
const err   = (msg)  => console.log(`${C.red}✗${C.reset} ${msg}`);
const head  = (msg)  => console.log(`\n${C.bold}${C.cyan}━━ ${msg} ${C.reset}`);
const sub   = (msg)  => console.log(`  ${C.orange}▸${C.reset} ${msg}`);

// ── SSE stream consumer ───────────────────────────────────────────────────────
/**
 * Posts JSON body to url, consumes SSE stream.
 * Calls onEvent(parsed_object) for each event.
 * Resolves when stream ends.
 */
function ssePost(url, body, onEvent) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept':         'text/event-stream',
      },
    };
    const req = http.request(url, opts, (res) => {
      if (res.statusCode >= 400) {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`)));
        return;
      }

      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString('utf-8');
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          try {
            const obj = JSON.parse(json);
            onEvent(obj);
          } catch { /* skip malformed */ }
        }
      });
      res.on('end',   resolve);
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Phase 1: agent/run ────────────────────────────────────────────────────────
async function runAgent(fixtureName, mmdSource) {
  sub(`Phase 1: agent/run  optimize-mmd …`);
  let draftText    = mmdSource;
  let diagramName  = null;
  let previewPaths = null;
  let gotPreview   = false;

  await ssePost(`${BASE_URL}/api/agent/run`, {
    prompt:       mmdSource,
    current_text: mmdSource,
    mode:         'optimize-mmd',
  }, (event) => {
    switch (event.type) {
      case 'stage':
        log(`  stage: ${event.stage} — ${event.message || ''}`);
        break;
      case 'thinking':
        log(`  thinking: ${event.role || 'default'} — ${event.summary || ''}`);
        break;
      case 'narration':
        log(`  narration: ${event.message || ''}`);
        break;
      case 'draft_update':
        draftText = event.text || draftText;
        log(`  draft updated (${draftText.length} chars)`);
        break;
      case 'preview_render':
        if (event.success) {
          previewPaths = event.paths;
          diagramName  = event.diagram_name;
          log(`  preview OK — ${event.metrics?.nodeCount ?? '?'} nodes`);
        } else {
          warn(`  preview compile issue: ${event.error || 'unknown'}`);
        }
        break;
      case 'preview_ready':
        gotPreview  = true;
        draftText   = event.draft_text || draftText;
        diagramName = event.diagram_name || diagramName;
        log(`  preview_ready received — diagram: ${diagramName}`);
        break;
      case 'error':
        err(`  agent/run error: ${event.message}`);
        break;
    }
  });

  if (!gotPreview) {
    warn(`  preview_ready was not received — proceeding with current draft`);
  }

  return { draftText, diagramName, previewPaths };
}

// ── Phase 2: agent/finalize ───────────────────────────────────────────────────
async function finalizeAgent(draftText, diagramName, mode) {
  sub(`Phase 2: agent/finalize  Max render …`);
  let finalPaths  = null;
  let finalText   = draftText;
  let success     = false;

  await ssePost(`${BASE_URL}/api/agent/finalize`, {
    current_text: draftText,
    mode,
    diagram_name: diagramName || undefined,
  }, (event) => {
    switch (event.type) {
      case 'stage':
        log(`  stage: ${event.stage}`);
        break;
      case 'narration':
        log(`  narration: ${event.message || ''}`);
        break;
      case 'draft_update':
        finalText = event.text || finalText;
        break;
      case 'final_render':
        if (event.success) {
          finalPaths = event.paths;
          success    = true;
          log(`  final_render OK — ${event.metrics?.nodeCount ?? '?'} nodes`);
        } else {
          err(`  final_render failed: ${event.error || 'unknown'}`);
        }
        break;
      case 'done':
        finalText = event.final_text || finalText;
        break;
      case 'error':
        err(`  agent/finalize error: ${event.message}`);
        break;
    }
  });

  return { finalPaths, finalText, success };
}

// ── Resolve compiled .mmd from paths ─────────────────────────────────────────
async function resolveCompiledMmd(paths, diagramName) {
  if (!paths) return null;

  // Try compiled_mmd first (most refined), then mmd
  const candidates = [paths.compiled_mmd, paths.mmd].filter(Boolean);
  for (const urlPath of candidates) {
    // URL path is like /archs/foo.mmd — resolve to disk
    const rel      = urlPath.replace(/^\//, '');
    const diskPath = path.join(ROOT, rel);
    try {
      const content = await fsp.readFile(diskPath, 'utf-8');
      if (content && content.trim()) {
        log(`  resolved .mmd from ${rel} (${content.length} chars)`);
        return content.trim();
      }
    } catch { /* try next */ }
  }

  // Fallback: scan archs directory for diagram name
  if (diagramName) {
    for (const candidate of [`${diagramName}.compiled.mmd`, `${diagramName}.mmd`]) {
      const diskPath = path.join(ARCHS, candidate);
      try {
        const content = await fsp.readFile(diskPath, 'utf-8');
        if (content && content.trim()) {
          log(`  resolved .mmd from archs/${candidate} (${content.length} chars)`);
          return content.trim();
        }
      } catch { /* skip */ }
    }
  }

  return null;
}

// ── Process one fixture ───────────────────────────────────────────────────────
async function processFixture(filename) {
  const fixturePath = path.join(FIXTURES, filename);
  const label       = filename.replace('.mmd', '');

  head(label);

  let mmdSource;
  try {
    mmdSource = await fsp.readFile(fixturePath, 'utf-8');
  } catch (e) {
    err(`Could not read ${filename}: ${e.message}`);
    return { filename, success: false, error: e.message };
  }

  log(`Source: ${mmdSource.split('\n').length} lines, ${mmdSource.length} chars`);

  let draftText, diagramName, previewPaths;
  try {
    ({ draftText, diagramName, previewPaths } = await runAgent(filename, mmdSource));
  } catch (e) {
    err(`agent/run failed: ${e.message}`);
    return { filename, success: false, error: e.message };
  }

  let finalPaths, finalText, finalSuccess;
  try {
    ({ finalPaths, finalText, success: finalSuccess } = await finalizeAgent(draftText, diagramName, 'optimize-mmd'));
  } catch (e) {
    err(`agent/finalize failed: ${e.message}`);
    return { filename, success: false, error: e.message };
  }

  // Resolve the compiled .mmd to write back to the fixture
  const compiledMmd = await resolveCompiledMmd(finalPaths || previewPaths, diagramName);

  const textToSave = compiledMmd || finalText || draftText;
  if (textToSave && textToSave.trim()) {
    await fsp.writeFile(fixturePath, textToSave + '\n', 'utf-8');
    ok(`Fixture updated: ${filename} (${textToSave.split('\n').length} lines)`);
  } else {
    warn(`No compiled content — fixture unchanged: ${filename}`);
  }

  const pngPath = finalPaths?.png || previewPaths?.png;
  if (pngPath) {
    const diskPng = path.join(ROOT, pngPath.replace(/^\//, ''));
    ok(`PNG → ${diskPng}`);
  }

  return {
    filename,
    success: true,
    diagramName,
    pngPath,
    fixturePath,
    lineCount: textToSave?.split('\n').length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   MERMAID FIXTURE AGENT RUNNER — MAX MODE        ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Mode:   optimize-mmd → finalize (Max render)`);
  console.log(`  Files:  ${FIXTURE_FILES.length} fixtures\n`);

  // Verify server is up
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(`${BASE_URL}/api/agent/modes`, { method: 'GET' }, res => {
        if (res.statusCode === 200) resolve(); else reject(new Error(`status ${res.statusCode}`));
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    ok(`Server online at ${BASE_URL}`);
  } catch (e) {
    err(`Server not reachable at ${BASE_URL}: ${e.message}`);
    process.exit(1);
  }

  const results = [];

  for (const filename of FIXTURE_FILES) {
    const result = await processFixture(filename);
    results.push(result);
    // Brief pause between fixtures to avoid hammering the inference provider
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Summary ──
  console.log(`\n${C.bold}${C.cyan}━━ SUMMARY ──────────────────────────────────────────${C.reset}`);
  for (const r of results) {
    if (r.success) {
      ok(`${r.filename.padEnd(28)}  ${r.lineCount ?? '?'} lines  PNG: ${r.pngPath || 'N/A'}`);
    } else {
      err(`${r.filename.padEnd(28)}  FAILED: ${r.error}`);
    }
  }

  const passed = results.filter(r => r.success).length;
  console.log(`\n  ${C.bold}${passed}/${results.length} fixtures mastered${C.reset}\n`);

  process.exit(passed < results.length ? 1 : 0);
}

main().catch(e => {
  err(`Fatal: ${e.message}`);
  process.exit(1);
});
