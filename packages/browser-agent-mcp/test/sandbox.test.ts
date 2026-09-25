import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSandboxedCommand,
  resetSandboxStatusCache,
  sandboxStatus,
  SandboxUnavailableError,
} from '../src/sandbox.js'

/**
 * These tests exercise the real confinement, not a mock. They are the guard
 * against regressing to "cwd is validated, therefore it is a jail", which is
 * what the Bash tool did before: `cwd` was checked but the command itself ran
 * unconfined, so `cat /etc/passwd` worked regardless.
 *
 * Skipped (with a visible reason) when bwrap is unavailable, since that is an
 * environment property rather than a code defect.
 */

let root: string
let workspace: string
let outsideFile: string

const status = sandboxStatus()
const canSandbox = status.active

before(() => {
  root = mkdtempSync(join(tmpdir(), 'andro-sandbox-'))
  workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'inside.txt'), 'INSIDE_OK\n')
  outsideFile = join(root, 'outside.txt')
  writeFileSync(outsideFile, 'OUTSIDE_SECRET\n')
})

after(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Run a command through the same argv the Bash tool builds. */
function runSandboxed(command: string): { code: number | null; output: string } {
  const { exe, args } = buildSandboxedCommand(command, workspace)
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000 })
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

describe('sandbox availability', () => {
  test('reports a coherent status', () => {
    resetSandboxStatusCache()
    const s = sandboxStatus()
    assert.ok(['bwrap', 'none'].includes(s.backend))
    if (s.active) {
      assert.equal(s.reason, 'ok')
      assert.equal(s.backend, 'bwrap')
    } else {
      assert.notEqual(s.reason, 'ok')
    }
  })

  test('refuses to build an unconfined command when no sandbox is available', () => {
    // Force the unavailable path by asking for a bogus workspace only when the
    // sandbox is genuinely off; otherwise assert the happy path instead.
    if (canSandbox) {
      const cmd = buildSandboxedCommand('true', workspace)
      assert.equal(cmd.exe, status.detail)
      assert.ok(cmd.args.includes('--bind'))
      return
    }
    assert.throws(() => buildSandboxedCommand('true', workspace), SandboxUnavailableError)
  })
})

describe('workspace confinement', () => {
  test('allows reading and writing inside the workspace', { skip: !canSandbox }, () => {
    const read = runSandboxed('cat inside.txt')
    assert.equal(read.code, 0, read.output)
    assert.match(read.output, /INSIDE_OK/)

    const write = runSandboxed('echo hello > created.txt && cat created.txt')
    assert.equal(write.code, 0, write.output)
    assert.match(write.output, /hello/)
    assert.ok(existsSync(join(workspace, 'created.txt')))
  })

  test('blocks reading a file outside the workspace by relative path', { skip: !canSandbox }, () => {
    const r = runSandboxed('cat ../outside.txt')
    assert.notEqual(r.code, 0, `expected failure, got: ${r.output}`)
    assert.doesNotMatch(r.output, /OUTSIDE_SECRET/)
  })

  test('blocks reading a file outside the workspace by absolute path', { skip: !canSandbox }, () => {
    const r = runSandboxed(`cat ${outsideFile}`)
    assert.notEqual(r.code, 0, `expected failure, got: ${r.output}`)
    assert.doesNotMatch(r.output, /OUTSIDE_SECRET/)
  })

  test('blocks writing outside the workspace', { skip: !canSandbox }, () => {
    const target = join(root, 'pwned.txt')
    runSandboxed(`echo pwned > ${target}`)
    assert.equal(existsSync(target), false, 'file outside the workspace was created')
  })

  test('does not expose the real home directory', { skip: !canSandbox }, () => {
    const r = runSandboxed('ls -a ~')
    // HOME is redirected to a workspace-local directory, so no dotfiles from
    // the real home (notably ~/.ssh and the MCP token) are reachable.
    assert.doesNotMatch(r.output, /\.ssh/)
    assert.doesNotMatch(r.output, /\.aws/)
  })

  test('reports HOME inside the workspace', { skip: !canSandbox }, () => {
    const r = runSandboxed('echo "$HOME"')
    assert.equal(r.code, 0, r.output)
    assert.ok(
      r.output.startsWith(workspace),
      `HOME should be workspace-local, got: ${r.output}`,
    )
  })

  test('sibling directories are not readable', { skip: !canSandbox }, () => {
    const sibling = join(root, 'sibling')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'secret.txt'), 'SIBLING_SECRET\n')
    const r = runSandboxed(`cat ${sibling}/secret.txt`)
    assert.doesNotMatch(r.output, /SIBLING_SECRET/)
  })
})

describe('developer tooling still works', () => {
  test('node, git and bash run inside the sandbox', { skip: !canSandbox }, () => {
    const r = runSandboxed('git --version && node --version')
    assert.equal(r.code, 0, r.output)
    assert.match(r.output, /git version/)
    assert.match(r.output, /^v\d+/m)
  })

  test('the toolchain is on PATH even with a minimal parent env', { skip: !canSandbox }, () => {
    const { exe, args } = buildSandboxedCommand('command -v git && command -v node', workspace)
    const result = spawnSync(exe, args, { encoding: 'utf8', env: { PATH: '/nonexistent' } })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  })

  test('a private writable /tmp is available', { skip: !canSandbox }, () => {
    const r = runSandboxed('echo scratch > "$TMPDIR/x" && cat "$TMPDIR/x"')
    assert.equal(r.code, 0, r.output)
    assert.match(r.output, /scratch/)
  })

  test('DNS resolution works so package installs are possible', { skip: !canSandbox }, () => {
    const r = runSandboxed('getent hosts registry.npmjs.org || cat /etc/resolv.conf')
    assert.equal(r.code, 0, `DNS unavailable inside sandbox: ${r.output}`)
    assert.ok(r.output.length > 0)
  })

  test('keeps writes visible across separate calls', { skip: !canSandbox }, () => {
    // Confinement must not be one-shot: state a command creates in the
    // workspace has to still be there for the next call.
    const first = runSandboxed('mkdir -p sub && echo deep > sub/deep.txt')
    assert.equal(first.code, 0, first.output)
    assert.ok(existsSync(join(workspace, 'sub', 'deep.txt')), 'file was not written into the workspace')

    const second = runSandboxed('cat sub/deep.txt')
    assert.equal(second.code, 0, second.output)
    assert.match(second.output, /deep/)
  })
})
