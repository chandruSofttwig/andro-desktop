import type { Express, Request, Response, NextFunction } from 'express'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { activityBus } from './activity-bus.js'
import { extractBearerToken } from './auth.js'
import { config } from './config.js'
import { localOriginOnly } from './local-origin.js'
import { timingSafeEqual } from 'node:crypto'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function requireActivityAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req)
  if (!token || !safeEqual(token, config.authToken)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

function uiDistPath(): string {  const here = dirname(fileURLToPath(import.meta.url))
  // Packaged layout: dist/ui (copied at build). Dev/repo: ../ui/dist.
  const bundled = join(here, 'ui')
  if (existsSync(join(bundled, 'index.html'))) return bundled
  return join(here, '..', 'ui', 'dist')
}

export function mountActivityRoutes(app: Express): void {
  const prefixes = ['/activity', '/agent/activity'] as const

  for (const prefix of prefixes) {
    app.get(`${prefix}/snapshot`, requireActivityAuth, (_req, res) => {
      res.json({ events: activityBus.snapshot() })
    })

    app.post(`${prefix}/clear`, requireActivityAuth, (_req, res) => {
      activityBus.clear()
      res.json({ ok: true })
    })

    /**
     * Local-origin variants used by the bundled activity UI.
     *
     * The UI is served by this same server on loopback, so it authenticates by
     * origin instead of by token. Tokens in query strings end up in access
     * logs, browser history and Referer headers, so the UI must never carry
     * one.
     */
    app.get(`${prefix}/snapshot-ui`, localOriginOnly, (_req, res) => {
      res.json({ events: activityBus.snapshot() })
    })

    app.post(`${prefix}/clear-ui`, localOriginOnly, (_req, res) => {
      activityBus.clear()
      res.json({ ok: true })
    })

    // Local companion UI stream. The server is normally bound to loopback, so this
    // route lets a separately running Andro UI consume activity without exposing
    // the MCP bearer token to browser JavaScript.
    app.get(`${prefix}/events-ui`, localOriginOnly, (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`)
      for (const event of activityBus.snapshot()) send(event)
      send({ type: 'ready', ts: Date.now() })
      const unsubscribe = activityBus.subscribe(send)
      const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000)
      req.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
    })

    app.get(`${prefix}/events`, requireActivityAuth, (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()

      const send = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }

      // Snapshot first so reconnects catch up
      for (const event of activityBus.snapshot()) {
        send(event)
      }
      send({ type: 'ready', ts: Date.now() })

      const unsubscribe = activityBus.subscribe((event) => {
        send(event)
      })

      const heartbeat = setInterval(() => {
        res.write(`: ping ${Date.now()}\n\n`)
      }, 15000)

      req.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
    })
  }

  const dist = uiDistPath()
  if (!existsSync(dist)) {
    console.warn(`[andro-agent] activity UI not built (missing ${dist})`)
    for (const prefix of prefixes) {
      app.get(prefix, (_req, res) => {
        res
          .status(503)
          .type('text')
          .send('Activity UI not built. Run: npm run build:ui')
      })
    }
    return
  }

  for (const prefix of prefixes) {
    app.use(prefix, express.static(dist, { index: false, fallthrough: true }))
    app.get([prefix, `${prefix}/`, `${prefix}/*splat`], (_req, res) => {
      res.sendFile(join(dist, 'index.html'))
    })
  }
}
