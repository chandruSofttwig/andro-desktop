import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { config } from './config.js'
import { getWorkspaceRoot } from './paths.js'

/**
 * Filesystem confinement for the Bash tool.
 *
 * The Bash tool runs an arbitrary shell string, so validating `cwd` alone is not
 * a jail: `cat /etc/passwd`, `cd / && …`, or `~/.ssh` all escape a workspace
 * that is only enforced via the working directory. This module wraps the
 * command in `bwrap(1)` so the process can genuinely only see the workspace.
 *
 * If no sandbox backend is available the command still runs, but only when
 * explicitly allowed — see {@link SandboxUnavailableError} and the
 * ALLOW_UNSANDBOXED_BASH escape hatch. Failing closed by default means a
 * misconfigured host cannot silently expose the user's whole filesystem to a
 * remote model, which for this server (public via Tailscale Funnel) is the
 * only safe default.
 */

export type SandboxBackend = 'bwrap' | 'none'

export type SandboxReason =
  | 'ok'
  | 'disabled-by-config'
  | 'unsupported-platform'
  | 'bwrap-not-installed'
  | 'bwrap-not-functional'

export interface SandboxStatus {
  backend: SandboxBackend
  /** True when commands will actually be confined. */
  active: boolean
  reason: SandboxReason
  detail?: string
}

let cachedStatus: SandboxStatus | undefined

/** Read-only system paths a normal build/test command needs. */
const READ_ONLY_BINDS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']

/**
 * Directories bound read-only when present.
 *
 * `/run` matters on systemd hosts: `/etc/resolv.conf` is a symlink into
 * `/run/systemd/resolve/`, so without it DNS fails inside the sandbox and
 * `npm install` / `git fetch` break with ENOTFOUND.
 */
const OPTIONAL_READ_ONLY_BINDS = ['/run', '/opt', '/nix']

function bwrapBinary(): string | null {
  const which = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim()
  }
  return null
}

/**
 * Run a trivial confined command to confirm bwrap works on this host.
 *
 * Presence on PATH is not enough: bwrap needs user-namespace support
 * (`kernel.unprivileged_userns_clone`) and on some hardened/containerised hosts
 * it is installed but always fails. Better to detect that once, up front, than
 * to have every Bash call fail at execution time.
 *
 * The probe must bind the same read-only system paths the real command does —
 * otherwise it fails with "execvp /bin/true: No such file or directory" and the
 * sandbox looks broken when it is fine.
 */
function bwrapWorks(binary: string): { ok: boolean; detail?: string } {
  const args: string[] = []
  for (const path of READ_ONLY_BINDS) {
    if (existsSync(path)) {
      args.push('--ro-bind', path, path)
    }
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--unshare-user', '--', '/bin/true')

  const probe = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000 })
  if (probe.status === 0) {
    return { ok: true }
  }
  const detail = (probe.stderr || probe.stdout || '').trim().split('\n')[0]
  return { ok: false, detail: detail || `exit ${probe.status}` }
}

/** Resolve sandbox availability once per process and cache it. */
export function sandboxStatus(): SandboxStatus {
  if (cachedStatus) {
    return cachedStatus
  }

  if (config.sandboxMode === 'off') {
    cachedStatus = { backend: 'none', active: false, reason: 'disabled-by-config' }
    return cachedStatus
  }

  if (process.platform !== 'linux') {
    cachedStatus = {
      backend: 'none',
      active: false,
      reason: 'unsupported-platform',
      detail: `bwrap is Linux-only; this host is ${process.platform}`,
    }
    return cachedStatus
  }

  const binary = bwrapBinary()
  if (!binary) {
    cachedStatus = { backend: 'none', active: false, reason: 'bwrap-not-installed' }
    return cachedStatus
  }

  const probe = bwrapWorks(binary)
  if (!probe.ok) {
    cachedStatus = {
      backend: 'none',
      active: false,
      reason: 'bwrap-not-functional',
      detail: probe.detail,
    }
    return cachedStatus
  }

  cachedStatus = { backend: 'bwrap', active: true, reason: 'ok', detail: binary }
  return cachedStatus
}

/** Test seam: forget the cached probe result. */
export function resetSandboxStatusCache(): void {
  cachedStatus = undefined
}

export class SandboxUnavailableError extends Error {
  constructor(status: SandboxStatus) {
    super(
      `Refusing to run Bash unrestricted: no sandbox available (${status.reason}` +
        (status.detail ? `: ${status.detail}` : '') +
        '). Install bubblewrap (apt install bubblewrap), or set SANDBOX_MODE=off to ' +
        'accept that the Bash tool can read and write anywhere this user can.',
    )
    this.name = 'SandboxUnavailableError'
  }
}

export interface SandboxedCommand {
  exe: string
  args: string[]
  /** Extra environment for the child, applied on top of the caller's env. */
  env: Record<string, string>
}

/**
 * Build the argv that runs `command` confined to the workspace.
 *
 * Layout inside the sandbox:
 *  - system paths are read-only,
 *  - the workspace is bind-mounted writable at its real path (so paths the
 *    model sees match paths on disk and git/npm/tooling behave normally),
 *  - /tmp is a private tmpfs,
 *  - HOME points at a workspace-local directory, so ~/.ssh, ~/.aws and the
 *    MCP token file are not reachable and tools that write to HOME still work,
 *  - the network namespace is NOT unshared, because build/test tooling needs
 *    to reach registries.
 */
export function buildSandboxedCommand(
  command: string,
  workspace: string,
): SandboxedCommand {
  const status = sandboxStatus()
  if (!status.active) {
    throw new SandboxUnavailableError(status)
  }

  const home = join(workspace, '.sandbox-home')
  // Created outside the sandbox so the bind mount has a target.
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true })
  }

  /**
   * Scratch space inside the workspace rather than /tmp.
   *
   * TMPDIR must not point at /tmp: the tmpfs mounted there is private, so a
   * workspace located under /tmp would be shadowed and `--chdir` would fail.
   * Keeping scratch inside the workspace also means build output the model may
   * want to inspect survives the call.
   */
  const tmpDir = join(workspace, '.sandbox-tmp')
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true })
  }

  const args: string[] = []
  for (const path of READ_ONLY_BINDS) {
    if (existsSync(path)) {
      args.push('--ro-bind', path, path)
    }
  }
  for (const path of OPTIONAL_READ_ONLY_BINDS) {
    if (existsSync(path)) {
      args.push('--ro-bind', path, path)
    }
  }

  args.push(
    // Private scratch space first, so a workspace that happens to live under
    // /tmp is not shadowed by the tmpfs mounted over it (bwrap applies mounts
    // in order). TMPDIR points here rather than at the real /tmp.
    '--tmpfs',
    '/tmp',
    // Writable workspace; this is the only place the command can modify.
    '--bind',
    workspace,
    workspace,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    // Isolate IPC/UTS/user namespaces but keep networking for package installs.
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--chdir',
    workspace,
    '--setenv',
    'HOME',
    home,
    '--setenv',
    'TMPDIR',
    tmpDir,
    // Keep the toolchain on PATH regardless of how the server was launched.
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
    '--setenv',
    'SANDBOXED',
    '1',
    '--',
    '/bin/bash',
    '-lc',
    command,
  )

  return { exe: status.detail ?? 'bwrap', args, env: {} }
}
