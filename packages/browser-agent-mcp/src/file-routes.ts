import type { Express, Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { extractBearerToken } from './auth.js'
import { config } from './config.js'
import { getWorkspaceRoot } from './paths.js'
import { grepFiles, readFileWindow } from './ops/files.js'

/**
 * Local HTTP access to the read-only file tools.
 *
 * Exists so the desktop app can search and read the working tree directly,
 * instead of only querying the Andromedia index. It exposes *only* the
 * read-only operations — Read and Grep. Write, Edit and Bash stay reachable
 * only through MCP, so adding this surface does not widen what can change
 * data.
 *
 * Auth is the MCP bearer token, not the origin check used by the activity UI.
 * These routes return file contents, so a web page on the same machine must not
 * be able to read a workspace by simply being local.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req)
  if (!token || !safeEqual(token, config.authToken)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

/** Shared error shaping so the UI can show a useful message. */
function fail(res: Response, error: unknown, label: string): void {
  const message = error instanceof Error ? error.message : String(error)
  // A path outside the workspace is a client error, not a server fault.
  const status = /escapes workspace|not found|does not exist|ENOENT/i.test(message) ? 400 : 500
  res.status(status).json({ error: `${label}: ${message}` })
}

export function mountFileRoutes(app: Express): void {
  const prefixes = ['/files', '/agent/files'] as const

  for (const prefix of prefixes) {
    app.get(`${prefix}/workspace`, requireAuth, (_req, res) => {
      res.json({ workspaceRoot: getWorkspaceRoot() })
    })

    /** POST /files/grep { pattern, path?, glob?, case_insensitive?, max_results? } */
    app.post(`${prefix}/grep`, requireAuth, async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const pattern = typeof body.pattern === 'string' ? body.pattern : ''
      if (!pattern.trim()) {
        res.status(400).json({ error: 'pattern is required' })
        return
      }
      try {
        const outcome = await grepFiles({
          pattern,
          path: typeof body.path === 'string' ? body.path : undefined,
          glob: typeof body.glob === 'string' ? body.glob : undefined,
          caseInsensitive: body.case_insensitive === true,
          maxResults: typeof body.max_results === 'number' ? body.max_results : undefined,
        })
        res.json(outcome)
      } catch (error) {
        fail(res, error, 'grep failed')
      }
    })

    /** POST /files/read { path, offset?, limit? } */
    app.post(`${prefix}/read`, requireAuth, async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const path = typeof body.path === 'string' ? body.path : ''
      if (!path.trim()) {
        res.status(400).json({ error: 'path is required' })
        return
      }
      try {
        const window = await readFileWindow({
          path,
          offset: typeof body.offset === 'number' ? body.offset : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
        res.json(window)
      } catch (error) {
        fail(res, error, 'read failed')
      }
    })
  }
}
