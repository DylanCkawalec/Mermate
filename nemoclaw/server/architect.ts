import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const mermateDir = path.join(os.homedir(), 'Desktop', 'developer', 'mermaid')
export const mermateEnvPath = path.join(mermateDir, '.env')
export const desktopDeveloperDir = path.join(os.homedir(), 'Desktop', 'developer')
export const desktopRootDir = path.join(os.homedir(), 'Desktop')
const wrapperRootDir = path.join(os.homedir(), 'Desktop', 'developer', 'mermaid', 'nemoclaw')

export type ArchitectProfile = {
  envPath: string
  envPresent: boolean
  orchestratorModel: string | null
  workerModel: string | null
  routerModel: string | null
  structuredModel: string | null
  localFallbackModel: string | null
  got: {
    enabled: boolean
    maxDepth: number | null
    maxBranch: number | null
    stateBudget: number | null
    resultPolicy: string | null
  }
  architectAgents: {
    enabled: boolean
    total: number | null
    visionEnabled: boolean
  }
}

export type ArchitectPipelineRequest = {
  source: string
  diagramName?: string
  inputMode?: 'idea' | 'markdown' | 'mmd'
  maxMode?: boolean
  includeTla?: boolean
  includeTs?: boolean
  repoName?: string
  scaffold?: boolean
}

export async function getArchitectProfile(): Promise<ArchitectProfile> {
  const env = parseEnvFile(mermateEnvPath)

  return {
    envPath: mermateEnvPath,
    envPresent: fs.existsSync(mermateEnvPath),
    orchestratorModel: env.MERMATE_ORCHESTRATOR_MODEL ?? env.MERMATE_AI_MAX_MODEL ?? null,
    workerModel: env.MERMATE_WORKER_MODEL ?? env.MERMATE_AI_MODEL ?? null,
    routerModel: env.MERMATE_ROUTER_MODEL ?? null,
    structuredModel: env.MERMATE_STRUCTURED_MODEL ?? env.MERMATE_FAST_STRUCTURED_MODEL ?? null,
    localFallbackModel: env.LOCAL_LLM_MODEL ?? env.MERMATE_OLLAMA_MODEL ?? null,
    got: {
      enabled: env.GOT_CONTROLLER_ENABLED === 'true',
      maxDepth: numberOrNull(env.GOT_MAX_DEPTH),
      maxBranch: numberOrNull(env.GOT_MAX_BRANCH),
      stateBudget: numberOrNull(env.GOT_STATE_BUDGET),
      resultPolicy: env.GOT_RESULT_POLICY ?? null,
    },
    architectAgents: {
      enabled: env.ARCHITECT_AI_GLOBAL_ENABLED === 'true',
      total: numberOrNull(env.ARCHITECT_AI_TOTAL),
      visionEnabled: env.AGENT_VISION_ENABLED === 'true',
    },
  }
}

export async function runArchitectPipeline(
  mermateBaseUrl: string,
  request: ArchitectPipelineRequest,
): Promise<ArchitectPipelineResult> {
  const architect = await getArchitectProfile()
  const render = await requestJson<MermateRenderResponse>(`${mermateBaseUrl}/api/render`, {
    method: 'POST',
    body: JSON.stringify({
      mermaid_source: request.source,
      diagram_name: request.diagramName,
      input_mode: request.inputMode ?? 'idea',
      enhance: (request.inputMode ?? 'idea') !== 'mmd',
      max_mode: request.maxMode ?? true,
    }),
  })

  const effectiveIncludeTla = Boolean(request.includeTla || request.includeTs)
  let tla: MermateTlaResponse | null = null
  let ts: MermateTsResponse | null = null

  if (effectiveIncludeTla && render.run_id) {
    tla = await requestJson<MermateTlaResponse>(`${mermateBaseUrl}/api/render/tla`, {
      method: 'POST',
      body: JSON.stringify({
        run_id: render.run_id,
        diagram_name: render.diagram_name,
      }),
    })
  }

  if (request.includeTs && render.run_id) {
    ts = await requestJson<MermateTsResponse>(`${mermateBaseUrl}/api/render/ts`, {
      method: 'POST',
      body: JSON.stringify({
        run_id: render.run_id,
        diagram_name: render.diagram_name,
      }),
    })
  }

  const quality = evaluateQualityGate(render, tla, ts, effectiveIncludeTla, Boolean(request.includeTs))
  const scaffold =
    request.scaffold && request.repoName
      ? await scaffoldProjectFromArtifacts({
          repoName: request.repoName,
          request,
          architect,
          render,
          tla,
          ts,
          quality,
        })
      : null

  return {
    architect,
    render,
    tla,
    ts,
    quality,
    scaffold,
  }
}

