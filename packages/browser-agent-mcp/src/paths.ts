import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { config } from './config.js'

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2))
  }
  return input
}

function resolveExistingReal(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // Parent may exist even if leaf does not (for Write of new files)
    return path
  }
}

export function getWorkspaceRoot(): string {
  const expanded = expandHome(config.workspaceRoot)
  const absolute = resolve(expanded)
  try {
    accessSync(absolute, constants.R_OK)
  } catch {
    throw new Error(`WORKSPACE_ROOT is not readable: ${absolute}`)
  }
  return realpathSync(absolute)
}

/**
 * Resolve a user-supplied path strictly under the workspace root.
 * Rejects escapes via .., symlinks outside root, or absolute paths outside root.
 *
 * @param options.mustExist  when true the leaf must already exist.
 * @param options.createParents
 *   when true, missing parent directories are created (inside the workspace)
 *   before resolving. This exists because resolving a not-yet-existing path
 *   needs a real parent to validate against, so callers that write new nested
 *   files cannot simply resolve first. Containment is still enforced: the
 *   directory is created through the same resolver, so an escaping parent is
 *   rejected before anything touches the filesystem.
 */
export function resolveInWorkspace(
  userPath: string,
  options?: { mustExist?: boolean; createParents?: boolean },
): string {
  const root = getWorkspaceRoot()
  const expanded = expandHome(userPath.trim() || '.')
  const candidate = isAbsolute(expanded)
    ? normalize(expanded)
    : normalize(join(root, expanded))

  // Build the missing parent chain one level at a time, validating containment
  // at each step so a symlinked or traversing ancestor cannot be created.
  if (options?.createParents && options?.mustExist === false) {
    const missing: string[] = []
    let cursor = candidate
    while (!existsSyncSafe(cursor) && cursor !== root) {
      const parent = resolve(cursor, '..')
      if (parent === cursor) break
      missing.push(cursor)
      cursor = parent
      if (missing.length > 64) break // pathological input guard
    }
    for (const dir of missing.reverse()) {
      const rel = relative(root, dir)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Path escapes workspace root (${root}): ${userPath}`)
      }
      mkdirSync(dir, { recursive: true })
    }
  }

  const realCandidate = options?.mustExist === false
    ? (() => {
        // Resolve real parent + keep basename for new files
        const parent = resolve(candidate, '..')
        let realParent: string
        try {
          realParent = realpathSync(parent)
        } catch {
          throw new Error(`Parent directory does not exist: ${parent}`)
        }
        const base = candidate.split(sep).pop() || ''
        return join(realParent, base)
      })()
    : resolveExistingReal(candidate)

  const rel = relative(root, realCandidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root (${root}): ${userPath}`)
  }

  return realCandidate
}

export function assertCwdInWorkspace(cwd?: string): string {
  if (!cwd || cwd.trim() === '' || cwd.trim() === '.') {
    return getWorkspaceRoot()
  }
  return resolveInWorkspace(cwd, { mustExist: true })
}

export function toWorkspaceRelative(absolutePath: string): string {
  const root = getWorkspaceRoot()
  const rel = relative(root, absolutePath)
  return rel === '' ? '.' : rel
}
