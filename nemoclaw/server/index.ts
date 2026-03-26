import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cors from 'cors'
import express from 'express'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { z } from 'zod'
import {
  desktopDeveloperDir,
  getArchitectProfile,
  mermateDir,
  mermateEnvPath,
  runArchitectPipeline,
  scaffoldProjectFromRunId,
} from './architect.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const protoDir = path.join(rootDir, 'proto')

const gatewayName = process.env.OPENSHELL_GATEWAY ?? 'nemoclaw'
const sandboxName = process.env.NEMOCLAW_SANDBOX ?? 'aoc-local'
const clusterContainerName =
  process.env.NEMOCLAW_CLUSTER_CONTAINER ?? 'openshell-cluster-nemoclaw'
const port = Number(process.env.PORT ?? 8787)
const ollamaBaseUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const defaultOllamaModel = process.env.OLLAMA_MODEL ?? 'gpt-oss:20b'
const mermateBaseUrl = process.env.MERMATE_URL ?? 'http://127.0.0.1:3333'
const projectMcpPath = path.join(rootDir, '.mcp.json')
const cursorMcpPath = path.join(os.homedir(), '.cursor', 'mcp.json')
const desktopLauncherPath = path.join(os.homedir(), 'Desktop', 'OpenClaw Desktop.command')

const routeProxy = 'http://10.200.0.1:3128'
const modelsCommand =
  'curl -sk -x http://10.200.0.1:3128 https://inference.local/v1/models --max-time 20'
const chatCommand =
  'cat >/tmp/openshell-chat-request.json && curl -sk -x http://10.200.0.1:3128 https://inference.local/v1/chat/completions -H "Content-Type: application/json" --data-binary @/tmp/openshell-chat-request.json --max-time 120'

const packageDefinition = protoLoader.loadSync(
  [
    path.join(protoDir, 'datamodel.proto'),
    path.join(protoDir, 'inference.proto'),
    path.join(protoDir, 'openshell.proto'),
    path.join(protoDir, 'sandbox.proto'),
  ],
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  },
)

const loadedProto = grpc.loadPackageDefinition(packageDefinition) as ProtoRoot
const grpcEndpoint = resolveGrpcEndpoint()
const grpcCredentials = resolveGrpcCredentials()

const openShellClient = new loadedProto.openshell.v1.OpenShell(
  grpcEndpoint,
  grpcCredentials,
) as unknown as OpenShellClient

const inferenceClient = new loadedProto.openshell.inference.v1.Inference(
  grpcEndpoint,
  grpcCredentials,
) as unknown as InferenceClient

const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().trim().min(1).max(12000),
      }),
    )
    .min(1)
    .max(40),
  transport: z.enum(['openshell', 'ollama']).optional(),
  model: z.string().trim().min(1).max(160).optional(),
})

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9.-]+$/i, 'Host must be a bare hostname.')

const connectivityProbeSchema = z.object({
  host: hostSchema,
})

const architectPipelineSchema = z.object({
  source: z.string().trim().min(1).max(40000),
  diagramName: z.string().trim().min(1).max(120).optional(),
  inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
  maxMode: z.boolean().optional(),
  includeTla: z.boolean().optional(),
  includeTs: z.boolean().optional(),
  repoName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  scaffold: z.boolean().optional(),
})

const scaffoldRunSchema = z.object({
  runId: z.string().trim().min(1).max(120),
  repoName: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
  sourceIdea: z.string().trim().min(1).max(40000),
})

