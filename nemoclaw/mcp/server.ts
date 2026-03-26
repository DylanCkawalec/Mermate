import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const consoleBaseUrl = process.env.OPENCLAW_CONSOLE_URL ?? 'http://127.0.0.1:8787'
const mermateBaseUrl = process.env.MERMATE_URL ?? 'http://127.0.0.1:3333'
const desktopLauncherPath = '/Users/dylanckawalec/Desktop/OpenClaw Desktop.command'

const server = new McpServer({
  name: 'openclaw-desktop-wrapper',
  version: '0.2.0',
})

server.registerTool(
  'openclaw_status',
  {
    description:
      'Inspect the local OpenClaw desktop wrapper, including managed NemoClaw, Ollama, Mermate, and Claude Code attachment state.',
    inputSchema: {},
  },
  async () => {
    try {
      const status = await requestJson<Record<string, unknown>>(`${consoleBaseUrl}/api/status`)
      return jsonResult(status)
    } catch (error) {
      return errorResult(
        `OpenClaw console is unavailable at ${consoleBaseUrl}. Start it with ${desktopLauncherPath}.`,
        error,
      )
    }
  },
)

server.registerTool(
  'openclaw_chat',
  {
    description:
      'Send a prompt through the local desktop wrapper using either the managed NemoClaw route or local Ollama.',
    inputSchema: {
      prompt: z.string().min(1).describe('User prompt to send'),
      transport: z
        .enum(['openshell', 'ollama'])
        .optional()
        .describe('openshell uses the managed NemoClaw route, ollama uses the local Ollama API'),
      model: z.string().min(1).optional().describe('Optional model override'),
      systemPrompt: z.string().min(1).optional().describe('Optional system prompt'),
    },
  },
  async ({ prompt, transport, model, systemPrompt }) => {
    try {
      const messages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ]
      const payload = await requestJson<Record<string, unknown>>(`${consoleBaseUrl}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          messages,
          transport,
          model,
        }),
      })

      return jsonResult(payload)
    } catch (error) {
      return errorResult('Chat request failed against the local desktop wrapper.', error)
    }
  },
)

server.registerTool(
  'openclaw_connectivity_probe',
  {
    description: 'Probe a currently allowlisted host from inside the aoc-local sandbox.',
    inputSchema: {
      host: z.string().min(1).describe('Bare hostname to probe, for example github.com'),
    },
  },
  async ({ host }) => {
    try {
      const payload = await requestJson<Record<string, unknown>>(
        `${consoleBaseUrl}/api/connectivity/probe`,
        {
          method: 'POST',
          body: JSON.stringify({ host }),
        },
      )

      return jsonResult(payload)
    } catch (error) {
      return errorResult(`Connectivity probe failed for ${host}.`, error)
    }
  },
)

server.registerTool(
  'architect_status',
  {
    description:
      'Inspect the architect-agent profile inherited from /Users/dylanckawalec/Desktop/developer/mermaid/.env and the live Mermate sidecar state.',
    inputSchema: {},
  },
  async () => {
    try {
      const payload = await requestJson<Record<string, unknown>>(`${consoleBaseUrl}/api/architect/status`)
      return jsonResult(payload)
    } catch (error) {
      return errorResult('Architect status request failed.', error)
    }
  },
)

server.registerTool(
  'architect_pipeline_build',
  {
    description:
      'Run the Mermate architect pipeline end to end: idea to Mermaid, optional TLA+, optional TypeScript, and optional clean repo scaffold.',
    inputSchema: {
      source: z.string().min(1).describe('Simple idea or markdown to turn into a production design bundle'),
      diagramName: z.string().min(1).optional().describe('Optional diagram name'),
      inputMode: z.enum(['idea', 'markdown', 'mmd']).optional(),
      maxMode: z.boolean().optional(),
      includeTla: z.boolean().optional(),
      includeTs: z.boolean().optional(),
      scaffold: z.boolean().optional(),
      repoName: z.string().min(1).optional().describe('Required when scaffold is true'),
    },
  },
  async (input) => {
    try {
      const payload = await requestJson<Record<string, unknown>>(
        `${consoleBaseUrl}/api/architect/pipeline`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )

      return jsonResult(payload)
    } catch (error) {
      return errorResult('Architect pipeline build failed.', error)
    }
  },
)

server.registerTool(
  'builder_scaffold_repo',
  {
    description:
      'Create a clean builder-ready repository under /Users/dylanckawalec/Desktop/developer from an existing Mermate run bundle.',
    inputSchema: {
      runId: z.string().min(1).describe('Existing Mermate run id'),
      repoName: z.string().min(1).describe('Target repository name'),
      sourceIdea: z.string().min(1).describe('Original product idea for the generated repo'),
    },
  },
  async (input) => {
    try {
      const payload = await requestJson<Record<string, unknown>>(
        `${consoleBaseUrl}/api/builder/scaffold`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )

      return jsonResult(payload)
    } catch (error) {
      return errorResult('Builder scaffold failed.', error)
    }
  },
)

server.registerTool(
  'mermate_agent_modes',
  {
    description:
      'List Mermate agent modes and the currently loaded architecture specialists in the sidecar.',
    inputSchema: {},
  },
  async () => {
    try {
      const [modes, agents] = await Promise.all([
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/agent/modes`),
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/agents`),
      ])

      return jsonResult({
        baseUrl: mermateBaseUrl,
        modes,
        agents,
      })
    } catch (error) {
      return errorResult('Mermate agent mode request failed.', error)
    }
  },
)

server.registerTool(
  'mermate_generate_tla',
  {
    description: 'Generate and validate a TLA+ specification for an existing Mermate run.',
    inputSchema: {
      runId: z.string().min(1).describe('Existing Mermate run id'),
      diagramName: z.string().min(1).optional().describe('Optional diagram name override'),
    },
  },
  async ({ runId, diagramName }) => {
    try {
      const payload = await requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/render/tla`, {
        method: 'POST',
        body: JSON.stringify({
          run_id: runId,
          diagram_name: diagramName,
        }),
      })

      return jsonResult(payload)
    } catch (error) {
      return errorResult('Mermate TLA+ generation failed.', error)
    }
  },
)