export async function scaffoldProjectFromRunId(input: {
  repoName: string
  sourceIdea: string
  runId: string
  architect: ArchitectProfile
  quality?: QualityGate
}): Promise<ScaffoldResult> {
  const runJsonPath = path.join(mermateDir, 'runs', `${input.runId}.json`)
  const runData = JSON.parse(await fsp.readFile(runJsonPath, 'utf8')) as MermateRunFile
  const diagramName =
    runData.final_artifact?.diagram_name ||
    runData.user_request?.diagram_name ||
    runData.request?.user_diagram_name ||
    'architecture'

  const render: MermateRenderResponse = {
    success: true,
    diagram_name: diagramName,
    compiled_source: await readArtifactText(path.join(mermateDir, 'flows', diagramName, `${diagramName}.mmd`)),
    paths: runData.final_artifact?.artifacts ?? {},
    validation: {
      svg_valid: Boolean(runData.final_artifact?.validation?.svg_valid),
      png_valid: Boolean(runData.final_artifact?.validation?.png_valid),
    },
    render_meta: {
      attempts: runData.final_artifact?.compile_attempts ?? 1,
      max_mode: true,
    },
    mmd_metrics: {
      nodeCount: runData.final_artifact?.metrics?.node_count ?? 0,
      edgeCount: runData.final_artifact?.metrics?.edge_count ?? 0,
      subgraphCount: runData.final_artifact?.metrics?.subgraph_count ?? 0,
    },
    run_id: input.runId,
  }

  let tla: MermateTlaResponse | null = null
  if (runData.tla_artifacts?.tla) {
    const tlaPath = path.join(mermateDir, runData.tla_artifacts.tla.replace(/^\//, ''))
    const cfgPath = path.join(mermateDir, (runData.tla_artifacts.cfg ?? '').replace(/^\//, ''))
    tla = {
      success: true,
      tla_source: await readArtifactText(tlaPath),
      cfg_source: cfgPath ? await readArtifactText(cfgPath) : '',
      sany: { valid: true },
      paths: runData.tla_artifacts,
    }
  }

  let ts: MermateTsResponse | null = null
  if (runData.ts_artifacts?.source) {
    const sourcePath = path.join(mermateDir, runData.ts_artifacts.source.replace(/^\//, ''))
    const harnessPath = path.join(mermateDir, (runData.ts_artifacts.harness ?? '').replace(/^\//, ''))
    ts = {
      success: Boolean(runData.ts_metrics?.success),
      ts_source: await readArtifactText(sourcePath),
      harness_source: harnessPath ? await readArtifactText(harnessPath) : '',
      paths: runData.ts_artifacts,
    }
  }

  return scaffoldProjectFromArtifacts({
    repoName: input.repoName,
    request: {
      source: input.sourceIdea,
      repoName: input.repoName,
      scaffold: true,
    },
    architect: input.architect,
    render,
    tla,
    ts,
    quality:
      input.quality ??
      evaluateQualityGate(render, tla, ts, Boolean(tla), Boolean(ts)),
  })
}

type ArchitectPipelineResult = {
  architect: ArchitectProfile
  render: MermateRenderResponse
  tla: MermateTlaResponse | null
  ts: MermateTsResponse | null
  quality: QualityGate
  scaffold: ScaffoldResult | null
}

type QualityGate = {
  passes: boolean
  score: number
  stage: 'mmd' | 'tla' | 'ts'
  issues: string[]
}

type ScaffoldResult = {
  repoRoot: string
  repoName: string
  files: string[]
  skillPath: string
  mcpPath: string
  launcherPath: string
  desktopCommandPath: string
  appEntryPath: string
  desktopPort: number
}

type MermateRenderResponse = {
  success: boolean
  diagram_name: string
  compiled_source: string
  paths: Record<string, string | null | undefined>
  validation: {
    svg_valid: boolean
    png_valid: boolean
  }
  render_meta?: {
    attempts?: number
    max_mode?: boolean
  }
  mmd_metrics?: {
    nodeCount?: number
    edgeCount?: number
    subgraphCount?: number
  }
  run_id?: string
}

type MermateTlaResponse = {
  success: boolean
  tla_source: string
  cfg_source: string
  sany?: {
    valid?: boolean
  }
  paths?: Record<string, string | null>
}

type MermateTsResponse = {
  success: boolean
  ts_source: string
  harness_source: string
  paths?: Record<string, string | null>
}

type MermateRunFile = {
  request?: {
    user_diagram_name?: string
  }
  user_request?: {
    diagram_name?: string
  }
  final_artifact?: {
    diagram_name?: string
    metrics?: {
      node_count?: number
      edge_count?: number
      subgraph_count?: number
    }
    validation?: {
      svg_valid?: boolean
      png_valid?: boolean
    }
    artifacts?: Record<string, string | null | undefined>
    compile_attempts?: number
  }
  tla_artifacts?: {
    tla?: string
    cfg?: string
    trace?: string | null
  }
  ts_artifacts?: {
    source?: string
    harness?: string
    validation?: string
  }
  ts_metrics?: {
    success?: boolean
  }
}

function evaluateQualityGate(
  render: MermateRenderResponse,
  tla: MermateTlaResponse | null,
  ts: MermateTsResponse | null,
  expectedTla: boolean,
  expectedTs: boolean,
): QualityGate {
  const issues: string[] = []

  if (!render.success) {
    issues.push('Mermaid render did not complete successfully.')
  }
  if (!render.validation.svg_valid || !render.validation.png_valid) {
    issues.push('Rendered Mermaid artifacts did not validate cleanly as SVG and PNG.')
  }
  if ((render.mmd_metrics?.nodeCount ?? 0) < 2) {
    issues.push('Compiled Mermaid output is too small to qualify as a production design.')
  }
  if (expectedTla && !tla?.success) {
    issues.push('TLA stage did not complete successfully.')
  }
  if (expectedTla && !tla?.sany?.valid) {
    issues.push('TLA stage did not pass SANY validation.')
  }
  if (expectedTs && !ts?.success) {
    issues.push('TypeScript stage did not pass validation.')
  }

  const stage: QualityGate['stage'] = expectedTs ? 'ts' : expectedTla ? 'tla' : 'mmd'
  const score = Math.max(0, 100 - issues.length * 18)

  return {
    passes: issues.length === 0,
    score,
    stage,
    issues,
  }
}

async function scaffoldProjectFromArtifacts(input: {
  repoName: string
  request: ArchitectPipelineRequest
  architect: ArchitectProfile
  render: MermateRenderResponse
  tla: MermateTlaResponse | null
  ts: MermateTsResponse | null
  quality: QualityGate
}): Promise<ScaffoldResult> {
  if (!input.quality.passes) {
    throw new Error(
      `Quality gate failed, refusing to scaffold junk output: ${input.quality.issues.join(' ')}`,
    )
  }

  const repoName = sanitizeRepoName(input.repoName)
  const repoRoot = path.join(desktopDeveloperDir, repoName)
  const specDir = path.join(repoRoot, 'app-spec')
  const claudeDir = path.join(repoRoot, '.claude')
  const skillDir = path.join(claudeDir, 'skills', 'openclaw-project-builder')
  const srcDir = path.join(repoRoot, 'src')
  const mcpPath = path.join(repoRoot, '.mcp.json')
  const runScriptPath = path.join(repoRoot, 'run.sh')
  const desktopPort = deriveDesktopPort(repoName)
  const desktopCommandPath = path.join(desktopRootDir, `Launch ${repoName}.command`)
  const files: string[] = []

  if (fs.existsSync(repoRoot)) {
    throw new Error(`Target repo already exists at ${repoRoot}`)
  }
  if (fs.existsSync(desktopCommandPath)) {
    throw new Error(`Desktop launcher already exists at ${desktopCommandPath}`)
  }

  await fsp.mkdir(specDir, { recursive: true })
  await fsp.mkdir(skillDir, { recursive: true })
  await fsp.mkdir(srcDir, { recursive: true })

  const specFiles = [
    'app-spec/idea.md',
    'app-spec/architecture.mmd',
    ...(input.tla?.tla_source ? ['app-spec/spec.tla', 'app-spec/spec.cfg'] : []),
    ...(input.ts?.ts_source ? ['app-spec/runtime.ts', 'app-spec/runtime.harness.ts'] : []),
  ]

  await writeFileTracked(
    path.join(repoRoot, 'README.md'),
    buildProjectReadme(repoName, input.request.source, input.quality, desktopPort),
    files,
  )
  await writeFileTracked(
    path.join(repoRoot, 'CLAUDE.md'),
    buildClaudeInstructions(repoName, specFiles),
    files,
  )
  await writeFileTracked(path.join(repoRoot, '.gitignore'), buildGitIgnore(), files)
  await writeFileTracked(path.join(repoRoot, 'package.json'), buildStarterPackageJson(repoName, desktopPort), files)
  await writeFileTracked(path.join(repoRoot, 'eslint.config.js'), buildStarterEslintConfig(), files)
  await writeFileTracked(path.join(repoRoot, 'tsconfig.json'), buildStarterTsconfig(), files)
  await writeFileTracked(path.join(repoRoot, 'tsconfig.app.json'), buildStarterTsconfigApp(), files)
  await writeFileTracked(path.join(repoRoot, 'vite.config.ts'), buildStarterViteConfig(desktopPort), files)
  await writeFileTracked(path.join(repoRoot, 'index.html'), buildStarterIndexHtml(repoName), files)
  await writeFileTracked(
    path.join(specDir, 'idea.md'),
    input.request.source.trim(),
    files,
  )
  await writeFileTracked(
    path.join(specDir, 'architecture.mmd'),
    input.render.compiled_source.trim(),
    files,
  )
  await writeFileTracked(
    path.join(specDir, 'manifest.json'),
    JSON.stringify(
      {
        repo_name: repoName,
        generated_at: new Date().toISOString(),
        diagram_name: input.render.diagram_name,
        wrapper_root: wrapperRootDir,
        launcher: {
          desktop_port: desktopPort,
          run_script: runScriptPath,
          desktop_command: desktopCommandPath,
        },
        production_filter: {
          mode: 'production-only',
          policy: 'No placeholder demos, duplicate architectures, or throwaway scaffolds.',
          allowed_paths: [
            'app-spec/',
            'src/',
            '.claude/skills/openclaw-project-builder/',
            '.mcp.json',
            'README.md',
            'CLAUDE.md',
            'package.json',
            'tsconfig.json',
            'tsconfig.app.json',
            'vite.config.ts',
            'index.html',
            'run.sh',
          ],
        },
        quality: input.quality,
        architect: input.architect,
      },
      null,
      2,
    ),
    files,
  )

  if (input.tla?.tla_source) {
    await writeFileTracked(path.join(specDir, 'spec.tla'), input.tla.tla_source.trim(), files)
  }
  if (input.tla?.cfg_source) {
    await writeFileTracked(path.join(specDir, 'spec.cfg'), input.tla.cfg_source.trim(), files)
  }
  if (input.ts?.ts_source) {
    await writeFileTracked(path.join(specDir, 'runtime.ts'), input.ts.ts_source.trim(), files)
  }
  if (input.ts?.harness_source) {
    await writeFileTracked(
      path.join(specDir, 'runtime.harness.ts'),
      input.ts.harness_source.trim(),
      files,
    )
  }

  await writeFileTracked(
    path.join(skillDir, 'SKILL.md'),
    buildProjectSkill(repoName, specFiles),
    files,
  )
  await writeFileTracked(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          openclaw_desktop: {
            command: 'npm',
            args: ['--prefix', wrapperRootDir, 'run', 'mcp'],
            env: {
              OPENCLAW_CONSOLE_URL: 'http://127.0.0.1:8787',
              MERMATE_URL: 'http://127.0.0.1:3333',
            },
          },
        },
      },
      null,
      2,
    ),
    files,
  )
  await writeFileTracked(path.join(srcDir, 'main.tsx'), buildStarterMainModule(), files)
  await writeFileTracked(path.join(srcDir, 'spec.ts'), buildStarterSpecModule({
    repoName,
    repoRoot,
    source: input.request.source.trim(),
    architect: input.architect,
    quality: input.quality,
    render: input.render,
    tla: input.tla,
    ts: input.ts,
    desktopPort,
    runScriptPath,
    desktopCommandPath,
  }), files)
  await writeFileTracked(path.join(srcDir, 'App.tsx'), buildStarterAppModule(), files)
  await writeFileTracked(path.join(srcDir, 'index.css'), buildStarterIndexStyles(), files)
  await writeFileTracked(path.join(srcDir, 'App.css'), buildStarterAppStyles(), files)
  await writeFileTracked(runScriptPath, buildStarterRunScript(repoName, desktopPort), files)
  await fsp.chmod(runScriptPath, 0o755)
  await writeFileTracked(desktopCommandPath, buildDesktopCommand(runScriptPath), files)
  await fsp.chmod(desktopCommandPath, 0o755)

  return {
    repoRoot,
    repoName,
    files,
    skillPath: path.join(skillDir, 'SKILL.md'),
    mcpPath,
    launcherPath: runScriptPath,
    desktopCommandPath,
    appEntryPath: path.join(srcDir, 'App.tsx'),
    desktopPort,
  }
}

async function writeFileTracked(filePath: string, contents: string, files: string[]) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, contents, 'utf8')
  files.push(filePath)
}

function buildProjectReadme(
  repoName: string,
  idea: string,
  quality: QualityGate,
  desktopPort: number,
): string {
  return `# ${repoName}

This repository was scaffolded by the OpenClaw desktop builder.

## Intent

${idea.trim()}

## Spec bundle

- \`app-spec/idea.md\`
- \`app-spec/architecture.mmd\`
- \`app-spec/spec.tla\` when formal verification succeeded
- \`app-spec/runtime.ts\` when the TypeScript runtime stage succeeded
- \`src/spec.ts\` for the app-facing view of the design bundle
- \`src/App.tsx\` for the starter desktop-window UI

## Quality gate

- Stage: ${quality.stage}
- Score: ${quality.score}
- Pass: ${quality.passes ? 'yes' : 'no'}

## Launch

- \`./run.sh\` builds this starter, serves it on \`http://127.0.0.1:${desktopPort}\`, and opens it in a clean app-style browser window
- \`~/Desktop/Launch ${repoName}.command\` points at the same launcher for one-click start

Build from the spec bundle first. Avoid placeholder files, dead demos, and duplicate architecture variants.
`
}

function buildClaudeInstructions(repoName: string, specFiles: string[]): string {
  return `# ${repoName} Builder Rules

You are building a production-quality application from the spec bundle in \`app-spec/\`.

Rules:

- Start from \`app-spec/idea.md\`, \`app-spec/architecture.mmd\`, and any available \`.tla\` and \`.ts\` artifacts
- Treat these curated files as the only allowed starting bundle: ${specFiles.join(', ')}
- Keep only one primary implementation path
- Do not generate junk examples, filler demos, placeholder components, or duplicate scaffolds
- Treat the Mermate outputs as design intent, not as disposable notes
- Use the local \`openclaw_desktop\` MCP server when you need the builder wrapper again
`
}

function buildProjectSkill(repoName: string, specFiles: string[]): string {
  return `---
name: ${repoName}-builder
description: Use when building this project from the OpenClaw spec bundle in app-spec/.
---

# ${repoName} Builder

Start from the files in \`app-spec/\`.

Execution order:

1. Read \`app-spec/idea.md\`
2. Read \`app-spec/architecture.mmd\`
3. If present, use \`app-spec/spec.tla\` and \`app-spec/spec.cfg\` as behavioral constraints
4. If present, use \`app-spec/runtime.ts\` as the strongest starting runtime artifact
5. Keep the generated starter app in \`src/\` aligned with the spec bundle
6. Use only this curated input set: ${specFiles.join(', ')}
7. Build one clean implementation path with no placeholder demos or junk scaffolds
`
}

function buildGitIgnore(): string {
  return `node_modules
dist
.DS_Store
logs
`
}

function buildStarterPackageJson(repoName: string, desktopPort: number): string {
  return JSON.stringify(
    {
      name: repoName,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: `vite --host 127.0.0.1 --port ${desktopPort}`,
        build: 'tsc -b && vite build',
        lint: 'eslint .',
        preview: `vite preview --host 127.0.0.1 --port ${desktopPort}`,
        'desktop:launch': './run.sh',
      },
      dependencies: {
        react: '^19.2.4',
        'react-dom': '^19.2.4',
      },
      devDependencies: {
        '@eslint/js': '^9.39.4',
        '@types/node': '^24.12.0',
        '@types/react': '^19.2.14',
        '@types/react-dom': '^19.2.3',
        '@vitejs/plugin-react': '^6.0.1',
        eslint: '^9.39.4',
        'eslint-plugin-react-hooks': '^7.0.1',
        'eslint-plugin-react-refresh': '^0.5.2',
        globals: '^17.4.0',
        typescript: '~5.9.3',
        'typescript-eslint': '^8.57.0',
        vite: '^8.0.1',
      },
    },
    null,
    2,
  )
}

function buildStarterEslintConfig(): string {
  return `import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
`
}

function buildStarterTsconfig(): string {
  return `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" }
  ]
}
`
}

function buildStarterTsconfigApp(): string {
  return `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2023",
    "useDefineForClassFields": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}
`
}

function buildStarterViteConfig(desktopPort: number): string {
  return `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: ${desktopPort},
  },
  preview: {
    host: '127.0.0.1',
    port: ${desktopPort},
  },
})
`
}

function buildStarterIndexHtml(repoName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${repoName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function buildStarterMainModule(): string {
  return `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`
}

function buildStarterSpecModule(input: {
  repoName: string
  repoRoot: string
  source: string
  architect: ArchitectProfile
  quality: QualityGate
  render: MermateRenderResponse
  tla: MermateTlaResponse | null
  ts: MermateTsResponse | null
  desktopPort: number
  runScriptPath: string
  desktopCommandPath: string
}): string {
  const payload = {
    repoName: input.repoName,
    repoRoot: input.repoRoot,
    desktopPort: input.desktopPort,
    launchers: {
      runScript: input.runScriptPath,
      desktopCommand: input.desktopCommandPath,
      wrapperConsole: 'http://127.0.0.1:8787',
      mermateWorkspace: 'http://127.0.0.1:3333',
    },
    quality: input.quality,
    architect: input.architect,
    design: {
      idea: input.source,
      diagramName: input.render.diagram_name,
      runId: input.render.run_id ?? null,
      mermaid: input.render.compiled_source.trim(),
      tla: input.tla?.tla_source.trim() || null,
      cfg: input.tla?.cfg_source.trim() || null,
      runtime: input.ts?.ts_source.trim() || null,
      harness: input.ts?.harness_source.trim() || null,
    },
    productionFilter: {
      mode: 'production-only',
      rules: [
        'Keep one implementation path.',
        'Do not generate filler demos, mock data galleries, or duplicate repos.',
        'Promote the app-spec bundle into the product intentionally.',
      ],
    },
  }

  return `export const builderSpec = ${JSON.stringify(payload, null, 2)} as const
`
}

function buildStarterAppModule(): string {
  return `import './App.css'
import { builderSpec } from './spec'

const artifacts = [
  {
    label: 'Idea',
    available: true,
    body: builderSpec.design.idea,
  },
  {
    label: 'Mermaid',
    available: Boolean(builderSpec.design.mermaid),
    body: builderSpec.design.mermaid || 'No Mermaid bundle was generated.',
  },
  {
    label: 'TLA+',
    available: Boolean(builderSpec.design.tla),
    body: builderSpec.design.tla || 'This run did not emit a TLA+ specification.',
  },
  {
    label: 'Runtime',
    available: Boolean(builderSpec.design.runtime),
    body: builderSpec.design.runtime || 'This run did not emit a TypeScript runtime.',
  },
] as const

export default function App() {
  return (
    <main className="builder-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">OpenClaw Application Builder Starter</p>
          <h1>{builderSpec.repoName}</h1>
          <p className="lead">
            This starter app was scaffolded from a live Mermate architect run and is intended to
            stay aligned with the spec bundle instead of drifting into disposable prototype code.
          </p>
        </div>

        <div className="hero-grid">
          <article className="summary-card">
            <span className="summary-label">Quality Gate</span>
            <strong>{builderSpec.quality.stage.toUpperCase()} · {builderSpec.quality.score}</strong>
            <p>{builderSpec.quality.passes ? 'Passed curated output gate.' : builderSpec.quality.issues.join(' ')}</p>
          </article>
          <article className="summary-card">
            <span className="summary-label">Architect Brain</span>
            <strong>{builderSpec.architect.orchestratorModel || 'unknown'}</strong>
            <p>{builderSpec.architect.workerModel || 'unknown'} worker · {builderSpec.architect.localFallbackModel || 'no fallback'} fallback</p>
          </article>
          <article className="summary-card">
            <span className="summary-label">Launch</span>
            <strong>127.0.0.1:{builderSpec.desktopPort}</strong>
            <p>{builderSpec.launchers.runScript}</p>
          </article>
        </div>
      </section>

      <section className="panel-grid">
        <article className="panel">
          <h2>Builder Contract</h2>
          <ul>
            {builderSpec.productionFilter.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </article>
        <article className="panel">
          <h2>Attached Systems</h2>
          <dl className="meta-list">
            <div>
              <dt>Wrapper</dt>
              <dd>{builderSpec.launchers.wrapperConsole}</dd>
            </div>
            <div>
              <dt>Mermate</dt>
              <dd>{builderSpec.launchers.mermateWorkspace}</dd>
            </div>
            <div>
              <dt>Run ID</dt>
              <dd>{builderSpec.design.runId || 'n/a'}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="artifact-grid">
        {artifacts.map((artifact) => (
          <article className="artifact-card" key={artifact.label}>
            <header>
              <span>{artifact.label}</span>
              <strong>{artifact.available ? 'Available' : 'Skipped'}</strong>
            </header>
            <pre>{artifact.body}</pre>
          </article>
        ))}
      </section>
    </main>
  )
}
`
}

function buildStarterIndexStyles(): string {
  return `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;700&display=swap');

:root {
  color-scheme: dark;
  --bg: #100d14;
  --panel: rgba(26, 20, 34, 0.88);
  --line: rgba(255, 255, 255, 0.08);
  --text: #efe2d1;
  --muted: #c29d75;
  --accent: #ff8f45;
  --accent-soft: rgba(255, 143, 69, 0.18);
  --sans: 'Space Grotesk', 'Avenir Next', sans-serif;
  --mono: 'IBM Plex Mono', monospace;
  font: 16px/1.55 var(--sans);
  background:
    radial-gradient(circle at top, rgba(255, 143, 69, 0.2), transparent 35%),
    linear-gradient(180deg, #0d0a10, #100d14 35%, #0d0a10);
  color: var(--text);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  min-height: 100%;
}

body {
  margin: 0;
}

button,
input,
textarea {
  font: inherit;
}
`
}

function buildStarterAppStyles(): string {
  return `.builder-shell {
  width: min(1240px, calc(100vw - 40px));
  margin: 0 auto;
  padding: 36px 0 48px;
}

.hero {
  display: grid;
  gap: 24px;
  margin-bottom: 24px;
}

.eyebrow {
  margin: 0 0 12px;
  text-transform: uppercase;
  letter-spacing: 0.24em;
  font-size: 0.74rem;
  color: var(--muted);
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: clamp(2.8rem, 7vw, 5rem);
  line-height: 0.92;
  letter-spacing: -0.06em;
}

h2 {
  font-size: 1.15rem;
  letter-spacing: -0.02em;
}

.lead {
  max-width: 70ch;
  color: rgba(239, 226, 209, 0.82);
}

.hero-grid,
.panel-grid,
.artifact-grid {
  display: grid;
  gap: 16px;
}

.hero-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.panel-grid {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  margin-bottom: 18px;
}

.artifact-grid {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.summary-card,
.panel,
.artifact-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 24px;
  padding: 18px;
  box-shadow:
    0 20px 50px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.summary-card {
  display: grid;
  gap: 6px;
}

.summary-card strong,
.artifact-card strong {
  color: var(--text);
}

.summary-card p,
.panel li,
.meta-list dd {
  color: rgba(239, 226, 209, 0.78);
}

.summary-label,
.artifact-card span,
.meta-list dt {
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.74rem;
  color: var(--muted);
}

.panel ul {
  margin: 14px 0 0;
  padding-left: 1.2rem;
}

.meta-list {
  display: grid;
  gap: 12px;
  margin-top: 14px;
}

.meta-list div {
  display: grid;
  gap: 4px;
}

.meta-list dd {
  margin: 0;
  word-break: break-word;
}

.artifact-card {
  display: grid;
  gap: 12px;
}

.artifact-card header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.artifact-card pre {
  margin: 0;
  min-height: 240px;
  padding: 14px;
  border-radius: 18px;
  background: rgba(8, 7, 11, 0.64);
  border: 1px solid rgba(255, 255, 255, 0.04);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 0.84rem/1.6 var(--mono);
}

@media (max-width: 760px) {
  .builder-shell {
    width: min(100vw - 20px, 1240px);
    padding-top: 20px;
  }
}
`
}

function buildStarterRunScript(repoName: string, desktopPort: number): string {
  return `#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP_URL="http://127.0.0.1:${desktopPort}"
LOG_DIR="\${ROOT_DIR}/logs"

mkdir -p "\${LOG_DIR}"

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts=0

  while [ "\${attempts}" -lt 60 ]; do
    if curl -fsS "\${url}" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  echo "Timed out waiting for \${label} at \${url}" >&2
  return 1
}

open_app_window() {
  local url="$1"

  for app in "Google Chrome" "Chromium" "Brave Browser" "Microsoft Edge"; do
    if [ -d "/Applications/\${app}.app" ]; then
      open -na "\${app}" --args --app="\${url}" >/dev/null 2>&1
      return 0
    fi
  done

  open "\${url}"
}

ensure_dependencies() {
  if [ -d "\${ROOT_DIR}/node_modules" ]; then
    return 0
  fi

  echo "Installing dependencies for ${repoName}..."
  (
    cd "\${ROOT_DIR}"
    npm install > "\${LOG_DIR}/npm-install.log" 2>&1
  )
}

ensure_app() {
  if curl -fsS "\${APP_URL}" >/dev/null 2>&1; then
    echo "${repoName} already running."
    return 0
  fi

  ensure_dependencies

  echo "Building ${repoName}..."
  (
    cd "\${ROOT_DIR}"
    npm run build > "\${LOG_DIR}/build.log" 2>&1
  )

  echo "Starting ${repoName} preview server..."
  (
    cd "\${ROOT_DIR}"
    nohup npm run preview > "\${LOG_DIR}/preview.log" 2>&1 &
  )

  wait_for_http "\${APP_URL}" "${repoName}"
}

ensure_app
open_app_window "\${APP_URL}"

echo "${repoName} ready at \${APP_URL}"
`
}

function buildDesktopCommand(runScriptPath: string): string {
  return `#!/usr/bin/env bash

exec ${JSON.stringify(runScriptPath)}
`
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {}
  }

  const output: Record<string, string> = {}
  const contents = fs.readFileSync(filePath, 'utf8')
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')
    if (separator === -1) {
      continue
    }

    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')

    if (key.endsWith('KEY') || key.includes('TOKEN') || key.includes('SECRET')) {
      continue
    }

    output[key] = value
  }

  return output
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600_000)

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    })

    const payload = (await response.json().catch(() => null)) as T | null
    if (!response.ok) {
      const errorMessage =
        payload && typeof payload === 'object' && payload !== null && 'error' in payload
          ? String(payload.error)
          : `${url} returned ${response.status}`
      throw new Error(errorMessage)
    }

    if (payload == null) {
      throw new Error(`${url} returned an empty payload`)
    }

    return payload
  } finally {
    clearTimeout(timer)
  }
}

function sanitizeRepoName(value: string): string {
  const clean = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!clean) {
    throw new Error('Repository name must contain at least one letter or number.')
  }

  return clean
}

function deriveDesktopPort(repoName: string): number {
  let hash = 0
  for (const character of repoName) {
    hash = (hash * 31 + character.charCodeAt(0)) % 500
  }

  return 4300 + hash
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function readArtifactText(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}