const preferredConnectivityTargets: ConnectivityTargetDefinition[] = [
  {
    label: 'Managed Inference',
    host: 'inference.local',
    path: '/v1/models',
    viaProxy: true,
    category: 'managed',
  },
  {
    label: 'GitHub',
    host: 'github.com',
    path: '/',
    viaProxy: false,
    category: 'egress',
  },
  {
    label: 'GitHub API',
    host: 'api.github.com',
    path: '/',
    viaProxy: false,
    category: 'egress',
  },
  {
    label: 'npm Registry',
    host: 'registry.npmjs.org',
    path: '/',
    viaProxy: false,
    category: 'egress',
  },
  {
    label: 'NVIDIA Integrate API',
    host: 'integrate.api.nvidia.com',
    path: '/',
    viaProxy: false,
    category: 'egress',
  },
  {
    label: 'OpenClaw Docs',
    host: 'docs.openclaw.ai',
    path: '/',
    viaProxy: false,
    category: 'egress',
  },
  {
    label: 'Telegram Bot API',
    host: 'api.telegram.org',
    path: '/',
    viaProxy: false,
    category: 'egress',
  },
]

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/status', async (_request, response) => {
  try {
    const [sandbox, providers, inference, routeProbe, allowedHosts, ollama, mermate, architect] =
      await Promise.all([
      getSandbox(sandboxName),
      listProviders(),
      getClusterInference(),
      probeInferenceRoute(),
      readAllowedHosts(),
      getOllamaState(),
      getMermateState(),
      getArchitectProfile(),
    ])

    response.json({
      gateway: {
        name: gatewayName,
        endpoint: loadGatewayMetadata().gateway_endpoint,
      },
      sandbox: {
        id: sandbox.id,
        name: sandbox.name,
        phase: sandbox.phase,
      },
      inference: {
        providerName: inference.providerName,
        modelId: inference.modelId,
        version: Number(inference.version ?? 0),
      },
      providers: providers.map((provider) => ({
        name: provider.name,
        type: provider.type,
      })),
      route: routeProbe,
      ollama,
      mermate,
      architect,
      claude: getClaudeIntegrationState(),
      allowedHosts,
      transport: {
        grpc: 'mTLS OpenShell gateway metadata',
        execution: 'docker exec -> kubectl exec -> inference.local',
        proxy: routeProxy,
      },
      launchers: {
        desktopCommandPath: desktopLauncherPath,
        projectMcpPath,
      },
      caveats: [
        'This console uses the live NemoClaw sandbox and managed inference route.',
        'The stock `openclaw agent` path is timing out in this environment, so the console currently targets stable transport surfaces directly.',
      ],
    })
  } catch (error) {
    response.status(500).json({
      error: formatError(error),
    })
  }
})

app.get('/api/architect/status', async (_request, response) => {
  try {
    const [architect, mermate] = await Promise.all([getArchitectProfile(), getMermateState()])

    response.json({
      architect,
      mermate,
      paths: {
        mermateDir,
        mermateEnvPath,
        desktopDeveloperDir,
      },
    })
  } catch (error) {
    response.status(500).json({
      error: formatError(error),
    })
  }
})

app.post('/api/architect/pipeline', async (request, response) => {
  try {
    const payload = architectPipelineSchema.parse(request.body)
    if (payload.scaffold && !payload.repoName) {
      response.status(400).json({
        error: 'repoName is required when scaffold is true.',
      })
      return
    }
    const result = await runArchitectPipeline(mermateBaseUrl, payload)

    response.status(result.quality.passes ? 200 : 422).json({
      success: result.quality.passes,
      ...result,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: 'Invalid architect pipeline payload',
        issues: error.issues,
      })
      return
    }

    response.status(500).json({
      error: formatError(error),
    })
  }
})

app.post('/api/builder/scaffold', async (request, response) => {
  try {
    const payload = scaffoldRunSchema.parse(request.body)
    const architect = await getArchitectProfile()
    const scaffold = await scaffoldProjectFromRunId({
      repoName: payload.repoName,
      sourceIdea: payload.sourceIdea,
      runId: payload.runId,
      architect,
    })

    response.json({
      success: true,
      scaffold,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: 'Invalid scaffold payload',
        issues: error.issues,
      })
      return
    }

    response.status(500).json({
      error: formatError(error),
    })
  }
})

app.get('/api/connectivity', async (_request, response) => {
  try {
    const allowedHosts = await readAllowedHosts()
    const targets = buildConnectivityTargets(allowedHosts)
    const probes = await Promise.all(targets.map((target) => probeConnectivityTarget(target)))

    response.json({
      generatedAt: new Date().toISOString(),
      probes,
    })
  } catch (error) {
    response.status(500).json({
      error: formatError(error),
    })
  }
})

