import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractBearerToken } from '../src/auth.js'

/**
 * Minimal Express-Request stand-in: only the fields extractBearerToken reads.
 */
function req(headers: Record<string, string | undefined>, query: Record<string, unknown> = {}) {
  return { headers, query } as never
}

describe('extractBearerToken', () => {
  test('reads a Bearer header case-insensitively', () => {
    assert.equal(extractBearerToken(req({ authorization: 'Bearer abc123' })), 'abc123')
    assert.equal(extractBearerToken(req({ authorization: 'bearer   abc123  ' })), 'abc123')
  })

  test('reads x-api-key', () => {
    assert.equal(extractBearerToken(req({ 'x-api-key': 'k9' })), 'k9')
  })

  test('prefers the Authorization header over x-api-key', () => {
    assert.equal(
      extractBearerToken(req({ authorization: 'Bearer first', 'x-api-key': 'second' })),
      'first',
    )
  })

  test('returns null when no credential is present', () => {
    assert.equal(extractBearerToken(req({})), null)
    assert.equal(extractBearerToken(req({ authorization: 'Basic abc' })), null)
    assert.equal(extractBearerToken(req({ authorization: 'Bearer ' })), null)
  })

  test('does NOT accept a token from the query string', () => {
    // Regression guard: ?token= was previously accepted, which leaks the
    // credential into proxy logs, access logs, browser history and Referer
    // headers. This server is reachable from the public internet via Funnel.
    assert.equal(extractBearerToken(req({}, { token: 'leaked' })), null)
    assert.equal(extractBearerToken(req({ authorization: 'Bearer good' }, { token: 'bad' })), 'good')
  })
})