server.registerTool(
  'mermate_generate_ts',
  {
    description: 'Generate the TypeScript runtime artifact for an existing Mermate run with TLA+ outputs.',
    inputSchema: {
      runId: z.string().min(1).describe('Existing Mermate run id'),
      diagramName: z.string().min(1).optional().describe('Optional diagram name override'),
    },
  },
  async ({ runId, diagramName }) => {
    try {
      const payload = await requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/render/ts`, {
        method: 'POST',
        body: JSON.stringify({
          run_id: runId,
          diagram_name: diagramName,
        }),
      })

      return jsonResult(payload)
    } catch (error) {
      return errorResult('Mermate TypeScript generation failed.', error)
    }
  },
)

server.registerTool(
  'mermate_status',
  {
    description:
      'Inspect the Mermate runtime surfaces that can feed the desktop wrapper: copilot health, TLA status, TS status, and agent modes.',
    inputSchema: {},
  },
  async () => {
    try {
      const [copilot, tla, ts, modes, agents] = await Promise.all([
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/copilot/health`).catch((error) => ({
          error: formatError(error),
        })),
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/render/tla/status`).catch((error) => ({
          error: formatError(error),
        })),
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/render/ts/status`).catch((error) => ({
          error: formatError(error),
        })),
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/agent/modes`).catch((error) => ({
          error: formatError(error),
        })),
        requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/agents`).catch((error) => ({
          error: formatError(error),
        })),
      ])

      return jsonResult({
        baseUrl: mermateBaseUrl,
        copilot,
        tla,
        ts,
        modes,
        agents,
      })
    } catch (error) {
      return errorResult(`Mermate is unavailable at ${mermateBaseUrl}.`, error)
    }
  },
)

server.registerTool(
  'mermate_render',
  {
    description:
      'Send text, markdown, or Mermaid source to Mermate so it can compile or enhance the architecture flow.',
    inputSchema: {
      source: z.string().min(1).describe('Idea text, markdown, or Mermaid source'),
      diagramName: z.string().min(1).optional().describe('Optional output name'),
      inputMode: z
        .enum(['idea', 'markdown', 'mmd'])
        .optional()
        .describe('Optional input mode hint for Mermate'),
      maxMode: z.boolean().optional().describe('Enable Mermate max mode'),
    },
  },
  async ({ source, diagramName, inputMode, maxMode }) => {
    try {
      const payload = await requestJson<Record<string, unknown>>(`${mermateBaseUrl}/api/render`, {
        method: 'POST',
        body: JSON.stringify({
          mermaid_source: source,
          diagram_name: diagramName,
          input_mode: inputMode,
          max_mode: maxMode,
        }),
      })

      return jsonResult(payload)
    } catch (error) {
      return errorResult('Mermate render request failed.', error)
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('openclaw-desktop-wrapper failed to start:', error)
  process.exit(1)
})

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)

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
      throw new Error(
        payload && typeof payload === 'object' && payload !== null && 'error' in payload
          ? String(payload.error)
          : `${url} returned ${response.status}`,
      )
    }

    if (payload == null) {
      throw new Error(`${url} returned an empty JSON payload`)
    }

    return payload
  } finally {
    clearTimeout(timer)
  }
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function errorResult(message: string, error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${message}\n\n${formatError(error)}`,
      },
    ],
    isError: true,
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