app.post('/api/connectivity/probe', async (request, response) => {
  try {
    const { host } = connectivityProbeSchema.parse(request.body)
    const allowedHosts = await readAllowedHosts()

    if (host !== 'inference.local' && !allowedHosts.includes(host)) {
      response.status(403).json({
        error: `Host ${host} is not in the current sandbox allowlist.`,
      })
      return
    }

    const probe = await probeConnectivityTarget({
      label: host === 'inference.local' ? 'Managed Inference' : host,
      host,
      path: host === 'inference.local' ? '/v1/models' : '/',
      viaProxy: host === 'inference.local',
      category: host === 'inference.local' ? 'managed' : 'egress',
    })

    response.json({
      probe,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: 'Invalid connectivity probe payload',
        issues: error.issues,
      })
      return
    }

    response.status(500).json({
      error: formatError(error),
    })
  }
})

app.post('/api/chat', async (request, response) => {
  try {
    const parsed = chatRequestSchema.parse(request.body)

    if (parsed.transport === 'ollama') {
      const ollamaResult = await chatWithOllama(parsed.messages, parsed.model)
      response.status(ollamaResult.ok ? 200 : 502).json(ollamaResult.payload)
      return
    }

    const inference = await getClusterInference()
    const requestedModel = parsed.model || inference.modelId || 'router'
    const payload = {
      model: requestedModel,
      messages: parsed.messages,
      max_tokens: 640,
    }

    const result = await execInSandboxShell(chatCommand, {
      stdin: Buffer.from(JSON.stringify(payload), 'utf8'),
    })

    if (result.exitCode !== 0) {
      response.status(502).json({
        error: `Sandbox command failed with exit code ${result.exitCode}`,
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim(),
      })
      return
    }

    const raw = JSON.parse(result.stdout) as ChatCompletionResponse
    const choice = raw.choices?.[0]
    const content = choice?.message?.content?.trim()
    const actualModel = raw.model || requestedModel

    if (!content) {
      response.status(502).json({
        error: 'Inference route returned no assistant content.',
        requestedModel,
        actualModel,
        raw,
      })
      return
    }

    response.json({
      message: {
        role: 'assistant',
        content,
        reasoning: choice?.message.reasoning?.trim() || null,
      },
      raw,
      requestedModel,
      model: actualModel,
      warning:
        requestedModel !== actualModel
          ? `Managed route resolved ${actualModel} instead of ${requestedModel}.`
          : null,
      transport: 'openshell_exec_inference_local',
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: 'Invalid chat payload',
        issues: error.issues,
      })
      return
    }

    response.status(500).json({
      error: formatError(error),
    })
  }
})

const distDir = path.join(rootDir, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`nemoclaw-console server listening on http://127.0.0.1:${port}`)
})

async function getSandbox(name: string): Promise<SandboxRecord> {
  const response = await unary<GetSandboxResponse>(
    openShellClient.GetSandbox.bind(openShellClient),
    { name },
  )

  return response.sandbox
}

async function listProviders(): Promise<ProviderRecord[]> {
  const response = await unary<ListProvidersResponse>(
    openShellClient.ListProviders.bind(openShellClient),
    { limit: 100, offset: 0 },
  )

  return response.providers
}

async function getClusterInference(): Promise<InferenceConfigResponse> {
  return unary<InferenceConfigResponse>(
    inferenceClient.GetClusterInference.bind(inferenceClient),
    {},
  )
}

async function probeInferenceRoute(): Promise<RouteProbe> {
  const result = await execInSandboxShell(modelsCommand)

  if (result.exitCode !== 0) {
    return {
      healthy: false,
      models: [],
      error: result.stderr.trim() || `Exit code ${result.exitCode}`,
    }
  }

  try {
    const parsed = JSON.parse(result.stdout) as ModelsResponse
    return {
      healthy: true,
      models: parsed.data.map((model) => model.id),
    }
  } catch (error) {
    return {
      healthy: false,
      models: [],
      error: `Failed to parse route response: ${formatError(error)}`,
    }
  }
}

async function getOllamaState(): Promise<OllamaState> {
  const payload = await fetchJson<OllamaTagsResponse>(`${ollamaBaseUrl}/api/tags`, {
    timeoutMs: 1500,
  }).catch(() => null)

  const models = (payload?.models ?? []).map((model) => ({
    name: model.name,
    size: model.size,
    family: model.details.family || null,
    quantization: model.details.quantization_level || null,
    remoteHost: model.remote_host ?? null,
    remoteModel: model.remote_model ?? null,
    isCloud: Boolean(model.remote_host || model.remote_model),
  }))

  const available = models.length > 0

  return {
    available,
    baseUrl: ollamaBaseUrl,
    defaultModel: resolveDefaultOllamaModel(models),
    localModels: models.filter((model) => !model.isCloud),
    cloudModels: models.filter((model) => model.isCloud),
    models,
  }
}

