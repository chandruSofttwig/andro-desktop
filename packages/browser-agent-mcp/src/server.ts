import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js'
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js'
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js'
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js'
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { RequestHandler } from 'express'
import { config, loadEnvFile } from './config.js'
import { getWorkspaceRoot } from './paths.js'
import { registerAllTools } from './tools/index.js'
import { FileBackedAuthProvider } from './oauth-provider.js'
import { mountActivityRoutes } from './activity-routes.js'
import { mountFileRoutes } from './file-routes.js'

const LOG = '[andro-agent]'

function createServer(): McpServer {
  const server = new McpServer({
    name: 'andro-agent',
    version: '1.0.0',
  })
  registerAllTools(server)
  return server
}

async function handleMcp(
  req: import('express').Request,
  res: import('express').Response,
): Promise<void> {
  const server = createServer()
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
  } catch (error) {
    console.error('[mcp] request error', error instanceof Error ? error.message : error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
}

/**
 * Build AS metadata with endpoints under /agent/* (public Funnel URLs).
 * Avoid `new URL('/authorize', base)` which drops the /agent path prefix.
 */
function buildOAuthMetadata(issuer: URL): OAuthMetadata {
  const origin = issuer.origin
  const prefix = issuer.pathname.replace(/\/$/, '') || ''
  return {
    issuer: `${origin}${prefix}`,
    authorization_endpoint: `${origin}${prefix}/authorize`,
    token_endpoint: `${origin}${prefix}/token`,
    registration_endpoint: `${origin}${prefix}/register`,
    revocation_endpoint: `${origin}${prefix}/revoke`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: ['mcp:tools'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post'],
  }
}

/** Mount the same handler at several path prefixes (Funnel strips /agent and /.well-known). */
function mountMany(
  app: ReturnType<typeof createMcpExpressApp>,
  paths: string[],
  handler: RequestHandler,
): void {
  for (const path of paths) {
    app.use(path, handler)
  }
}

/** Start the Andro Agent MCP HTTP server (blocking listen). */
export function startServer(): void {
  loadEnvFile()

  const workspace = getWorkspaceRoot()
  const issuerUrl = new URL(config.publicBaseUrl)
  const resourceServerUrl = new URL(config.publicMcpUrl)
  const provider = new FileBackedAuthProvider()
  const oauthMetadata = buildOAuthMetadata(issuerUrl)
  const rsPath = resourceServerUrl.pathname // /agent/mcp

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts,
  })
  // Tailscale Funnel sets X-Forwarded-For; needed by OAuth rate-limit middleware
  app.set('trust proxy', 1)

  // OAuth endpoints: full /agent/* (local) + stripped /* (Funnel /agent → backend)
  mountMany(app, ['/agent/authorize', '/authorize'], authorizationHandler({ provider }))
  mountMany(app, ['/agent/token', '/token'], tokenHandler({ provider }))
  mountMany(
    app,
    ['/agent/register', '/register'],
    clientRegistrationHandler({ clientsStore: provider.clientsStore }),
  )
  mountMany(app, ['/agent/revoke', '/revoke'], revocationHandler({ provider }))

  // Protected resource metadata (RFC 9728)
  const prm = {
    resource: resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: ['mcp:tools'],
    resource_name: 'Andro Agent',
  }
  mountMany(
    app,
    [
      `/.well-known/oauth-protected-resource${rsPath}`,
      // Funnel strips /.well-known prefix
      `/oauth-protected-resource${rsPath}`,
    ],
    metadataHandler(prm),
  )

  // Authorization server metadata (RFC 8414) — root + path-aware + Funnel-stripped
  mountMany(
    app,
    [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/agent',
      '/oauth-authorization-server',
      '/oauth-authorization-server/agent',
    ],
    metadataHandler(oauthMetadata),
  )

  // Also install SDK metadata router for completeness (local full paths)
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: ['mcp:tools'],
      resourceName: 'Andro Agent',
    }),
  )

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl,
  })

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      name: 'andro-agent',
      workspace,
      port: config.port,
      oauth: true,
      mcpUrl: config.publicMcpUrl,
      issuer: oauthMetadata.issuer,
      activity: `http://${config.host}:${config.port}/activity`,
    })
  })

  mountActivityRoutes(app)
  mountFileRoutes(app)

  app.use('/mcp', authMiddleware)
  app.use('/agent/mcp', authMiddleware)

  for (const path of ['/mcp', '/agent/mcp'] as const) {
    app.post(path, (req, res) => {
      void handleMcp(req, res)
    })
    app.get(path, (req, res) => {
      void handleMcp(req, res)
    })
    app.delete(path, (req, res) => {
      void handleMcp(req, res)
    })
  }

  app.listen(config.port, config.host, () => {
    console.log(
      `${LOG} listening on http://${config.host}:${config.port} workspace=${workspace}`,
    )
    console.log(`${LOG} MCP: ${config.publicMcpUrl}`)
    console.log(`${LOG} OAuth issuer: ${oauthMetadata.issuer}`)
    console.log(`${LOG} authorize: ${oauthMetadata.authorization_endpoint}`)
    console.log(`${LOG} PRM: ${resourceMetadataUrl}`)
    console.log(`${LOG} activity UI: http://${config.host}:${config.port}/activity`)
    console.log(`${LOG} health: http://${config.host}:${config.port}/healthz`)
  })
}
