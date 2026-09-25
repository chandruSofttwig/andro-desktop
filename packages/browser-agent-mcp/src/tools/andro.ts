import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../config.js'
import { trackToolCall } from '../activity-bus.js'

/**
 * Andromedia context tools, served from the *local* agent.
 *
 * The code tools in this server see files but know nothing about why they
 * changed. Andromedia indexes the surrounding context — Slack threads, Jira and
 * Linear tickets, Notion docs, git history, CRM records — and this module lets
 * one MCP client reach both.
 *
 * Why here rather than merging the two servers: the hosted Andromedia MCP runs
 * in a container with no filesystem access, deliberately. Running these as
 * plain HTTP calls from the local agent keeps the read-only remote surface
 * read-only, and gives the model file access and context access side by side.
 *
 * These are all read-only calls to the user's own core API, so they never
 * touch the workspace.
 */

const SOURCE_ENUM = [
  'CODE',
  'GIT',
  'SLACK',
  'NOTION',
  'JIRA',
  'LINEAR',
  'GOOGLE_CHAT',
  'ZOHO',
] as const

interface AndroResponse {
  summary?: string
  details?: string
  hits?: Array<Record<string, unknown>>
  sourceTypes?: string[]
  totalChunks?: number
  sourcesConnected?: number
  lastSyncAt?: string
  [key: string]: unknown
}

/** Minimal client for the user's local Andromedia core API. */
export class AndroClient {
  constructor(
    private readonly baseUrl: string = config.androBaseUrl,
    private readonly service: string = config.androService,
    private readonly timeoutMs = 60_000,
  ) {}

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<AndroResponse> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `Andromedia API ${response.status} for ${path}: ${text.slice(0, 300) || '(no body)'}`,
      )
    }
    try {
      return text ? (JSON.parse(text) as AndroResponse) : {}
    } catch {
      throw new Error(`Andromedia API returned non-JSON for ${path}`)
    }
  }
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

function hitLabel(hit: Record<string, unknown>): string {
  return String(hit.filePath || hit.path || hit.fileName || hit.title || '(untitled)')
}

export function registerAndroTools(server: McpServer, client = new AndroClient()): void {
  server.registerTool(
    'andro_investigate',
    {
      description:
        'Ask Andromedia a grounded question over indexed team context (Slack, Notion, ' +
        'Jira, Linear, git history, CRM). Use this to learn WHY code or a decision ' +
        'changed; pair it with Grep/Read for the code itself.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('Question in plain English'),
        service: z.string().optional().describe('Andromedia service/workspace'),
        source_types: z.array(z.enum(SOURCE_ENUM)).optional().describe('Optional source filter'),
      },
    },
    async ({ query, service, source_types }) =>
      trackToolCall(
        'andro_investigate',
        { argsSummary: query, args: { query, service, source_types } },
        async () => {
          try {
            const data = await client.request('POST', '/api/v1/investigate', {
              service: service || client['service'],
              query,
              ...(source_types?.length ? { sourceTypes: source_types } : {}),
            })
            return text(
              [
                `## Andromedia — ${query}`,
                '',
                data.summary || '(no summary)',
                '',
                ...(data.details ? ['---', '**Sources:**', data.details] : []),
              ].join('\n'),
            )
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Andromedia context unavailable: ${error instanceof Error ? error.message : String(error)}\n` +
                    'Is the core API running on ' +
                    client['baseUrl'] +
                    '?',
                },
              ],
            }
          }
        },
      ),
  )

  server.registerTool(
    'andro_search',
    {
      description:
        'Hybrid keyword + semantic search across indexed team context. Returns ' +
        'evidence snippets with source paths. Complements Grep: Grep reads the ' +
        'working tree, this searches what has been indexed (including history).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe('Search query'),
        service: z.string().optional(),
        source_types: z.array(z.enum(SOURCE_ENUM)).optional(),
        top_k: z.number().optional().describe('Number of results (default 10)'),
      },
    },
    async ({ query, service, source_types, top_k }) =>
      trackToolCall(
        'andro_search',
        { argsSummary: query, args: { query, service, source_types, top_k } },
        async () => {
          try {
            const data = await client.request('POST', '/api/v1/search', {
              service: service || client['service'],
              query,
              topK: top_k || 10,
              hybrid: true,
              ...(source_types?.length ? { sourceTypes: source_types } : {}),
            })
            const hits = Array.isArray(data.hits) ? data.hits : []
            if (hits.length === 0) {
              return text(`No indexed results for "${query}".`)
            }
            const lines = [`## Indexed results — "${query}"`, '']
            hits.forEach((hit, index) => {
              const source = String(hit.sourceType ?? 'CODE')
              const score = typeof hit.score === 'number' ? hit.score.toFixed(4) : ''
              const sha = hit.commitSha ? ` · ${String(hit.commitSha).slice(0, 7)}` : ''
              const ts = hit.timestamp ? ` · ${String(hit.timestamp).slice(0, 10)}` : ''
              lines.push(`### ${index + 1}. [${source}] ${hitLabel(hit)}${sha}${ts} (${score})`)
              if (hit.content) {
                const content = String(hit.content)
                lines.push('```', content.slice(0, 400) + (content.length > 400 ? '...' : ''), '```')
              }
              lines.push('')
            })
            return text(lines.join('\n'))
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Andromedia search unavailable: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }
          }
        },
      ),
  )

  server.registerTool(
    'andro_list_sources',
    {
      description:
        'List what Andromedia has indexed — source types, chunk counts, last sync. ' +
        'Check this before assuming ticket or chat context is available.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        service: z.string().optional(),
      },
    },
    async ({ service }) =>
      trackToolCall(
        'andro_list_sources',
        { argsSummary: service ?? 'default', args: { service } },
        async () => {
          try {
            const svc = service || client['service']
            const data = await client.request(
              'GET',
              `/api/v1/index/services/${encodeURIComponent(svc)}/overview`,
            )
            const types = Array.isArray(data.sourceTypes) ? data.sourceTypes : []
            return text(
              [
                `## Indexed sources — ${svc}`,
                '',
                `- Sources: ${types.length ? types.join(', ') : 'none'}`,
                `- Chunks: ${data.totalChunks ?? 0}`,
                `- Connected: ${data.sourcesConnected ?? 0}`,
                `- Last sync: ${data.lastSyncAt ?? 'never'}`,
              ].join('\n'),
            )
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Andromedia index status unavailable: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            }
          }
        },
      ),
  )
}