async function getMermateState(): Promise<MermateState> {
  const copilot = await fetchJson<MermateCopilotHealth>(`${mermateBaseUrl}/api/copilot/health`, {
    timeoutMs: 900,
  }).catch(() => null)
  const tla = await fetchJson<MermateStageStatus>(`${mermateBaseUrl}/api/render/tla/status`, {
    timeoutMs: 900,
  }).catch(() => null)
  const ts = await fetchJson<MermateStageStatus>(`${mermateBaseUrl}/api/render/ts/status`, {
    timeoutMs: 900,
  }).catch(() => null)
  const modes = await fetchJson<MermateAgentModesResponse>(`${mermateBaseUrl}/api/agent/modes`, {
    timeoutMs: 900,
  }).catch(() => null)
  const agents = await fetchJson<MermateAgentCatalogResponse>(`${mermateBaseUrl}/api/agents`, {
    timeoutMs: 900,
  }).catch(() => null)
  const agentDomains = Array.from(
    new Set((agents?.agents ?? []).map((agent) => agent.domain).filter((value): value is string => Boolean(value))),
  ).sort()

  return {
    repoPath: mermateDir,
    envPath: mermateEnvPath,
    baseUrl: mermateBaseUrl,
    running: Boolean(copilot || tla || ts || modes || agents),
    copilotAvailable: copilot?.available ?? false,
    providers: copilot?.providers ?? null,
    maxModeAvailable: copilot?.maxAvailable ?? false,
    tlaAvailable: tla?.available ?? false,
    tsAvailable: ts?.available ?? false,
    agentModes: (modes?.modes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      stage: mode.stage,
    })),
    agentsLoaded: (agents?.agents ?? []).length,
    agentDomains,
  }
}

function getClaudeIntegrationState(): ClaudeIntegrationState {
  return {
    projectMcpPath,
    projectMcpConfigured: fs.existsSync(projectMcpPath),
    cursorMcpPath,
    cursorMcpDetected: fs.existsSync(cursorMcpPath),
    pluginMarketplaceDirectorySupported: true,
  }
}

function buildConnectivityTargets(allowedHosts: string[]): ConnectivityTarget[] {
  return preferredConnectivityTargets.filter((target) => {
    return target.host === 'inference.local' || allowedHosts.includes(target.host)
  })
}

async function probeConnectivityTarget(
  target: ConnectivityTargetDefinition,
): Promise<ConnectivityProbe> {
  const result = await execInSandboxShell(buildConnectivityProbeCommand(target))

  if (result.exitCode !== 0) {
    return {
      label: target.label,
      host: target.host,
      url: buildProbeUrl(target),
      category: target.category,
      viaProxy: target.viaProxy,
      reachable: false,
      httpStatus: null,
      latencyMs: null,
      note: result.stderr.trim() || `Probe failed with exit code ${result.exitCode}`,
    }
  }

  const [httpCodeValue, totalSecondsValue, remoteIpValue] = result.stdout.trim().split('\t')
  const httpStatus = Number(httpCodeValue)
  const totalSeconds = Number(totalSecondsValue)
  const noteParts = [
    target.viaProxy ? `proxy ${routeProxy}` : 'direct egress',
    remoteIpValue ? `remote ${remoteIpValue}` : null,
  ].filter(Boolean)

  return {
    label: target.label,
    host: target.host,
    url: buildProbeUrl(target),
    category: target.category,
    viaProxy: target.viaProxy,
    reachable: true,
    httpStatus: Number.isFinite(httpStatus) && httpStatus > 0 ? httpStatus : null,
    latencyMs:
      Number.isFinite(totalSeconds) && totalSeconds >= 0
        ? Math.round(totalSeconds * 1000)
        : null,
    note: noteParts.join(' · '),
  }
}

function buildConnectivityProbeCommand(target: ConnectivityTargetDefinition): string {
  const proxyArg = target.viaProxy ? `-x ${shellQuote(routeProxy)} ` : ''
  const headArg = target.category === 'managed' ? '' : '-I '

  return (
    `curl -sk ${headArg}--max-time 12 --connect-timeout 4 -o /dev/null -w ` +
    `${shellQuote('%{http_code}\t%{time_total}\t%{remote_ip}')} ` +
    `${proxyArg}${shellQuote(buildProbeUrl(target))}`
  )
}

