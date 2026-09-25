import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Path-jail tests.
 *
 * `resolveInWorkspace` reads `config.workspaceRoot`, which snapshots the env at
 * import time, so the module is imported dynamically after WORKSPACE_ROOT is
 * set. That keeps the test against the real implementation rather than a
 * re-implementation of the logic.
 */

let root: string
let workspace: string
let outside: string

let resolveInWorkspace: (p: string, o?: { mustExist?: boolean }) => string
let assertCwdInWorkspace: (cwd?: string) => string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'andro-paths-'))
  workspace = join(root, 'ws')
  outside = join(root, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workspace, 'inside.txt'), 'ok\n')
  writeFileSync(join(outside, 'secret.txt'), 'SECRET\n')

  process.env.WORKSPACE_ROOT = workspace
  const mod = await import('../src/paths.js')
  resolveInWorkspace = mod.resolveInWorkspace
  assertCwdInWorkspace = mod.assertCwdInWorkspace
})

after(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveInWorkspace', () => {
  test('accepts a path inside the workspace', () => {
    const resolved = resolveInWorkspace('inside.txt', { mustExist: true })
    assert.equal(resolved, join(workspace, 'inside.txt'))
  })

  test('rejects ../ traversal', () => {
    assert.throws(() => resolveInWorkspace('../outside/secret.txt', { mustExist: true }), /escapes workspace/i)
  })

  test('rejects an absolute path outside the workspace', () => {
    assert.throws(
      () => resolveInWorkspace(join(outside, 'secret.txt'), { mustExist: true }),
      /escapes workspace/i,
    )
  })

  test('rejects deep traversal that climbs out and back in', () => {
    assert.throws(
      () => resolveInWorkspace('a/../../outside/secret.txt', { mustExist: true }),
      /escapes workspace/i,
    )
  })

  test('rejects a symlink pointing outside the workspace', () => {
    const link = join(workspace, 'escape-link')
    try {
      symlinkSync(outside, link)
    } catch {
      return // symlinks unavailable on this filesystem
    }
    assert.throws(() => resolveInWorkspace('escape-link/secret.txt', { mustExist: true }), /escapes workspace/i)
  })

  test('allows creating a new file inside an existing workspace directory', () => {
    const resolved = resolveInWorkspace('new-file.txt', { mustExist: false })
    assert.equal(resolved, join(workspace, 'new-file.txt'))
  })

  test('requires the parent directory to exist when creating a file', () => {
    // Deliberate: the real parent is resolved to keep symlink escapes from
    // slipping through on a path that does not exist yet. Callers that create
    // nested files pass createParents (see the Write tool).
    assert.throws(
      () => resolveInWorkspace('missing-dir/file.txt', { mustExist: false }),
      /Parent directory does not exist/i,
    )
  })

  test('createParents builds nested directories inside the workspace', () => {
    const resolved = resolveInWorkspace('nested/deep/file.txt', {
      mustExist: false,
      createParents: true,
    })
    assert.equal(resolved, join(workspace, 'nested/deep/file.txt'))
    assert.ok(existsSync(join(workspace, 'nested', 'deep')), 'parent dirs not created')
  })

  test('createParents still refuses to escape the workspace', () => {
    assert.throws(
      () =>
        resolveInWorkspace('../escaped-dir/file.txt', {
          mustExist: false,
          createParents: true,
        }),
      /escapes workspace|Parent directory/i,
    )
    assert.equal(existsSync(join(root, 'escaped-dir')), false, 'escaped dir was created')
  })

  test('rejects creating a new file outside the workspace', () => {
    assert.throws(
      () => resolveInWorkspace(join(outside, 'new.txt'), { mustExist: false }),
      /escapes workspace/i,
    )
  })
})

describe('assertCwdInWorkspace', () => {
  test('defaults to the workspace root', () => {
    assert.equal(assertCwdInWorkspace(undefined), workspace)
    assert.equal(assertCwdInWorkspace(''), workspace)
    assert.equal(assertCwdInWorkspace('.'), workspace)
  })

  test('rejects a cwd outside the workspace', () => {
    assert.throws(() => assertCwdInWorkspace(outside), /escapes workspace/i)
  })
})
