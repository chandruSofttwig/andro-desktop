import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isLocalOrigin } from '../src/local-origin.js'

/**
 * The `-ui` routes carry no bearer token (the UI is served by the agent on
 * loopback), so this origin check is their entire access control. It has to be
 * strict: a mistake here exposes activity data to any web page the user has
 * open.
 */

describe('isLocalOrigin', () => {
  test('allows loopback origins', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      'https://localhost:3000',
      'http://[::1]:8787',
    ]) {
      assert.equal(isLocalOrigin(origin), true, `${origin} should be allowed`)
    }
  })

  test('allows a missing Origin (curl, same-origin navigation, desktop shell)', () => {
    assert.equal(isLocalOrigin(undefined), true)
    assert.equal(isLocalOrigin(''), true)
  })

  test('rejects remote origins', () => {
    for (const origin of [
      'https://evil.example.com',
      'http://example.com',
      'https://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'https://notlocalhost',
    ]) {
      assert.equal(isLocalOrigin(origin), false, `${origin} should be rejected`)
    }
  })

  test('rejects a hostname that merely contains localhost', () => {
    // A naive `.includes('localhost')` check would pass these.
    assert.equal(isLocalOrigin('http://localhost.attacker.com'), false)
    assert.equal(isLocalOrigin('http://evil-localhost.com'), false)
    assert.equal(isLocalOrigin('http://notlocalhost.com'), false)
  })

  test('rejects non-http(s) schemes', () => {
    assert.equal(isLocalOrigin('file://localhost'), false)
    assert.equal(isLocalOrigin('ftp://localhost'), false)
  })

  test('rejects malformed origins rather than throwing', () => {
    assert.equal(isLocalOrigin('not a url'), false)
    assert.equal(isLocalOrigin('://'), false)
  })
})