function buildProbeUrl(target: Pick<ConnectivityTargetDefinition, 'host' | 'path'>): string {
  return `https://${target.host}${target.path}`
}

async function readAllowedHosts(): Promise<string[]> {
  const stdout = execFileSync('nemoclaw', [sandboxName, 'status'], {
    cwd: rootDir,
    encoding: 'utf8',
  })
  const clean = stripAnsi(stdout)
  const hosts = new Set<string>()

  for (const line of clean.split(/\r?\n/)) {
    const markerIndex = line.indexOf('host:')
    if (markerIndex === -1) {
      continue
    }

    const host = line
      .slice(markerIndex + 'host:'.length)
      .trim()
      .split(/\s+/)[0]

    if (host) {
      hosts.add(host)
    }
  }

  return Array.from(hosts).slice(0, 16)
}

async function chatWithOllama(
  messages: ChatMessageInput[],
  requestedModel?: string,
): Promise<ChatTransportResult> {
  const model = requestedModel || defaultOllamaModel
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  })

  const raw = (await response.json()) as OllamaChatResponse | { error?: string }

  if (!response.ok || !('message' in raw) || !raw.message?.content?.trim()) {
    return {
      ok: false,
      payload: {
        error:
          ('error' in raw && raw.error) ||
          `Ollama chat request failed with status ${response.status}`,
        requestedModel: model,
        model: 'model' in raw && typeof raw.model === 'string' ? raw.model : model,
        raw,
        transport: 'ollama_local',
      },
    }
  }

  return {
    ok: true,
    payload: {
      message: {
        role: raw.message.role,
        content: raw.message.content.trim(),
        reasoning: raw.message.thinking?.trim() || null,
      },
      raw,
      requestedModel: model,
      model: raw.model,
      warning:
        raw.model && raw.model !== model ? `Ollama resolved ${raw.model} instead of ${model}.` : null,
      transport: 'ollama_local',
    },
  }
}

async function execInSandboxShell(
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        clusterContainerName,
        'sh',
        '-lc',
        `kubectl exec -i -n openshell ${sandboxName} -- sh -lc ${shellQuote(command)}`,
      ],
      {
        cwd: rootDir,
      },
    )
    const stdoutParts: Buffer[] = []
    const stderrParts: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutParts.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrParts.push(chunk)
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutParts).toString('utf8'),
        stderr: Buffer.concat(stderrParts).toString('utf8'),
      })
    })

    if (options.stdin) {
      child.stdin.write(options.stdin)
    }

    child.stdin.end()
  })
}

function unary<TResponse>(
  method: UnaryMethod<TResponse>,
  request: object,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    method(request, (error, response) => {
      if (error) {
        reject(error)
        return
      }

      resolve(response)
    })
  })
}

function resolveGrpcEndpoint(): string {
  const metadata = loadGatewayMetadata()
  const endpoint = new URL(metadata.gateway_endpoint)
  const endpointPort = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')

  return `${endpoint.hostname}:${endpointPort}`
}

function resolveGrpcCredentials(): grpc.ChannelCredentials {
  const mtlsDir = path.join(
    os.homedir(),
    '.config',
    'openshell',
    'gateways',
    gatewayName,
    'mtls',
  )

  return grpc.credentials.createSsl(
    fs.readFileSync(path.join(mtlsDir, 'ca.crt')),
    fs.readFileSync(path.join(mtlsDir, 'tls.key')),
    fs.readFileSync(path.join(mtlsDir, 'tls.crt')),
  )
}

function loadGatewayMetadata(): GatewayMetadata {
  const metadataPath = path.join(
    os.homedir(),
    '.config',
    'openshell',
    'gateways',
    gatewayName,
    'metadata.json',
  )

  return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as GatewayMetadata
}

function stripAnsi(value: string): string {
  return String(value).replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
    '',
  )
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

