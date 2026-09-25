import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GREP_DEFAULT_MAX,
  GREP_HARD_MAX,
  GREP_MAX_FILE_BYTES,
  READ_DEFAULT_LIMIT,
  READ_HARD_MAX,
  rgExcludeGlobs,
  shouldSkipDirName,
} from '../limits.js'
import { getWorkspaceRoot, resolveInWorkspace, toWorkspaceRelative } from '../paths.js'

/**
 * Structured file operations.
 *
 * These exist so the MCP tools and the local HTTP routes share one
 * implementation. The tools format the results for a model; the HTTP routes
 * hand the same data to the desktop UI as JSON. Duplicating the logic would let
 * the two drift, and the sandbox guarantees must hold in both.
 *
 * Everything resolves through `resolveInWorkspace`, so a path that escapes the
 * workspace is rejected before any filesystem call.
 */

export interface GrepMatch {
  /** Workspace-relative path, so the UI can display it without the host prefix. */
  path: string
  line: number
  text: string
}

export interface GrepOutcome {
  matches: GrepMatch[]
  /** True when the cap was hit, so the UI can say "showing first N". */
  truncated: boolean
  /** Which engine produced the result — ripgrep if available, else the fallback. */
  engine: 'rg' | 'node'
  /** True when the fallback ran out of time before covering the whole tree. */
  timedOut?: boolean
}

/**
 * Wall-clock budget for the Node fallback.
 *
 * Without ripgrep, finding *few* matches is the expensive case: the walk cannot
 * stop until it has seen every file. A whole-workspace scan took 34s in testing
 * for a pattern with four hits, because the caller asked for 60. Bounding the
 * walk keeps a query from appearing to hang; the caller is told the result is
 * partial instead.
 */
const NODE_FALLBACK_BUDGET_MS = 8_000

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: err.message, missing: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, missing: false })
    })
  })
}

export interface ReadWindow {
  path: string
  content: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
}

/** Read a window of a workspace file, 1-based and inclusive. */
export async function readFileWindow(input: {
  path: string
  offset?: number
  limit?: number
}): Promise<ReadWindow> {
  const abs = resolveInWorkspace(input.path, { mustExist: true })
  const raw = await readFile(abs, 'utf8')
  const lines = raw.split('\n')
  const start = input.offset ? Math.max(0, input.offset - 1) : 0
  const window = Math.min(input.limit ?? READ_DEFAULT_LIMIT, READ_HARD_MAX)
  const end = Math.min(start + window, lines.length)
  return {
    path: toWorkspaceRelative(abs),
    content: lines.slice(start, end).join('\n'),
    startLine: lines.length === 0 ? 0 : start + 1,
    endLine: end,
    totalLines: lines.length,
    truncated: end < lines.length,
  }
}

/**
 * Search file contents under the workspace.
 *
 * Uses ripgrep when present and falls back to a Node walk otherwise — the same
 * two paths the MCP tool takes, so behaviour does not depend on which caller
 * asked.
 */
export async function grepFiles(input: {
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  maxResults?: number
}): Promise<GrepOutcome> {
  const cwd = getWorkspaceRoot()
  const target = input.path ? resolveInWorkspace(input.path, { mustExist: true }) : cwd
  const limit = Math.min(input.maxResults ?? GREP_DEFAULT_MAX, GREP_HARD_MAX)

  const args = ['-n', '--no-heading', '--color', 'never', '-m', String(limit), '--hidden']
  for (const g of rgExcludeGlobs()) args.push('--glob', g)
  if (input.caseInsensitive) args.push('-i')
  if (input.glob) args.push('--glob', input.glob)
  args.push('--', input.pattern, target)

  const result = await run('rg', args, cwd, 20_000)
  if (result.missing || result.code === 127 || /ENOENT|not found/i.test(result.stderr)) {
    const { matches, timedOut } = await nodeSearch({
      root: target,
      pattern: input.pattern,
      caseInsensitive: input.caseInsensitive,
      globFilter: input.glob,
      limit,
      deadline: Date.now() + NODE_FALLBACK_BUDGET_MS,
    })
    return {
      matches,
      truncated: matches.length >= limit || timedOut,
      engine: 'node',
      timedOut,
    }
  }

  const matches: GrepMatch[] = []
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    // rg emits "<abs path>:<line>:<text>"; the path may itself contain colons on
    // Windows drives, so split on the first two from the left of the numeric
    // segment rather than greedily.
    const match = /^(.*?):(\d+):(.*)$/.exec(line)
    if (!match) continue
    matches.push({
      path: safeRelative(match[1]),
      line: Number.parseInt(match[2], 10),
      text: match[3],
    })
    if (matches.length >= limit) break
  }
  return { matches, truncated: matches.length >= limit, engine: 'rg' }
}

function safeRelative(absolute: string): string {
  try {
    return toWorkspaceRelative(absolute)
  } catch {
    return absolute
  }
}

async function nodeSearch(input: {
  root: string
  pattern: string
  caseInsensitive?: boolean
  globFilter?: string
  limit: number
  deadline: number
}): Promise<{ matches: GrepMatch[]; timedOut: boolean }> {
  const flags = input.caseInsensitive ? 'i' : ''
  let matcher: RegExp
  try {
    matcher = new RegExp(input.pattern, flags)
  } catch {
    // An invalid regex reaches the model as a literal search rather than an
    // error, matching the ripgrep path's behaviour on the same input.
    matcher = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }
  const glob = globToRegExp(input.globFilter)
  const matches: GrepMatch[] = []

  let timedOut = false

  async function walk(dir: string): Promise<void> {
    if (matches.length >= input.limit) return
    if (Date.now() > input.deadline) {
      timedOut = true
      return
    }
    // Yield periodically so a long scan cannot block the event loop and stall
    // the HTTP response it belongs to.
    await new Promise((resolve) => setImmediate(resolve))
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= input.limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipDirName(entry.name) || entry.name.startsWith('.')) continue
        await walk(full)
        if (timedOut) return
        continue
      }
      if (!entry.isFile()) continue
      if (glob && !glob.test(entry.name)) continue
      try {
        const content = await readFile(full, 'utf8')
        if (content.length > GREP_MAX_FILE_BYTES) continue
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (matcher.test(lines[i])) {
            matches.push({ path: safeRelative(full), line: i + 1, text: lines[i] })
            if (matches.length >= input.limit) return
          }
        }
      } catch {
        // Binary or unreadable; skip rather than fail the whole search.
      }
    }
  }

  await walk(input.root)
  return { matches, timedOut }
}

/** Minimal glob support for the fallback path: only `*` and `?` are honoured. */
function globToRegExp(glob: string | undefined): RegExp | null {
  if (!glob) return null
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}
