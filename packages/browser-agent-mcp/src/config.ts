import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const CONFIG_DIR = join(homedir(), '.config', 'browser-agent-mcp')
export const TOKEN_PATH = join(CONFIG_DIR, 'token')
export const ENV_PATH = join(CONFIG_DIR, 'env')

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return value
}

/**
 * Load ~/.config/browser-agent-mcp/env into process.env (does not override
 * already-set variables). Safe to call multiple times.
 */
export function loadEnvFile(path: string = ENV_PATH): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val
    }
  }
}

/** Best-effort MagicDNS from `tailscale status --json`. */
export function detectMagicDns(): string | undefined {
  try {
    const result = spawnSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result.status !== 0 || !result.stdout) return undefined
    const json = JSON.parse(result.stdout) as {
      Self?: { DNSName?: string }
    }
    const name = json.Self?.DNSName?.replace(/\.$/, '').trim()
    return name || undefined
  } catch {
    return undefined
  }
}

// Prefer config-dir env file before reading any settings (systemd used to do this).
loadEnvFile()

function loadToken(): string {
  const fromEnv = env('MCP_AUTH_TOKEN')
  if (fromEnv) return fromEnv.trim()

  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, 'utf8').trim()
  }

  throw new Error(
    'MCP_AUTH_TOKEN is not set and ~/.config/browser-agent-mcp/token is missing. Run: andro-agent init',
  )
}

function loadAllowedHosts(): string[] {
  const raw = env('ALLOWED_HOSTS', '127.0.0.1,localhost')!
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

const defaultPort = env('PORT', '8787')!
const defaultPublicBase = `http://127.0.0.1:${defaultPort}/agent`

let cachedToken: string | undefined

export const config = {
  host: env('HOST', '127.0.0.1')!,
  port: Number.parseInt(defaultPort, 10),
  workspaceRoot: env('WORKSPACE_ROOT', join(homedir(), 'Documents', 'GitHub'))!,
  get authToken(): string {
    if (cachedToken === undefined) cachedToken = loadToken()
    return cachedToken
  },
  allowedHosts: loadAllowedHosts(),
  bashTimeoutMs: Number.parseInt(env('BASH_TIMEOUT_MS', '30000')!, 10),
  /**
   * Filesystem confinement for the Bash tool.
   *  - `auto` (default): confine with bwrap when it is installed and working,
   *    and refuse to run Bash otherwise.
   *  - `off`: run Bash with no confinement. Only appropriate where the whole
   *    machine is already the trust boundary (a dedicated VM), since this
   *    exposes anything the user account can read.
   */
  sandboxMode: (env('SANDBOX_MODE', 'auto')!.toLowerCase() === 'off' ? 'off' : 'auto') as
    | 'auto'
    | 'off',
  /**
   * Local Andromedia core API, for the context tools (andro_search /
   * andro_investigate / andro_list_sources). These are read-only.
   */
  androBaseUrl: env('ANDRO_BASE_URL', 'http://localhost:8083')!,
  /** Default Andromedia service/workspace name. */
  androService: env('ANDRO_SERVICE', 'local')!,
  /** Public HTTPS origin+path for OAuth AS endpoints (must be under Funnel /agent). */
  publicBaseUrl: env('PUBLIC_BASE_URL', defaultPublicBase)!,
  /** Public MCP resource URL ChatGPT/Claude connect to. */
  publicMcpUrl: env('PUBLIC_MCP_URL', `${defaultPublicBase}/mcp`)!,
}
