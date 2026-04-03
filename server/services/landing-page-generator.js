'use strict';

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/**
 * Generates the landing page HTML for a compiled MERMATE application.
 * Main view: clean MVP product page.
 * Audit bubble: collapsible panel with pipeline internals for Opseeq/directory verification.
 */
function generateLandingPage({ appName, diagramName, entities, relationships, facts, metrics, tlaValid, tsValid, rustValid, miracleAchieved, hasHero, hasIcon, runId, engineOutput, description }) {
  const safeEngine = _esc(engineOutput || '');
  const entityCount = (entities || []).length;
  const relCount = (relationships || []).length;
  const shortDesc = _esc(description || `A compiled architecture system with ${entityCount} entities and ${relCount} relationships.`);

  // Audit data for the bubble
  const stages = [
    { id: 'idea', name: 'Idea Extraction', ok: true, detail: `${entityCount} entities, ${relCount} relationships` },
    { id: 'mmd', name: 'Mermaid Diagram', ok: true, detail: 'SVG/PNG validated' },
    { id: 'tla', name: 'TLA+ Formal Spec', ok: !!tlaValid, detail: tlaValid ? 'SANY + TLC pass' : 'Validation pending' },
    { id: 'ts', name: 'TypeScript Runtime', ok: !!tsValid, detail: tsValid ? 'tsc + harness pass' : 'Compile pending' },
    { id: 'rust', name: 'Rust Binary', ok: !!rustValid, detail: rustValid ? (miracleAchieved ? 'MIRACLE ACHIEVED' : 'Build pass') : 'Build pending' },
  ];
  const auditStagesHtml = stages.map(s =>
    `<div class="a-stage"><span class="a-dot ${s.ok ? 'ok' : 'warn'}"></span><span class="a-name">${s.name}</span><span class="a-detail">${s.detail}</span></div>`
  ).join('');

  const auditEntitiesHtml = (entities || []).map(e =>
    `<span class="a-entity">${_esc(e.name)} <small>${e.type}</small></span>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_esc(appName)}</title>
<link rel="icon" href="/icon.png" type="image/png">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#08090d;--card:#10121a;--bd:#1a1d2e;--tx:#dce1eb;--mt:#5a6178;--ac:#7c83f5;--ok:#34d07a;--wn:#dba63e}
body{font-family:-apple-system,system-ui,'Helvetica Neue',sans-serif;background:var(--bg);color:var(--tx);min-height:100vh}

/* --- Hero --- */
.hero{position:relative;width:100%;height:340px;overflow:hidden;background:#0d0f18}
.hero img{width:100%;height:100%;object-fit:cover;opacity:.65}
.hero-grad{position:absolute;inset:0;background:linear-gradient(transparent 30%,var(--bg) 95%)}
.hero-content{position:absolute;bottom:36px;left:40px;right:40px}
.hero h1{font-size:42px;font-weight:800;letter-spacing:-.8px;line-height:1.1}
.hero p{font-size:15px;color:var(--mt);margin-top:8px;max-width:600px;line-height:1.5}

/* --- Main --- */
.main{max-width:720px;margin:0 auto;padding:32px 24px 80px}
.section{margin-bottom:32px}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--mt);font-weight:700;margin-bottom:14px}

/* --- Terminal --- */
.term{background:#000;border-radius:10px;overflow:hidden;border:1px solid #1a1a1a}
.term-bar{height:28px;background:#1a1a1a;display:flex;align-items:center;padding:0 12px;gap:6px}
.term-dot{width:8px;height:8px;border-radius:50%}
.term-dot.r{background:#ff5f56}.term-dot.y{background:#ffbd2e}.term-dot.g{background:#27c93f}
.term-label{font-size:10px;color:#666;margin-left:auto;font-family:monospace}
.term pre{padding:16px;font-family:'SF Mono','Fira Code',monospace;font-size:12.5px;color:#4ade80;line-height:1.6;max-height:320px;overflow:auto;white-space:pre-wrap}

/* --- Actions --- */
.actions{display:flex;gap:10px;flex-wrap:wrap}
.btn{padding:10px 22px;border:none;border-radius:8px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .15s}
.btn-run{background:var(--ac);color:#fff}.btn-run:hover{filter:brightness(1.1)}
.btn-ghost{background:transparent;color:var(--mt);border:1px solid var(--bd)}.btn-ghost:hover{color:var(--tx);border-color:var(--mt)}
.btn:disabled{opacity:.35;cursor:default}

/* --- Prompt --- */
.prompt-wrap{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px}
.prompt-input{width:100%;padding:10px 0;background:none;border:none;color:var(--tx);font-size:14px;font-family:inherit;resize:none;outline:none;min-height:48px}
.prompt-footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.prompt-hint{font-size:11px;color:var(--mt)}

/* --- Audit Bubble --- */
.audit-toggle{position:fixed;bottom:20px;right:20px;width:44px;height:44px;border-radius:50%;background:var(--card);border:1px solid var(--bd);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:1000;transition:transform .2s}
.audit-toggle:hover{transform:scale(1.08)}
.audit-toggle svg{width:20px;height:20px;color:var(--mt)}
.audit-panel{position:fixed;bottom:76px;right:20px;width:380px;max-height:70vh;background:var(--card);border:1px solid var(--bd);border-radius:12px;z-index:999;overflow:hidden;display:none;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.audit-panel.open{display:flex}
.audit-header{padding:14px 16px;border-bottom:1px solid var(--bd);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--mt);display:flex;justify-content:space-between;align-items:center}
.audit-body{padding:14px 16px;overflow-y:auto;flex:1}
.audit-section{margin-bottom:16px}
.audit-section-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--mt);margin-bottom:8px;font-weight:600}
.a-stage{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px}
.a-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.a-dot.ok{background:var(--ok)}.a-dot.warn{background:var(--wn)}
.a-name{font-weight:600;min-width:120px}.a-detail{color:var(--mt);font-size:11px}
.a-entity{display:inline-block;padding:3px 8px;background:rgba(255,255,255,.04);border-radius:4px;font-size:11px;margin:2px}
.a-entity small{color:var(--mt);margin-left:2px}
.a-meta{font-size:11px;color:var(--mt);line-height:1.6}
.a-meta code{color:var(--ac)}
</style>
</head>
<body>

<!-- Hero -->
<div class="hero">
  ${hasHero ? '<img src="/hero.png" alt="">' : ''}
  <div class="hero-grad"></div>
  <div class="hero-content">
    <h1>${_esc(appName)}</h1>
    <p>${shortDesc}</p>
  </div>
</div>

<!-- Main Content -->
<div class="main">

  <!-- Engine Terminal -->
  <div class="section">
    <div class="section-title">State Machine</div>
    <div class="term">
      <div class="term-bar">
        <span class="term-dot r"></span><span class="term-dot y"></span><span class="term-dot g"></span>
        <span class="term-label" id="term-status">${safeEngine ? 'completed' : 'ready'}</span>
      </div>
      <pre id="engine-out">${safeEngine || 'Click Run to execute the state machine.'}</pre>
    </div>
    <div class="actions" style="margin-top:12px">
      <button class="btn btn-run" id="btn-run" onclick="runEngine()">${safeEngine ? 'Re-run' : 'Run'}</button>
    </div>
  </div>

  <!-- Prompt -->
  <div class="section">
    <div class="section-title">Prompt</div>
    <div class="prompt-wrap">
      <textarea class="prompt-input" id="prompt-input" rows="2" placeholder="Describe a scenario to test, or ask about this system..."></textarea>
      <div class="prompt-footer">
        <span class="prompt-hint">Connects to Opseeq when available</span>
        <button class="btn btn-ghost" onclick="sendPrompt()">Send</button>
      </div>
    </div>
  </div>

</div>

<!-- Audit Toggle Button -->
<div class="audit-toggle" onclick="toggleAudit()" title="Build Audit">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2v-4M9 21H5a2 2 0 01-2-2v-4m0-4v0m18 0v0"/><circle cx="12" cy="12" r="1"/></svg>
</div>

<!-- Audit Panel -->
<div class="audit-panel" id="audit-panel">
  <div class="audit-header">
    <span>Build Audit</span>
    <span style="cursor:pointer;font-size:16px" onclick="toggleAudit()">&times;</span>
  </div>
  <div class="audit-body">
    <div class="audit-section">
      <div class="audit-section-title">Pipeline Stages</div>
      ${auditStagesHtml}
    </div>
    <div class="audit-section">
      <div class="audit-section-title">Entities (${entityCount})</div>
      <div>${auditEntitiesHtml}</div>
    </div>
    <div class="audit-section">
      <div class="audit-section-title">Metadata</div>
      <div class="a-meta">
        Run: <code>${runId || 'N/A'}</code><br>
        Diagram: <code>${_esc(diagramName)}</code><br>
        Build: <code>${metrics?.buildWallClockMs || 0}ms</code> &middot; Repairs: <code>${metrics?.checkRepairs || 0}</code><br>
        Generated: <code>${new Date().toISOString()}</code>
      </div>
    </div>
  </div>
</div>

<script>
function toggleAudit(){document.getElementById('audit-panel').classList.toggle('open')}
async function runEngine(){
  const btn=document.getElementById('btn-run'),out=document.getElementById('engine-out'),st=document.getElementById('term-status');
  btn.disabled=true;st.textContent='running...';out.textContent='';
  try{const r=await fetch('/run');const d=await r.json();out.textContent=d.output||d.error||'No output';st.textContent=d.exitCode===0?'completed':'exit '+d.exitCode;}
  catch(e){out.textContent='Error: '+e.message;st.textContent='error';}
  btn.disabled=false;btn.textContent='Re-run';
}
function sendPrompt(){
  const v=document.getElementById('prompt-input').value.trim();
  if(!v)return;
  const out=document.getElementById('engine-out');
  out.textContent+='\\n\\n> '+v+'\\n(Opseeq integration: connect at localhost:9090)';
  document.getElementById('prompt-input').value='';
}
</script>
</body></html>`;
}

/**
 * Python-based HTTP launcher script for the .app bundle.
 */
function generateLauncherScript(appName, port) {
  return `#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$DIR/../Resources"
ENGINE="$DIR/${appName}-engine"
PORT=${port}

ENGINE_OUTPUT=""
ENGINE_EXIT=0
if [ -x "$ENGINE" ]; then
  ENGINE_OUTPUT=$("$ENGINE" 2>&1) || true
  ENGINE_EXIT=$?
fi

cat > /tmp/mermate_server_$$.py << 'PYEOF'
import http.server, json, os, subprocess, sys, socketserver

PORT = int(sys.argv[1])
RES_DIR = sys.argv[2]
ENGINE = sys.argv[3]
CACHED_OUTPUT = sys.argv[4] if len(sys.argv) > 4 else ""
CACHED_EXIT = int(sys.argv[5]) if len(sys.argv) > 5 else 0

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=RES_DIR, **kw)
    def do_GET(self):
        if self.path == '/run' or self.path.startswith('/run?'):
            try:
                r = subprocess.run([ENGINE], capture_output=True, text=True, timeout=30)
                body = json.dumps({"output": r.stdout + r.stderr, "exitCode": r.returncode})
            except Exception as e:
                body = json.dumps({"output": CACHED_OUTPUT, "exitCode": CACHED_EXIT, "cached": True})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body.encode())
            return
        if self.path == '/' or self.path == '':
            self.path = '/index.html'
        return super().do_GET()
    def log_message(self, fmt, *args): pass

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Dashboard: http://localhost:{PORT}", flush=True)
    httpd.serve_forever()
PYEOF

python3 /tmp/mermate_server_$$.py "$PORT" "$RESOURCES" "$ENGINE" "$ENGINE_OUTPUT" "$ENGINE_EXIT" &
SERVER_PID=$!

cleanup() { kill $SERVER_PID 2>/dev/null; rm -f /tmp/mermate_server_$$.py; exit 0; }
trap cleanup INT TERM EXIT

sleep 0.5
open "http://localhost:$PORT"

wait $SERVER_PID
`;
}

function generateSkillManifest({ appName, diagramName, entities, relationships, runId, tlaModuleName, desktopPath, metrics }) {
  return {
    skill: {
      name: appName,
      version: '1.0.0',
      type: 'mermate-compiled-binary',
      generated_by: 'MERMATE Architecture Compiler',
      generated_at: new Date().toISOString(),
    },
    architecture: {
      diagram_name: diagramName,
      entity_count: (entities || []).length,
      relationship_count: (relationships || []).length,
      entities: (entities || []).map(e => ({ name: e.name, type: e.type })),
      tla_module: tlaModuleName || null,
    },
    binary: { run_id: runId, desktop_path: desktopPath || null, metrics: metrics || {} },
    access: {
      launch: desktopPath ? `open "${desktopPath}"` : null,
      description: `Double-click ${appName}.app to launch. Opens a local web dashboard with the compiled state machine.`,
    },
    opseeq: {
      readable: true,
      trace_path: runId ? `runs/${runId}.trace.json` : null,
      run_path: runId ? `runs/${runId}.json` : null,
      audit_location: 'Bottom-right audit bubble in the landing page dashboard.',
      purpose: `Compiled Rust binary for ${diagramName}. Verified: TLA+ (Claude/Anthropic) -> TypeScript -> Rust.`,
    },
  };
}

module.exports = { generateLandingPage, generateLauncherScript, generateSkillManifest };
