import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Role = 'assistant' | 'user'
type ChatTransport = 'openshell' | 'ollama'
type ArchitectInputMode = 'idea' | 'markdown' | 'mmd'

type ChatMessage = {
  id: string
  role: Role
  content: string
  reasoning?: string | null
  transport?: ChatTransport
  model?: string | null
  warning?: string | null
}

type OllamaModel = {
  name: string
  size: number
  family: string | null
  quantization: string | null
  remoteHost: string | null
  remoteModel: string | null
  isCloud: boolean
}

type ArchitectProfile = {
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

type MermateAgentMode = {
  id: string
  label: string
  description: string
  stage: string
}

type StatusPayload = {
  gateway: {
    name: string
    endpoint: string
  }
  sandbox: {
    id: string
    name: string
    phase: string
  }
  inference: {
    providerName: string
    modelId: string
    version: number
  }
  providers: Array<{
    name: string
    type: string
  }>
  route: {
    healthy: boolean
    models: string[]
    error?: string
  }
  ollama: {
    available: boolean
    baseUrl: string
    defaultModel: string
    localModels: OllamaModel[]
    cloudModels: OllamaModel[]
    models: OllamaModel[]
  }
  mermate: {
    repoPath: string
    envPath: string
    baseUrl: string
    running: boolean
    copilotAvailable: boolean
    providers: {
      ollama?: boolean
      premium?: boolean
      enhancer?: boolean
    } | null
    maxModeAvailable: boolean
    tlaAvailable: boolean
    tsAvailable: boolean
    agentModes: MermateAgentMode[]
    agentsLoaded: number
    agentDomains: string[]
  }
  architect: ArchitectProfile
  claude: {
    projectMcpPath: string
    projectMcpConfigured: boolean
    cursorMcpPath: string
    cursorMcpDetected: boolean
    pluginMarketplaceDirectorySupported: boolean
  }
  allowedHosts: string[]
  transport: {
    grpc: string
    execution: string
    proxy: string
  }
  launchers: {
    desktopCommandPath: string
    projectMcpPath: string
  }
  caveats: string[]
}

type ConnectivityProbe = {
  label: string
  host: string
  url: string
  category: 'managed' | 'egress'
  viaProxy: boolean
  reachable: boolean
  httpStatus: number | null
  latencyMs: number | null
  note: string
}

type ConnectivityPayload = {
  generatedAt: string
  probes: ConnectivityProbe[]
}

type ChatResponsePayload = {
  message?: {
    role: Role
    content: string
    reasoning?: string | null
  }
  error?: string
  model?: string
  requestedModel?: string
  warning?: string | null
}

type ArchitectPipelinePayload = {
  success: boolean
  architect: ArchitectProfile
  render: {
    diagram_name: string
    paths: Record<string, string | null | undefined>
    compiled_source: string
    run_id?: string
    validation: {
      svg_valid: boolean
      png_valid: boolean
    }
  }
  tla: {
    success: boolean
    paths?: Record<string, string | null>
    sany?: {
      valid?: boolean
    }
  } | null
  ts: {
    success: boolean
    paths?: Record<string, string | null>
  } | null
  quality: {
    passes: boolean
    score: number
    stage: 'mmd' | 'tla' | 'ts'
    issues: string[]
  }
  scaffold: {
    repoRoot: string
    repoName: string
    files: string[]
    skillPath: string
    mcpPath: string
    launcherPath: string
    desktopCommandPath: string
    appEntryPath: string
    desktopPort: number
  } | null
}

const bootstrapMessage: ChatMessage = {
  id: crypto.randomUUID(),
  role: 'assistant',
  content:
    'This wrapper is the builder shell now. It can compare managed-route versus local-model chat, inherit Mermate’s architect profile, run the design pipeline, and scaffold a clean repo from the resulting spec bundle.',
}

function App() {
  const isMermateEmbed = useMemo(() => {
    return new URLSearchParams(window.location.search).get('embed') === 'mermate'
  }, [])
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [connectivity, setConnectivity] = useState<ConnectivityPayload | null>(null)
  const [connectivityError, setConnectivityError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([bootstrapMessage])
  const [draft, setDraft] = useState('')
  const [probeHost, setProbeHost] = useState('inference.local')
  const [manualProbe, setManualProbe] = useState<ConnectivityProbe | null>(null)
  const [manualProbeError, setManualProbeError] = useState<string | null>(null)
  const [selectedTransport, setSelectedTransport] = useState<ChatTransport>('openshell')
  const [selectedModel, setSelectedModel] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isLoadingConnectivity, setIsLoadingConnectivity] = useState(false)
  const [isProbingHost, setIsProbingHost] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)

  const [builderIdea, setBuilderIdea] = useState('')
  const [builderDiagramName, setBuilderDiagramName] = useState('')
  const [builderRepoName, setBuilderRepoName] = useState('')
  const [builderInputMode, setBuilderInputMode] = useState<ArchitectInputMode>('idea')
  const [builderIncludeTla, setBuilderIncludeTla] = useState(true)
  const [builderIncludeTs, setBuilderIncludeTs] = useState(true)
  const [builderScaffold, setBuilderScaffold] = useState(true)
  const [pipelineResult, setPipelineResult] = useState<ArchitectPipelinePayload | null>(null)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [isRunningPipeline, setIsRunningPipeline] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(!isMermateEmbed)

  const probeOptions = useMemo(() => {
    return Array.from(new Set(['inference.local', ...(status?.allowedHosts ?? [])]))
  }, [status?.allowedHosts])

  const modelOptions = useMemo(() => {
    if (!status) {
      return []
    }

    if (selectedTransport === 'ollama') {
      return status.ollama.models.map((model) => model.name)
    }

    return Array.from(new Set([status.inference.modelId, ...status.route.models].filter(Boolean)))
  }, [selectedTransport, status])

  useEffect(() => {
    void loadStatus()
    void loadConnectivity()

    const interval = window.setInterval(() => {
      void loadStatus()
    }, 15000)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!probeOptions.length) {
      return
    }

    if (!probeOptions.includes(probeHost)) {
      setProbeHost(probeOptions[0])
    }
  }, [probeHost, probeOptions])

  useEffect(() => {
    if (!modelOptions.length) {
      setSelectedModel('')
      return
    }

    if (selectedTransport === 'ollama') {
      const preferred = status?.ollama.defaultModel
      if (!selectedModel || !modelOptions.includes(selectedModel)) {
        setSelectedModel(preferred && modelOptions.includes(preferred) ? preferred : modelOptions[0])
      }
      return
    }

    const preferred = status?.inference.modelId
    if (!selectedModel || !modelOptions.includes(selectedModel)) {
      setSelectedModel(preferred && modelOptions.includes(preferred) ? preferred : modelOptions[0])
    }
  }, [modelOptions, selectedModel, selectedTransport, status?.inference.modelId, status?.ollama.defaultModel])

  async function loadStatus() {
    try {
      const response = await fetch('/api/status')
      if (!response.ok) {
        throw new Error(`Status request failed with ${response.status}`)
      }

      const payload = (await response.json()) as StatusPayload
      setStatus(payload)
      setStatusError(null)
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadConnectivity() {
    setIsLoadingConnectivity(true)

    try {
      const response = await fetch('/api/connectivity')
      if (!response.ok) {
        throw new Error(`Connectivity request failed with ${response.status}`)
      }

      const payload = (await response.json()) as ConnectivityPayload
      setConnectivity(payload)
      setConnectivityError(null)
    } catch (error) {
      setConnectivityError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingConnectivity(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = draft.trim()

    if (!input || isSending) {
      return
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      transport: selectedTransport,
      model: selectedModel || null,
    }

    const nextMessages = [...messages, userMessage]

    setMessages(nextMessages)
    setDraft('')
    setIsSending(true)
    setComposerError(null)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          transport: selectedTransport,
          model: selectedModel || undefined,
        }),
      })

      const payload = (await response.json()) as ChatResponsePayload | undefined

      if (!response.ok || !payload?.message) {
        throw new Error(payload?.error ?? `Chat request failed with ${response.status}`)
      }

      const responseMessage = payload.message

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: responseMessage.role,
          content: responseMessage.content,
          reasoning: responseMessage.reasoning,
          transport: selectedTransport,
          model: payload.model ?? payload.requestedModel ?? null,
          warning: payload.warning ?? null,
        },
      ])
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSending(false)
    }
  }

  async function handleProbeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!probeHost || isProbingHost) {
      return
    }

    setIsProbingHost(true)
    setManualProbe(null)
    setManualProbeError(null)

    try {
      const response = await fetch('/api/connectivity/probe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          host: probeHost,
        }),
      })

      const payload = (await response.json()) as
        | {
            probe?: ConnectivityProbe
            error?: string
          }
        | undefined

      if (!response.ok || !payload?.probe) {
        throw new Error(payload?.error ?? `Probe request failed with ${response.status}`)
      }

      setManualProbe(payload.probe)
    } catch (error) {
      setManualProbeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsProbingHost(false)
    }
  }

  async function handlePipelineSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const source = builderIdea.trim()

    if (!source || isRunningPipeline) {
      return
    }

    setIsRunningPipeline(true)
    setPipelineError(null)

    try {
      const response = await fetch('/api/architect/pipeline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source,
          diagramName: builderDiagramName.trim() || undefined,
          inputMode: builderInputMode,
          maxMode: true,
          includeTla: builderIncludeTla || builderIncludeTs,
          includeTs: builderIncludeTs,
          scaffold: builderScaffold,
          repoName: builderScaffold ? builderRepoName.trim() || undefined : undefined,
        }),
      })

      const payload = (await response.json()) as ArchitectPipelinePayload | { error?: string }
      if (!response.ok || !('render' in payload)) {
        throw new Error(('error' in payload && payload.error) || `Architect pipeline failed with ${response.status}`)
      }

      setPipelineResult(payload)
      void loadStatus()
    } catch (error) {
      setPipelineError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsRunningPipeline(false)
    }
  }

  function openWorkspacePopout() {
    const url = status?.mermate.baseUrl
    if (!url) {
      return
    }

    window.open(url, 'mermate-workspace', 'popup,width=1500,height=920')
  }

  const activeTransportLabel = selectedTransport === 'openshell' ? 'Managed Route' : 'Local Ollama'
  const advertisedRouteModels = status?.route.models.length ?? 0
  const workspaceUrl = status?.mermate.baseUrl ?? 'http://127.0.0.1:3333'
  const mermateModeCount = status?.mermate.agentModes.length ?? 0

  return (
    <main className="page-shell">
      <section className="masthead panel">
        <div className="masthead-copy">
          <p className="eyebrow">OrbStack / OpenShell / NemoClaw / Mermate</p>
          <h1>OpenClaw Application Builder</h1>
          <p className="lead">
            A merged builder shell that uses Mermate as the architecture agent, keeps NemoClaw in
            control of the live sandbox and model routes, and can turn a simple idea into a clean
            spec bundle and scaffolded project under `~/Desktop/developer`.
          </p>
        </div>

        <div className="signal-stack">
          <div className={`signal-card ${status?.route.healthy ? 'live' : 'warning'}`}>
            <span className="signal-label">Managed Route</span>
            <strong>{status?.route.healthy ? 'Hot' : 'Needs attention'}</strong>
            <span className="signal-detail">
              {status?.route.healthy
                ? `${advertisedRouteModels} advertised models inside the sandbox`
                : status?.route.error ?? statusError ?? 'Connecting to gateway'}
            </span>
          </div>

          <div className={`signal-card ${status?.mermate.running ? 'live' : 'warning'}`}>
            <span className="signal-label">Architect Agent</span>
            <strong>{status?.mermate.running ? 'Mermate online' : 'Mermate offline'}</strong>
            <span className="signal-detail">
              {status?.architect.orchestratorModel
                ? `${status.architect.orchestratorModel} orchestrator · ${status.architect.workerModel ?? 'worker unknown'}`
                : status?.mermate.repoPath ?? 'Architect profile loading'}
            </span>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="rail">
          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Live Wiring</h2>
              <span className="chip">{status?.sandbox.phase ?? 'Unknown'}</span>
            </div>
            <dl className="spec-list">
              <div>
                <dt>Gateway</dt>
                <dd>{status?.gateway.name ?? 'nemoclaw'}</dd>
              </div>
              <div>
                <dt>Sandbox</dt>
                <dd>{status?.sandbox.name ?? 'aoc-local'}</dd>
              </div>
              <div>
                <dt>Architect Env</dt>
                <dd>{status?.architect.envPath ?? 'Loading…'}</dd>
              </div>
              <div>
                <dt>Desktop Launcher</dt>
                <dd>{status?.launchers.desktopCommandPath ?? 'Preparing…'}</dd>
              </div>
              <div>
                <dt>MCP</dt>
                <dd>{status?.launchers.projectMcpPath ?? 'Loading…'}</dd>
              </div>
            </dl>
          </div>

          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Architect Profile</h2>
              <span className="chip ghost">{status?.architect.envPresent ? 'Inherited' : 'Missing'}</span>
            </div>
            <dl className="spec-list">
              <div>
                <dt>Orchestrator</dt>
                <dd>{status?.architect.orchestratorModel ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Worker</dt>
                <dd>{status?.architect.workerModel ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Structured</dt>
                <dd>{status?.architect.structuredModel ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Fallback</dt>
                <dd>{status?.architect.localFallbackModel ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>GoT</dt>
                <dd>
                  {status?.architect.got.enabled
                    ? `${status.architect.got.maxDepth ?? '?'} depth × ${status.architect.got.maxBranch ?? '?'} branch`
                    : 'Disabled'}
                </dd>
              </div>
              <div>
                <dt>Architects</dt>
                <dd>
                  {status?.architect.architectAgents.enabled
                    ? `${status.architect.architectAgents.total ?? '?'} agents`
                    : 'Disabled'}
                </dd>
              </div>
            </dl>
          </div>

          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Attached Systems</h2>
              <span className="chip ghost">Verified</span>
            </div>
            <div className="system-grid">
              <article className={`system-card ${status?.route.healthy ? 'online' : 'offline'}`}>
                <strong>Managed NemoClaw</strong>
                <p>
                  {status?.route.healthy
                    ? `${advertisedRouteModels} advertised route models`
                    : status?.route.error ?? 'Route health unknown'}
                </p>
              </article>

              <article className={`system-card ${status?.ollama.available ? 'online' : 'offline'}`}>
                <strong>Local Ollama</strong>
                <p>
                  {status?.ollama.available
                    ? `${status.ollama.localModels.length} local / ${status.ollama.cloudModels.length} cloud`
                    : 'Ollama is not answering'}
                </p>
              </article>

              <article className={`system-card ${status?.mermate.running ? 'online' : 'offline'}`}>
                <strong>Mermate</strong>
                <p>
                  {status?.mermate.running
                    ? `${status.mermate.copilotAvailable ? 'copilot' : 'compiler'} · ${mermateModeCount} modes · ${status.mermate.agentsLoaded} specialists`
                    : `Check ${status?.mermate.repoPath ?? 'repo'} and logs/mermate.log`}
                </p>
              </article>

              <article
                className={`system-card ${
                  status?.claude.projectMcpConfigured || status?.claude.cursorMcpDetected
                    ? 'online'
                    : 'offline'
                }`}
              >
                <strong>Claude Code</strong>
                <p>
                  {status?.claude.projectMcpConfigured
                    ? 'Project MCP is configured'
                    : status?.claude.cursorMcpDetected
                      ? 'Cursor MCP file detected'
                      : 'Waiting for project MCP config'}
                </p>
              </article>
            </div>
          </div>

          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Mermate Modes</h2>
              <span className="chip ghost">
                {mermateModeCount} modes · {status?.mermate.agentsLoaded ?? 0} agents
              </span>
            </div>
            <div className="tag-grid">
              {(status?.mermate.agentModes ?? []).length ? (
                status?.mermate.agentModes.map((mode) => (
                  <span className="tag" key={mode.id}>
                    {mode.label} · {mode.stage}
                  </span>
                ))
              ) : (
                <span className="empty-copy">Mermate mode inventory is still loading.</span>
              )}
            </div>
            <ul className="note-list compact">
              {(status?.mermate.agentDomains ?? []).slice(0, 6).map((domain) => (
                <li key={domain}>{domain.replaceAll('_', ' ')}</li>
              ))}
            </ul>
          </div>

          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Available Models</h2>
              <span className="chip muted">{activeTransportLabel}</span>
            </div>
            <div className="tag-grid">
              {modelOptions.length ? (
                modelOptions.map((model) => (
                  <span className={`tag ${model === selectedModel ? 'selected-tag' : ''}`} key={model}>
                    {model}
                  </span>
                ))
              ) : (
                <span className="empty-copy">No models detected for the selected transport.</span>
              )}
            </div>
          </div>

          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Allowlisted Egress</h2>
              <span className="chip ghost">{status?.allowedHosts.length ?? 0} hosts</span>
            </div>
            <div className="tag-grid">
              {(status?.allowedHosts ?? []).length ? (
                status?.allowedHosts.map((host) => <span className="tag" key={host}>{host}</span>)
              ) : (
                <span className="empty-copy">Host allowlist is still loading.</span>
              )}
            </div>
          </div>

          <div className="panel rail-panel">
            <div className="panel-heading">
              <h2>Current Caveats</h2>
            </div>
            <ul className="note-list">
              {(status?.caveats ?? ['Status feed still resolving.']).map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="chat-column">
          <div className="panel architect-panel">
            <div className="panel-heading">
              <div>
                <h2>Architect Workspace</h2>
                <p className="support-copy">
                  This builder uses the Mermate `.env` profile as the architecture brain, then lets
                  NemoClaw carry the resulting specs into a new clean repo under `~/Desktop/developer`.
                </p>
              </div>
              {!isMermateEmbed ? (
                <div className="workspace-actions">
                  <button className="secondary-button" onClick={() => setShowWorkspace((value) => !value)} type="button">
                    {showWorkspace ? 'Hide workspace' : 'Show workspace'}
                  </button>
                  <button className="secondary-button" onClick={openWorkspacePopout} type="button">
                    Pop out Mermate
                  </button>
                </div>
              ) : null}
            </div>

            <div className="architect-layout">
              <form className="builder-form" onSubmit={handlePipelineSubmit}>
                <span className="composer-label">Simple Idea</span>
                <textarea
                  onChange={(event) => setBuilderIdea(event.target.value)}
                  placeholder="Describe the application you want to design, formalize, and scaffold."
                  value={builderIdea}
                />

                <div className="builder-grid">
                  <label className="control-field">
                    <span className="composer-label">Input mode</span>
                    <select
                      onChange={(event) => setBuilderInputMode(event.target.value as ArchitectInputMode)}
                      value={builderInputMode}
                    >
                      <option value="idea">Idea</option>
                      <option value="markdown">Markdown</option>
                      <option value="mmd">Mermaid</option>
                    </select>
                  </label>

                  <label className="control-field">
                    <span className="composer-label">Diagram name</span>
                    <input
                      onChange={(event) => setBuilderDiagramName(event.target.value)}
                      placeholder="payment-orchestrator"
                      type="text"
                      value={builderDiagramName}
                    />
                  </label>

                  <label className="control-field">
                    <span className="composer-label">Repo name</span>
                    <input
                      onChange={(event) => setBuilderRepoName(event.target.value)}
                      placeholder="payment-orchestrator-app"
                      type="text"
                      value={builderRepoName}
                    />
                  </label>
                </div>

                <div className="toggle-row">
                  <label className="toggle-chip">
                    <input
                      checked={builderIncludeTla}
                      onChange={(event) => setBuilderIncludeTla(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Generate TLA+</span>
                  </label>
                  <label className="toggle-chip">
                    <input
                      checked={builderIncludeTs}
                      onChange={(event) => {
                        setBuilderIncludeTs(event.target.checked)
                        if (event.target.checked) {
                          setBuilderIncludeTla(true)
                        }
                      }}
                      type="checkbox"
                    />
                    <span>Generate TypeScript</span>
                  </label>
                  <label className="toggle-chip">
                    <input
                      checked={builderScaffold}
                      onChange={(event) => setBuilderScaffold(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Scaffold clean repo</span>
                  </label>
                </div>

                <div className="builder-actions">
                  <div className="composer-meta">
                    {pipelineError ? <p className="error-copy">{pipelineError}</p> : null}
                  </div>
                  <button
                    disabled={
                      isRunningPipeline ||
                      !builderIdea.trim() ||
                      (builderScaffold && !builderRepoName.trim())
                    }
                    type="submit"
                  >
                    {isRunningPipeline ? 'Building…' : 'Run architect pipeline'}
                  </button>
                </div>
              </form>

              {!isMermateEmbed && showWorkspace ? (
                <div className="workspace-frame-shell">
                  <iframe className="workspace-frame" src={workspaceUrl} title="Mermate Workspace" />
                </div>
              ) : null}
            </div>

            {pipelineResult ? (
              <div className="result-grid">
                <article className={`result-card ${pipelineResult.quality.passes ? 'online' : 'offline'}`}>
                  <strong>Quality gate</strong>
                  <p>
                    {pipelineResult.quality.stage.toUpperCase()} · score {pipelineResult.quality.score} ·{' '}
                    {pipelineResult.quality.passes ? 'pass' : 'blocked'}
                  </p>
                  {pipelineResult.quality.issues.length ? (
                    <p className="result-copy">{pipelineResult.quality.issues.join(' ')}</p>
                  ) : (
                    <p className="result-copy">The current artifact bundle cleared the clean-output gate.</p>
                  )}
                </article>

                <article className="result-card">
                  <strong>Spec bundle</strong>
                  <p>{pipelineResult.render.diagram_name}</p>
                  <p className="result-copy">
                    Run ID: {pipelineResult.render.run_id ?? 'n/a'} · SVG{' '}
                    {pipelineResult.render.validation.svg_valid ? 'valid' : 'invalid'} · PNG{' '}
                    {pipelineResult.render.validation.png_valid ? 'valid' : 'invalid'}
                  </p>
                </article>

                <article className="result-card">
                  <strong>Formal stages</strong>
                  <p>
                    TLA {pipelineResult.tla?.sany?.valid ? 'verified' : pipelineResult.tla ? 'failed' : 'skipped'} · TS{' '}
                    {pipelineResult.ts?.success ? 'validated' : pipelineResult.ts ? 'failed' : 'skipped'}
                  </p>
                  <p className="result-copy">
                    Orchestrator {pipelineResult.architect.orchestratorModel ?? 'unknown'} · Worker{' '}
                    {pipelineResult.architect.workerModel ?? 'unknown'}
                  </p>
                </article>

                {pipelineResult.scaffold ? (
                  <article className="result-card online">
                    <strong>Scaffolded repo</strong>
                    <p>{pipelineResult.scaffold.repoRoot}</p>
                    <p className="result-copy">
                      {pipelineResult.scaffold.files.length} curated files · desktop port{' '}
                      {pipelineResult.scaffold.desktopPort}
                    </p>
                    <p className="result-copy">Launcher: {pipelineResult.scaffold.launcherPath}</p>
                    <p className="result-copy">Desktop command: {pipelineResult.scaffold.desktopCommandPath}</p>
                    <p className="result-copy">Starter app: {pipelineResult.scaffold.appEntryPath}</p>
                  </article>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="panel diagnostics-panel">
            <div className="panel-heading">
              <div>
                <h2>Connectivity Surface</h2>
                <p className="support-copy">
                  These probes run from inside `aoc-local`, not from the host shell. That keeps the
                  attachment map honest when you decide what to hand to the builder or the agent layer next.
                </p>
              </div>
              <button className="secondary-button" onClick={() => void loadConnectivity()} type="button">
                {isLoadingConnectivity ? 'Refreshing…' : 'Refresh probes'}
              </button>
            </div>

            {connectivityError ? <p className="error-copy">{connectivityError}</p> : null}

            <div className="probe-grid">
              {(connectivity?.probes ?? []).map((probe) => (
                <article
                  className={`probe-card ${
                    probe.host === 'inference.local'
                      ? 'featured'
                      : probe.reachable
                        ? 'reachable'
                        : 'unreachable'
                  }`}
                  key={probe.host}
                >
                  <div className="probe-card-header">
                    <div>
                      <strong>{probe.label}</strong>
                      <p className="probe-url">{probe.url}</p>
                    </div>
                    <span className="chip">{probe.reachable ? 'Reachable' : 'Blocked'}</span>
                  </div>
                  <div className="probe-stats">
                    <span>{probe.httpStatus ? `HTTP ${probe.httpStatus}` : 'No response code'}</span>
                    <span>{probe.latencyMs ? `${probe.latencyMs} ms` : 'Latency unavailable'}</span>
                    <span>{probe.viaProxy ? 'proxy' : 'direct'}</span>
                  </div>
                  <p className="probe-note">{probe.note}</p>
                </article>
              ))}
            </div>

            <form className="probe-form" onSubmit={handleProbeSubmit}>
              <span className="composer-label">Manual Host Probe</span>
              <div className="probe-form-row">
                <select onChange={(event) => setProbeHost(event.target.value)} value={probeHost}>
                  {probeOptions.map((host) => (
                    <option key={host} value={host}>
                      {host}
                    </option>
                  ))}
                </select>
                <button className="secondary-button" disabled={isProbingHost} type="submit">
                  {isProbingHost ? 'Running…' : 'Probe host'}
                </button>
              </div>

              {manualProbe ? (
                <div className="probe-footer">
                  <span className="chip">{manualProbe.reachable ? 'Reachable' : 'Blocked'}</span>
                  <span className="probe-note">
                    {manualProbe.host} · {manualProbe.httpStatus ? `HTTP ${manualProbe.httpStatus}` : 'No status'} ·{' '}
                    {manualProbe.latencyMs ? `${manualProbe.latencyMs} ms` : 'No timing'}
                  </span>
                </div>
              ) : null}

              {manualProbeError ? <p className="error-copy">{manualProbeError}</p> : null}
            </form>
          </div>

          <div className="panel chat-panel">
            <div className="panel-heading">
              <div>
                <h2>Operator Console</h2>
                <p className="support-copy">
                  Compare managed-route and local-model behavior directly. The assistant card shows the
                  actual answering model so route overrides stay visible.
                </p>
              </div>

              <div className="model-cloud">
                <span className="chip">{activeTransportLabel}</span>
                {selectedModel ? <span className="chip ghost">{selectedModel}</span> : null}
              </div>
            </div>

            <div className="control-grid">
              <label className="control-field">
                <span className="composer-label">Transport</span>
                <select
                  onChange={(event) => setSelectedTransport(event.target.value as ChatTransport)}
                  value={selectedTransport}
                >
                  <option value="openshell">Managed NemoClaw route</option>
                  <option value="ollama">Local Ollama</option>
                </select>
              </label>

              <label className="control-field">
                <span className="composer-label">Model</span>
                <select onChange={(event) => setSelectedModel(event.target.value)} value={selectedModel}>
                  {modelOptions.length ? (
                    modelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  ) : (
                    <option value="">No models available</option>
                  )}
                </select>
              </label>
            </div>

            <div className="message-log">
              {messages.map((message) => (
                <article className={`message-card ${message.role}`} key={message.id}>
                  <header>
                    <span>{message.role === 'assistant' ? 'Assistant' : 'Operator'}</span>
                    {message.transport ? <span className="message-meta">{transportLabel(message.transport)}</span> : null}
                    {message.model ? <span className="message-meta">{message.model}</span> : null}
                  </header>
                  <p>{message.content}</p>
                  {message.warning ? <p className="message-warning">{message.warning}</p> : null}
                  {message.reasoning ? (
                    <details>
                      <summary>Model reasoning</summary>
                      <pre>{message.reasoning}</pre>
                    </details>
                  ) : null}
                </article>
              ))}

              {isSending ? (
                <article className="message-card assistant loading">
                  <header>
                    <span>Assistant</span>
                    <span className="message-meta">{activeTransportLabel}</span>
                    {selectedModel ? <span className="message-meta">{selectedModel}</span> : null}
                  </header>
                  <p>Waiting for the selected runtime to answer.</p>
                </article>
              ) : null}
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <span className="composer-label">Prompt</span>
              <textarea
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask the builder shell to inspect, compare, or reason before you commit to a pipeline run."
                value={draft}
              />

              <div className="composer-actions">
                <div className="composer-meta">
                  {composerError ? <p className="error-copy">{composerError}</p> : null}
                </div>

                <button disabled={isSending || !draft.trim() || !selectedModel} type="submit">
                  {isSending ? 'Routing…' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        </section>
      </section>
    </main>
  )
}

function transportLabel(transport: ChatTransport): string {
  return transport === 'openshell' ? 'Managed route' : 'Local Ollama'
}

export default App
