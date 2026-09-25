#!/usr/bin/env node
/**
 * Backwards-compatible entry: start the MCP server directly
 * (systemd / `node dist/index.js` / `npm start`).
 */
import { startServer } from './server.js'

process.on('uncaughtException', (error) => {
  console.error('[andro-agent] uncaughtException:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('[andro-agent] unhandledRejection:', reason)
  process.exit(1)
})

process.on('SIGTERM', () => {
  console.error('[andro-agent] received SIGTERM, shutting down')
  process.exit(0)
})

startServer()
