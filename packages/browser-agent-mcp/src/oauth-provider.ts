import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Response } from 'express'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { config } from './config.js'

type StoredCode = {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  createdAt: number
}

type StoredToken = {
  token: string
  clientId: string
  scopes: string[]
  expiresAt: number
  resource?: string
  refreshToken?: string
}

type StoreFile = {
  clients: Record<string, OAuthClientInformationFull>
  tokens: Record<string, StoredToken>
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function dataDir(): string {
  const dir = join(homedir(), '.config', 'browser-agent-mcp')
  mkdirSync(dir, { recursive: true })
  return dir
}

function storePath(): string {
  return join(dataDir(), 'oauth-store.json')
}

function loadStore(): StoreFile {
  const path = storePath()
  if (!existsSync(path)) return { clients: {}, tokens: {} }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoreFile
  } catch {
    return { clients: {}, tokens: {} }
  }
}

function saveStore(store: StoreFile): void {
  writeFileSync(storePath(), JSON.stringify(store, null, 2), { mode: 0o600 })
}

function sessionCookieValue(): string {
  return createHash('sha256')
    .update(`bamcp:${config.authToken}`)
    .digest('hex')
    .slice(0, 32)
}

function hasValidSession(req: { headers: { cookie?: string }; body?: unknown }): boolean {
  const cookie = req.headers.cookie || ''
  const match = /(?:^|;\s*)bamcp_session=([^;]+)/.exec(cookie)
  if (match?.[1] && safeEqual(match[1], sessionCookieValue())) return true

  const body = (req.body ?? {}) as Record<string, unknown>
  const password = typeof body.password === 'string' ? body.password : ''
  if (password && safeEqual(password, config.authToken)) return true

  return false
}

function consentHtml(query: Record<string, string>): string {
  const fields = Object.entries(query)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}" />`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize Andro Agent</title>
  <style>
    body { font-family: system-ui, sans-serif; background:#faf7f2; color:#2a1f18; margin:0; min-height:100vh; display:grid; place-items:center; }
    form { background:#fffdf9; border:1px solid #e8dcc8; padding:2rem; width:min(420px,92vw); border-radius:12px; }
    h1 { font-size:1.25rem; margin:0 0 .5rem; }
    p { color:#7a6a5c; font-size:.95rem; }
    input[type=password] { width:100%; padding:.7rem .8rem; border:1px solid #c4a484; border-radius:8px; box-sizing:border-box; }
    button { margin-top:1rem; width:100%; padding:.75rem; border:0; border-radius:8px; background:#6b4f3a; color:#fff; font-weight:600; cursor:pointer; }
  </style>
</head>
<body>
  <form method="POST">
    <h1>Authorize ChatGPT / Claude</h1>
    <p>Paste your Andro Agent token to allow this client to use your laptop tools.</p>
    ${fields}
    <label>MCP token<br/><input type="password" name="password" required autocomplete="current-password" /></label>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`
}

export class FileBackedClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return loadStore().clients[clientId]
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): Promise<OAuthClientInformationFull> {
    const store = loadStore()
    const full = client as OAuthClientInformationFull
    store.clients[full.client_id] = full
    saveStore(store)
    return full
  }
}

export class FileBackedAuthProvider implements OAuthServerProvider {
  clientsStore = new FileBackedClientsStore()
  private codes = new Map<string, StoredCode>()

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const req = res.req
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError('Unregistered redirect_uri')
    }

    if (!hasValidSession(req)) {
      const q: Record<string, string> = {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        code_challenge_method: 'S256',
      }
      if (params.state) q.state = params.state
      if (params.scopes?.length) q.scope = params.scopes.join(' ')
      if (params.resource) q.resource = params.resource.toString()
      res.status(200).type('html').send(consentHtml(q))
      return
    }

    // Set session cookie after successful password
    res.setHeader(
      'Set-Cookie',
      `bamcp_session=${sessionCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`,
    )

    const code = randomUUID()
    this.codes.set(code, { client, params, createdAt: Date.now() })
    const target = new URL(params.redirectUri)
    target.searchParams.set('code', code)
    if (params.state) target.searchParams.set('state', params.state)
    res.redirect(302, target.toString())
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const data = this.codes.get(authorizationCode)
    if (!data) throw new Error('Invalid authorization code')
    return data.params.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode)
    if (!codeData) throw new Error('Invalid authorization code')
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client')
    }
    this.codes.delete(authorizationCode)

    const accessToken = randomBytes(32).toString('hex')
    const refreshToken = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000
    const store = loadStore()
    const record: StoredToken = {
      token: accessToken,
      clientId: client.client_id,
      scopes: codeData.params.scopes || ['mcp:tools'],
      expiresAt,
      resource: codeData.params.resource?.toString(),
      refreshToken,
    }
    store.tokens[accessToken] = record
    store.tokens[refreshToken] = { ...record, token: refreshToken }
    saveStore(store)

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 24 * 60 * 60,
      refresh_token: refreshToken,
      scope: (codeData.params.scopes || ['mcp:tools']).join(' '),
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const store = loadStore()
    const existing = store.tokens[refreshToken]
    if (!existing || existing.clientId !== client.client_id) {
      throw new Error('Invalid refresh token')
    }
    const accessToken = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000
    const record: StoredToken = {
      token: accessToken,
      clientId: client.client_id,
      scopes: scopes || existing.scopes,
      expiresAt,
      resource: existing.resource,
      refreshToken,
    }
    store.tokens[accessToken] = record
    saveStore(store)
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 24 * 60 * 60,
      refresh_token: refreshToken,
      scope: record.scopes.join(' '),
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Accept static MCP_AUTH_TOKEN for Claude / curl
    if (safeEqual(token, config.authToken)) {
      return {
        token,
        clientId: 'static-token',
        scopes: ['mcp:tools'],
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      }
    }

    const store = loadStore()
    const tokenData = store.tokens[token]
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new Error('Invalid or expired token')
    }
    // refresh tokens shouldn't authenticate API calls
    if (tokenData.refreshToken === token) {
      throw new Error('Invalid access token')
    }
    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource ? new URL(tokenData.resource) : undefined,
    }
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const store = loadStore()
    delete store.tokens[request.token]
    saveStore(store)
  }
}