async function fetchJson<T>(
  url: string,
  options: {
    timeoutMs?: number
  } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1200)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`)
    }

    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function resolveDefaultOllamaModel(models: OllamaModelSummary[]): string {
  return (
    models.find((model) => model.name === defaultOllamaModel)?.name ||
    models.find((model) => model.name === 'gpt-oss:20b')?.name ||
    models.find((model) => !model.isCloud)?.name ||
    models[0]?.name ||
    defaultOllamaModel
  )
}

type ProtoRoot = {
  openshell: {
    v1: {
      OpenShell: grpc.ServiceClientConstructor
    }
    inference: {
      v1: {
        Inference: grpc.ServiceClientConstructor
      }
    }
  }
}

type UnaryMethod<TResponse> = (
  request: object,
  callback: (error: grpc.ServiceError | null, response: TResponse) => void,
) => void

type OpenShellClient = grpc.Client & {
  GetSandbox: UnaryMethod<GetSandboxResponse>
  ListProviders: UnaryMethod<ListProvidersResponse>
}

type InferenceClient = grpc.Client & {
  GetClusterInference: UnaryMethod<InferenceConfigResponse>
}

type GatewayMetadata = {
  gateway_endpoint: string
}

type ProviderRecord = {
  name: string
  type: string
}

type SandboxRecord = {
  id: string
  name: string
  phase: string
}

type GetSandboxResponse = {
  sandbox: SandboxRecord
}

type ListProvidersResponse = {
  providers: ProviderRecord[]
}

type InferenceConfigResponse = {
  modelId: string
  providerName: string
  version: string | number
}

type ExecOptions = {
  stdin?: Buffer
}

type ExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type ModelsResponse = {
  data: Array<{
    id: string
  }>
}

type ChatCompletionResponse = {
  model?: string
  choices?: Array<{
    message: {
      content?: string
      reasoning?: string
    }
  }>
}

type RouteProbe = {
  healthy: boolean
  models: string[]
  error?: string
}

type ChatMessageInput = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type OllamaModelSummary = {
  name: string
  size: number
  family: string | null
  quantization: string | null
  remoteHost: string | null
  remoteModel: string | null
  isCloud: boolean
}

type OllamaState = {
  available: boolean
  baseUrl: string
  defaultModel: string
  localModels: OllamaModelSummary[]
  cloudModels: OllamaModelSummary[]
  models: OllamaModelSummary[]
}

type OllamaTagsResponse = {
  models: Array<{
    name: string
    size: number
    remote_host?: string
    remote_model?: string
    details: {
      family?: string
      quantization_level?: string
    }
  }>
}

type OllamaChatResponse = {
  model: string
  message: {
    role: 'assistant'
    content: string
    thinking?: string
  }
}

type ChatTransportResult = {
  ok: boolean
  payload: Record<string, unknown>
}

type ConnectivityCategory = 'managed' | 'egress'

type ConnectivityTargetDefinition = {
  label: string
  host: string
  path: string
  viaProxy: boolean
  category: ConnectivityCategory
}

type ConnectivityTarget = ConnectivityTargetDefinition

type ConnectivityProbe = {
  label: string
  host: string
  url: string
  category: ConnectivityCategory
  viaProxy: boolean
  reachable: boolean
  httpStatus: number | null
  latencyMs: number | null
  note: string
}

type MermateCopilotHealth = {
  available?: boolean
  providers?: {
    ollama?: boolean
    premium?: boolean
    enhancer?: boolean
  }
  maxAvailable?: boolean
}

type MermateStageStatus = {
  available?: boolean
}

type MermateAgentMode = {
  id: string
  label: string
  description: string
  stage: string
}

type MermateAgentModesResponse = {
  modes?: MermateAgentMode[]
}

type MermateCatalogAgent = {
  name: string
  role?: string
  stage?: string
  priority?: number
  domain?: string
}

type MermateAgentCatalogResponse = {
  agents?: MermateCatalogAgent[]
}

type MermateState = {
  repoPath: string
  envPath: string
  baseUrl: string
  running: boolean
  copilotAvailable: boolean
  providers: MermateCopilotHealth['providers'] | null
  maxModeAvailable: boolean
  tlaAvailable: boolean
  tsAvailable: boolean
  agentModes: MermateAgentMode[]
  agentsLoaded: number
  agentDomains: string[]
}

type ClaudeIntegrationState = {
  projectMcpPath: string
  projectMcpConfigured: boolean
  cursorMcpPath: string
  cursorMcpDetected: boolean
  pluginMarketplaceDirectorySupported: boolean
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
