/** Shared performance limits and skip rules for MCP tools. */

export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.vite',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.idea',
  '.vscode',
  'Pods',
  'DerivedData',
  'tmp',
  'temp',
])

/** Glob: max paths returned (was 500). */
export const GLOB_MAX_MATCHES = 100

/** Grep: default / hard max matching lines. */
export const GREP_DEFAULT_MAX = 30
export const GREP_HARD_MAX = 100

/** Read: default line window when limit omitted (avoids dumping huge files). */
export const READ_DEFAULT_LIMIT = 250
export const READ_HARD_MAX = 800

/** Skip files larger than this in fallback Grep walker. */
export const GREP_MAX_FILE_BYTES = 512_000

/** Bash / rg captured output caps (chars). */
export const STDOUT_CAP = 48_000
export const STDERR_CAP = 16_000

/** Default Bash timeout if env unset (config may override). */
export const BASH_DEFAULT_TIMEOUT_MS = 30_000

export function shouldSkipDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name)
}

/** Extra ripgrep globs to prune heavy trees. */
export function rgExcludeGlobs(): string[] {
  return [...SKIP_DIR_NAMES].flatMap((d) => [`!${d}`, `!**/${d}/**`])
}

export function truncateOutput(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n…truncated ${label} at ${cap} chars`
}
