import { describe, expect, it } from 'bun:test'
import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tokenCachePath } from '../src/config'
import {
  Session,
  readCachedToken,
  toCachedToken,
  writeCachedToken,
  type CachedToken,
} from '../src/session'
import { failingFetch, jsonResponse, useTempHome } from './support'

const home = useTempHome('proxy-smart-cli-session-')

/**
 * A fetch stub that records the URLs it was asked for and returns the proxy's
 * rewritten OIDC discovery document (token + device endpoints point at the
 * proxy, not Keycloak).
 */
function discoveryFetch(metadata: Record<string, unknown>, status = 200) {
  const calls: string[] = []
  const impl: typeof fetch = (input) => {
    calls.push(typeof input === 'string' ? input : input.toString())
    return Promise.resolve(jsonResponse(metadata, status))
  }
  return { impl, calls }
}

describe('token cache round-trip', () => {
  it('returns undefined when no token is cached', () => {
    expect(readCachedToken(home.dir)).toBeUndefined()
  })

  it('persists and reads back a token', () => {
    const token: CachedToken = { access_token: 'AT', refresh_token: 'RT', client_id: 'admin-ui', expires_at: 123 }
    writeCachedToken(home.dir, token)
    expect(readCachedToken(home.dir)).toEqual(token)
  })
})

describe('token cache robustness against concurrency / corruption', () => {
  it('treats a corrupt / partial token.json as "no token"', () => {
    // Simulate a half-written file from a racing process (truncated JSON).
    writeFileSync(tokenCachePath(home.dir), '{"access_token": "AT", "refr')
    expect(readCachedToken(home.dir)).toBeUndefined()
  })

  it('treats JSON without an access_token as "no token"', () => {
    writeFileSync(tokenCachePath(home.dir), JSON.stringify({ not_a_token: true }))
    expect(readCachedToken(home.dir)).toBeUndefined()
  })

  it('getAccessToken throws the friendly login error on a corrupt cache instead of crashing', async () => {
    writeFileSync(tokenCachePath(home.dir), '{ this is not json')
    const session = new Session(home.config(), failingFetch)
    await expect(session.getAccessToken()).rejects.toThrow('login')
  })

  it('does not leave a corrupt file when writes interleave; the result still parses', () => {
    const a: CachedToken = { access_token: 'A', refresh_token: 'RA', client_id: 'admin-ui', expires_at: 111 }
    const b: CachedToken = { access_token: 'B', refresh_token: 'RB', client_id: 'admin-ui', expires_at: 222 }
    // Interleave two writes back-to-back, as racing processes would.
    for (let i = 0; i < 20; i++) {
      writeCachedToken(home.dir, i % 2 === 0 ? a : b)
      const read = readCachedToken(home.dir)
      // Every observed state must be one of the two whole tokens, never torn.
      expect(read).toBeDefined()
      expect([a.access_token, b.access_token]).toContain(read?.access_token)
    }
    // No temp files are left behind in the home dir.
    expect(existsSync(`${tokenCachePath(home.dir)}.tmp`)).toBe(false)
  })

  it('does not leave the refresh lock file behind after a successful fresh-token read', async () => {
    const future = Math.floor(Date.now() / 1000) + 3_600
    writeCachedToken(home.dir, { access_token: 'FRESH', client_id: 'admin-ui', expires_at: future })
    const session = new Session(home.config(), failingFetch)
    await session.getAccessToken()
    expect(existsSync(join(home.dir, 'token.lock'))).toBe(false)
  })
})

describe('toCachedToken', () => {
  it('maps a token response onto a cached record with absolute expiries', () => {
    const cached = toCachedToken(
      { access_token: 'AT', refresh_token: 'RT', expires_in: 60, refresh_expires_in: 600, scope: 'openid' },
      'svc',
      1_000,
    )
    expect(cached).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_at: 1_060,
      refresh_expires_at: 1_600,
      scope: 'openid',
      client_id: 'svc',
    })
  })

  it('omits expiries when the response has no lifetimes', () => {
    const cached = toCachedToken({ access_token: 'AT' }, 'svc', 1_000)
    expect(cached.expires_at).toBeUndefined()
    expect(cached.refresh_expires_at).toBeUndefined()
  })
})

