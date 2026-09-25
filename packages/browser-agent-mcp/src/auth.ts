import type { Request, Response, NextFunction } from 'express'
import { config } from './config.js'
import { timingSafeEqual } from 'node:crypto'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match?.[1]) return match[1].trim()
  }

  // NOTE: the token is deliberately NOT accepted from ?token=. Query strings
  // are recorded by proxies, access logs, browser history and Referer headers,
  // so a credential passed that way leaks out of the trust boundary. MCP
  // clients that cannot set headers should use the OAuth flow instead.

  const alt = req.headers['x-api-key']
  if (typeof alt === 'string' && alt.trim()) return alt.trim()

  return null
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req)
  if (!token || !safeEqual(token, config.authToken)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Unauthorized: valid Bearer token required',
      },
      id: null,
    })
    return
  }
  next()
}
