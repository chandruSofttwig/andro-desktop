import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import * as readline from 'node:readline'
import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { trackToolCall } from '../activity-bus.js'
import { getWorkspaceRoot } from '../paths.js'

interface AtlasProcess {
  child: ChildProcessWithoutNullStreams
  rl: readline.Interface
  nextId: number
  pending: Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >
  stderr: string
}

const processes = new Map<string, Promise<AtlasProcess>>()

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

function findAtlasEntry(): string | null {
  const envEntry = process.env.ATLAS_MCP_ENTRY || process.env.ATLAS_ENTRY
  const workspace = getWorkspaceRoot()
  const candidates = [
    envEntry,
    join(workspace, 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
    join(workspace, 'src-tauri', 'resources', 'atlas', 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
    join(workspace, 'src-tauri', 'target', 'debug', 'resources', 'atlas', 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
    join(workspace, 'tempest', 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
    join(workspace, 'tempest', 'src-tauri', 'resources', 'atlas', 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
    join(homedir(), 'Documents', 'GitHub', 'tempest', 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
    join(homedir(), 'Documents', 'GitHub', 'tempest', 'src-tauri', 'resources', 'atlas', 'node_modules', '@usetempest', 'atlas', 'dist', 'mcp', 'server-entry.js'),
  ].filter((p): p is string => Boolean(p))

  return candidates.map((p) => resolve(p)).find((p) => existsSync(p)) ?? null
}

function formatMissingAtlas(): string {
  return [
    'Atlas indexed tools are not available yet.',
    '',
    'Set ATLAS_MCP_ENTRY to Tempest\'s bundled Atlas server-entry.js, or run Tempest once so the Atlas bundle exists.',
    'Until then, use Read/Grep only for the narrow file or line range you need.',
  ].join('\n')
}

function hasAtlasIndex(projectPath: string): boolean {
  return existsSync(join(projectPath, '.tempest', 'atlas', 'atlas.db'))
}

function discoverIndexedProjects(): string[] {
  const root = getWorkspaceRoot()
  const found: string[] = []
  const skip = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next'])

  function walk(dir: string, depth: number): void {
    if (hasAtlasIndex(dir)) {
      found.push(dir)
      return
    }
    if (depth <= 0) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.tempest') continue
      walk(join(dir, entry.name), depth - 1)
    }
  }

  walk(root, 3)
  return found.sort((a, b) => a.localeCompare(b))
}

function defaultProjectPath(): string {
  const configured = process.env.ATLAS_PROJECT_PATH || process.env.ATLAS_DEFAULT_PROJECT
  if (configured?.trim()) return resolve(configured.trim())

  const workspace = getWorkspaceRoot()
  if (hasAtlasIndex(workspace)) return workspace

  const indexed = discoverIndexedProjects()
  if (indexed.length === 1) return indexed[0]!
  const tempest = indexed.find((path) => path.split(/[\\/]/).includes('tempest'))
  return tempest ?? workspace
}

async function getAtlas(projectPath: string): Promise<AtlasProcess> {
  const root = resolve(projectPath)
  const current = processes.get(root)
  if (current) return current
  const created = startAtlas(root).catch((error) => {
    processes.delete(root)
    throw error
  })
  processes.set(root, created)
  return created
}

async function startAtlas(projectPath: string): Promise<AtlasProcess> {
  const entry = findAtlasEntry()
  if (!entry) throw new Error(formatMissingAtlas())

  const child = spawn(process.execPath, ['--liftoff-only', entry, '--path', projectPath], {
    cwd: projectPath,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const proc: AtlasProcess = {
    child,
    rl: readline.createInterface({ input: child.stdout }),
    nextId: 1,
    pending: new Map(),
    stderr: '',
  }

  child.stderr.on('data', (chunk: Buffer) => {
    proc.stderr = (proc.stderr + chunk.toString('utf8')).slice(-4000)
  })
  child.on('close', () => {
    processes.delete(projectPath)
    for (const pending of proc.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Atlas MCP bridge exited'))
    }
    proc.pending.clear()
  })
  proc.rl.on('line', (line) => handleAtlasLine(proc, line))

  await request(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'andro-agent', version: '1.0.0' },
  })
  notify(proc, 'notifications/initialized', {})
  return proc
}

function handleAtlasLine(proc: AtlasProcess, line: string): void {
  if (!line.trim()) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const msg = parsed as { id?: unknown; result?: unknown; error?: { message?: string } }
  if (typeof msg.id !== 'number') return
  const pending = proc.pending.get(msg.id)
  if (!pending) return
  proc.pending.delete(msg.id)
  clearTimeout(pending.timer)
  if (msg.error) {
    pending.reject(new Error(msg.error.message || 'Atlas MCP error'))
  } else {
    pending.resolve(msg.result)
  }
}

function request(proc: AtlasProcess, method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
  if (proc.child.exitCode !== null) {
    return Promise.reject(new Error(proc.stderr || 'Atlas MCP bridge is not running'))
  }
  const id = proc.nextId++
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => {
      proc.pending.delete(id)
      reject(new Error(`Atlas MCP timed out during ${method}`))
    }, timeoutMs)
    timer.unref?.()
    proc.pending.set(id, { resolve: resolveValue, reject, timer })
    proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function notify(proc: AtlasProcess, method: string, params: unknown): void {
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

async function callAtlas(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const projectPath = typeof args.projectPath === 'string' && args.projectPath.trim()
    ? args.projectPath.trim()
    : defaultProjectPath()
  const proc = await getAtlas(projectPath)
  return request(proc, 'tools/call', { name: toolName, arguments: args })
}

export function registerAtlasTools(server: McpServer): void {
  server.registerTool(
    'atlas_projects',
    {
      description:
        'List projects that already have a Tempest Atlas index. Use this before atlas_explore when the workspace contains multiple repos or when you need the correct projectPath.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {},
    },
    async () =>
      trackToolCall('atlas_projects', { argsSummary: 'indexed projects' }, async () => {
        const projects = discoverIndexedProjects()
        if (projects.length === 0) return text('No Tempest Atlas indexes found under the workspace.')
        return text(
          [
            'Indexed Tempest Atlas projects:',
            '',
            ...projects.map((path) => `- ${path} (${basename(path)})`),
            '',
            `Default projectPath: ${defaultProjectPath()}`,
          ].join('\n'),
        )
      }),
  )

  server.registerTool(
    'atlas_explore',
    {
      description:
        'PRIMARY indexed code tool. Call this before Read/Grep for almost any code question, bug, architecture survey, or edit. It uses Tempest Atlas to return the relevant line-numbered source and relationships in one capped call; treat returned source as already read.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        query: z.string().describe('Natural language question, symbol names, file names, or code terms'),
        maxFiles: z.number().int().min(1).max(20).optional().describe('Maximum files to include'),
        projectPath: z.string().optional().describe('Absolute indexed project path. Defaults to the workspace root or its indexed project child.'),
      },
    },
    async (args) =>
      trackToolCall(
        'atlas_explore',
        { argsSummary: args.query, args: args as Record<string, unknown> },
        async () => {
          try {
            return (await callAtlas('atlas_explore', args as Record<string, unknown>)) as ReturnType<typeof text>
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error))
          }
        },
      ),
  )

  server.registerTool(
    'atlas_node',
    {
      description:
        'Read a source file or symbol through Tempest Atlas instead of the raw Read tool. Pass file alone to read a file with line numbers, or pass symbol to get a definition plus caller/callee context.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        symbol: z.string().optional().describe('Symbol name to inspect'),
        file: z.string().optional().describe('File path/basename to read or use for disambiguation'),
        includeCode: z.boolean().optional().describe('Include symbol body'),
        offset: z.number().int().min(1).optional().describe('File-mode 1-based starting line'),
        limit: z.number().int().min(1).max(2000).optional().describe('File-mode max lines'),
        symbolsOnly: z.boolean().optional().describe('Return file symbol map instead of source'),
        line: z.number().int().min(1).optional().describe('Disambiguate to definition near this line'),
        projectPath: z.string().optional().describe('Absolute indexed project path. Defaults to the workspace root or its indexed project child.'),
      },
    },
    async (args) =>
      trackToolCall(
        'atlas_node',
        {
          argsSummary: String(args.symbol || args.file || 'node'),
          paths: args.file ? [args.file] : [],
          args: args as Record<string, unknown>,
        },
        async () => {
          try {
            return (await callAtlas('atlas_node', args as Record<string, unknown>)) as ReturnType<typeof text>
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error))
          }
        },
      ),
  )
}