describe('Session.resolveEndpoints prefers the proxy', () => {
  it('discovers from the proxy and uses the proxy-rewritten endpoints by default', async () => {
    // The proxy rewrites token/device to itself so the CLI goes through it.
    const { impl, calls } = discoveryFetch({
      token_endpoint: 'https://proxy.example.com/auth/token',
      device_authorization_endpoint: 'https://proxy.example.com/auth/device',
      userinfo_endpoint: 'https://proxy.example.com/auth/userinfo',
    })
    const session = new Session(home.config(), impl)
    const endpoints = await session.resolveEndpoints()

    expect(calls).toEqual(['https://proxy.example.com/auth/.well-known/openid-configuration'])
    expect(endpoints.tokenEndpoint).toBe('https://proxy.example.com/auth/token')
    expect(endpoints.deviceAuthorizationEndpoint).toBe('https://proxy.example.com/auth/device')
    expect(endpoints.userinfoEndpoint).toBe('https://proxy.example.com/auth/userinfo')
  })

  /**
   * The proxy is the only authorization server. Even if a caller smuggles
   * Keycloak settings onto the config object, discovery must still go to the
   * proxy — there is no branch that would honour them.
   */
  it('discovers from the proxy even when stray Keycloak settings are present', async () => {
    const { impl, calls } = discoveryFetch({
      token_endpoint: 'https://proxy.example.com/auth/token',
      device_authorization_endpoint: 'https://proxy.example.com/auth/device',
    })
    const strayConfig = { ...home.config(), realm: 'app', keycloakUrl: 'https://kc.example.com', directKeycloak: true }
    const session = new Session(strayConfig, impl)
    const endpoints = await session.resolveEndpoints()

    expect(calls).toEqual(['https://proxy.example.com/auth/.well-known/openid-configuration'])
    expect(endpoints.tokenEndpoint).toBe('https://proxy.example.com/auth/token')
    expect(endpoints.tokenEndpoint).not.toContain('kc.example.com')
  })

  it('picks up the proxy device endpoint from discovery metadata', async () => {
    const { impl } = discoveryFetch({
      token_endpoint: 'https://proxy.example.com/auth/token',
      device_authorization_endpoint: 'https://proxy.example.com/auth/device',
    })
    const session = new Session(home.config(), impl)
    const endpoints = await session.resolveEndpoints()
    expect(endpoints.deviceAuthorizationEndpoint).toBe('https://proxy.example.com/auth/device')
  })

  it('memoizes discovery: a second call does not hit the network again', async () => {
    const { impl, calls } = discoveryFetch({ token_endpoint: 'https://proxy.example.com/auth/token' })
    const session = new Session(home.config(), impl)
    await session.resolveEndpoints()
    await session.resolveEndpoints()
    expect(calls.length).toBe(1)
  })

  it('raises a friendly error when proxy discovery fails', async () => {
    const { impl } = discoveryFetch({ error: 'not_found' }, 404)
    const session = new Session(home.config(), impl)
    await expect(session.resolveEndpoints()).rejects.toThrow('proxy')
  })
})

describe('Session.getAccessToken', () => {
  it('returns a cached, still-fresh access token without any network', async () => {
    const future = Math.floor(Date.now() / 1000) + 3_600
    writeCachedToken(home.dir, { access_token: 'FRESH', client_id: 'admin-ui', expires_at: future })
    const session = new Session(home.config(), failingFetch)
    expect(await session.getAccessToken()).toBe('FRESH')
  })

  it('throws a friendly error when not authenticated and no secret is set', async () => {
    const session = new Session(home.config(), failingFetch)
    await expect(session.getAccessToken()).rejects.toThrow('login')
  })

  it('clears the cached token on logout', () => {
    writeCachedToken(home.dir, { access_token: 'AT', client_id: 'admin-ui' })
    const session = new Session(home.config(), failingFetch)
    session.logout()
    expect(readCachedToken(home.dir)).toBeUndefined()
  })
})
