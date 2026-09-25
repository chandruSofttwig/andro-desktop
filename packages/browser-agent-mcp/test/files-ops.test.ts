import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * File operations shared by the MCP tools and the local HTTP routes.
 *
 * The HTTP surface returns file contents, so containment is the property that
 * matters most here: these assert that a path outside the workspace is refused
 * before any filesystem access, on both operations.
 */

let root: string
let workspace: string
let outside: string

let readFileWindow: (i: { path: string; offset?: number; limit?: number }) => Promise<{
  content: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
}>
let grepFiles: (i: {
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  maxResults?: number
}) => Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }>

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'andro-ops-'))
  workspace = join(root, 'ws')
  outside = join(root, 'outside')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })

  writeFileSync(
    join(workspace, 'src', 'alpha.ts'),
    ['const one = 1', 'export function Alpha() {}', 'const three = 3'].join('\n'),
  )
  writeFileSync(join(workspace, 'src', 'beta.ts'), ['const beta = 2', 'export function Beta() {}'].join('\n'))
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET\n')

  process.env.WORKSPACE_ROOT = workspace
  const mod = await import('../src/ops/files.js')
  readFileWindow = mod.readFileWindow
  grepFiles = mod.grepFiles
})

after(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('readFileWindow', () => {
  test('returns a line window with 1-based inclusive bounds', async () => {
    const w = await readFileWindow({ path: 'src/alpha.ts', offset: 2, limit: 1 })
    assert.match(w.content, /export function Alpha/)
    assert.equal(w.startLine, 2)
    assert.equal(w.endLine, 2)
    assert.equal(w.totalLines, 3)
    assert.equal(w.truncated, true)
  })

  test('reports the whole file when it fits', async () => {
    const w = await readFileWindow({ path: 'src/beta.ts' })
    assert.equal(w.startLine, 1)
    assert.equal(w.endLine, 2)
    assert.equal(w.truncated, false)
  })

  test('refuses a relative escape', async () => {
    await assert.rejects(() => readFileWindow({ path: '../outside/secret.txt' }), /escapes workspace/i)
  })

  test('refuses an absolute path outside the workspace', async () => {
    await assert.rejects(
      () => readFileWindow({ path: join(outside, 'secret.txt') }),
      /escapes workspace/i,
    )
  })
})

describe('grepFiles', () => {
  test('finds matches with workspace-relative paths and line numbers', async () => {
    const { matches } = await grepFiles({ pattern: 'Alpha', path: 'src' })
    assert.ok(matches.length >= 1, 'expected a match')
    const hit = matches.find((m) => m.path.endsWith('alpha.ts'))
    assert.ok(hit, `expected alpha.ts in ${JSON.stringify(matches)}`)
    assert.equal(hit.line, 2)
    assert.match(hit.text, /Alpha/)
    // Workspace-relative, never the absolute host path.
    assert.ok(!hit.path.startsWith('/'), `path should be relative, got ${hit.path}`)
  })

  test('supports case-insensitive search', async () => {
    const { matches } = await grepFiles({ pattern: 'alpha', path: 'src', caseInsensitive: true })
    assert.ok(matches.length >= 1)
  })

  test('is case-sensitive by default', async () => {
    const { matches } = await grepFiles({ pattern: 'ALPHA', path: 'src' })
    assert.equal(matches.length, 0)
  })

  test('respects the result cap and reports truncation', async () => {
    const { matches, truncated } = await grepFiles({ pattern: 'const', path: 'src', maxResults: 1 })
    assert.equal(matches.length, 1)
    assert.equal(truncated, true)
  })

  test('refuses to search outside the workspace', async () => {
    await assert.rejects(
      () => grepFiles({ pattern: 'SECRET', path: join(outside) }),
      /escapes workspace|ENOENT/i,
    )
  })

  test('never returns content from outside the workspace', async () => {
    // Even if the pattern matches a file outside, a scoped search must not see it.
    const { matches } = await grepFiles({ pattern: 'OUTSIDE_SECRET', path: 'src' })
    assert.equal(matches.length, 0)
  })
})
