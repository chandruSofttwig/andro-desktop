import type { Request, Response, NextFunction } from 'express'

/**
 * Loopback-origin guard for the bundled UI routes.
 *
 * The UI is served by this same server on loopback, so those routes carry no
 * bearer token and authenticate by origin instead. Tokens in query strings end
 * up in access logs, browser history and Referer headers, so the UI must never
 * carry one.
 *
 * A request with no Origin header (curl, a same-origin navigation, or the
 * Electron shell) is allowed: it is already local by virtue of reaching a
 * loopback-bound port.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    const localHost =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    return localHost && (url.protocol === 'http:' || url.protocol === 'https:')
  } catch {
    return false
  }
}

export function localOriginOnly(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  if (!isLocalOrigin(origin)) {
    res.status(403).json({ error: 'Local UI only' })
    return
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  next()
}
