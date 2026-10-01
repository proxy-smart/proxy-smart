/**
 * Token-acquisition flow tests for the CLI `Session`.
 *
 * These exercise the real I/O orchestration (device-poll loop,
 * client_credentials, refresh-when-stale) end to end, all offline via an
 * injected `fetchImpl`. The device-poll loop never sleeps for real time: an
 * injected `sleepImpl`/`nowImpl` pair advances a fake clock so the RFC 8628
 * deadline and interval backoff can be asserted deterministically.
 *
 * The pure URL/body builders and parsers are covered in oauth.test.ts and the
 * cache round-trip helpers in session.test.ts; we do not re-test those here.
 */
import { describe, expect, it } from 'bun:test'
import { deriveCodeChallenge } from '../src/oauth'
import { Session, readCachedToken, writeCachedToken } from '../src/session'
import { jsonResponse, useTempHome } from './support'

const home = useTempHome('proxy-smart-cli-flows-')

/** A single recorded fetch call: where it went and what form body it carried. */
interface FetchCall {
  url: string
  method?: string
  body: URLSearchParams
}

/**
 * Build a fetch stub backed by a per-URL queue of canned responses. Each call
 * is recorded (URL + parsed form body) so tests can assert the grant_type and
 * fields actually sent. A URL whose queue is exhausted replays its last entry,
 * which is convenient for the discovery document.
 */
function scriptedFetch(routes: Record<string, Response[]>) {
  const calls: FetchCall[] = []
  const queues = new Map(Object.entries(routes).map(([url, responses]) => [url, [...responses]]))
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, method: init?.method, body: new URLSearchParams(rawBody) })
    const queue = queues.get(url)
    if (!queue || queue.length === 0) {
      return Promise.reject(new Error(`scriptedFetch: no canned response for ${url}`))
    }
    const next = queue.length === 1 ? queue[0]! : queue.shift()!
    // Clone so a replayed (last) response can be read more than once.
    return Promise.resolve(next.clone())
  }
  return { impl, calls }
}

/** Proxy-rewritten discovery document used by the default (proxy) path. */
const DISCOVERY = {
  token_endpoint: 'https://proxy.example.com/auth/token',
  device_authorization_endpoint: 'https://proxy.example.com/auth/device',
}
const DISCOVERY_URL = 'https://proxy.example.com/auth/.well-known/openid-configuration'
const TOKEN_URL = DISCOVERY.token_endpoint
const DEVICE_URL = DISCOVERY.device_authorization_endpoint

/** A device authorization response with a short window for the timeout tests. */
function deviceAuth(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    device_code: 'DEV-CODE',
    user_code: 'WXYZ-1234',
    verification_uri: 'https://proxy.example.com/device',
    expires_in: 600,
    interval: 5,
    ...overrides,
  })
}

/**
 * A controllable clock + sleep pair. Every `sleep(ms)` advances the clock by
 * `ms`, so the device-poll loop makes real progress toward its deadline without
 * any wall-clock waiting. Each slept interval is recorded for backoff asserts.
 */
function fakeClock(start = 0) {
  let nowMs = start
  const sleeps: number[] = []
  const sleepImpl = (ms: number): Promise<void> => {
    sleeps.push(ms)
    nowMs += ms
    return Promise.resolve()
  }
  const nowImpl = (): number => nowMs
  return { sleepImpl, nowImpl, sleeps }
}

describe('loginWithDeviceFlow device-poll loop (RFC 8628 §3.4-3.5)', () => {
  it('keeps polling through authorization_pending, then persists the granted token', async () => {
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [DEVICE_URL]: [deviceAuth()],
      [TOKEN_URL]: [
        jsonResponse({ error: 'authorization_pending' }, 400),
        jsonResponse({ error: 'authorization_pending' }, 400),
        jsonResponse({ access_token: 'GRANTED', refresh_token: 'RT', expires_in: 300 }),
      ],
    })
    const clock = fakeClock()
    const session = new Session(home.config(), impl, clock.sleepImpl, clock.nowImpl)

    const prompts: string[] = []
    const cached = await session.loginWithDeviceFlow((info) => {
      prompts.push(`${info.verification_uri}|${info.user_code}`)
    })

    // The prompt is invoked exactly once with the verification URL + user code.
    expect(prompts).toEqual(['https://proxy.example.com/device|WXYZ-1234'])

    // The granted token is returned and persisted to the cache.
    expect(cached.access_token).toBe('GRANTED')
    expect(readCachedToken(home.dir)?.access_token).toBe('GRANTED')
    expect(readCachedToken(home.dir)?.refresh_token).toBe('RT')

    // It polled the token endpoint three times (two pending + one success).
    const tokenCalls = calls.filter((call) => call.url === TOKEN_URL)
    expect(tokenCalls.length).toBe(3)
    expect(tokenCalls[0]!.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(tokenCalls[0]!.body.get('device_code')).toBe('DEV-CODE')
  })

  it('sends a PKCE S256 challenge in the device-auth request and replays the matching verifier on every poll', async () => {
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [DEVICE_URL]: [deviceAuth()],
      [TOKEN_URL]: [
        jsonResponse({ error: 'authorization_pending' }, 400),
        jsonResponse({ error: 'authorization_pending' }, 400),
        jsonResponse({ access_token: 'GRANTED', expires_in: 300 }),
      ],
    })
    const clock = fakeClock()
    const session = new Session(home.config(), impl, clock.sleepImpl, clock.nowImpl)

    await session.loginWithDeviceFlow(() => {})

    // The device authorization request advertises the S256 PKCE method and a
    // non-empty challenge (RFC 7636 §4.3).
    const deviceCall = calls.find((call) => call.url === DEVICE_URL)!
    const challenge = deviceCall.body.get('code_challenge')
    expect(deviceCall.body.get('code_challenge_method')).toBe('S256')
    expect(challenge).toBeTruthy()

    // Every token poll replays the SAME verifier, and that verifier hashes to
    // exactly the challenge that was advertised (RFC 7636 §4.5-4.6).
    const tokenCalls = calls.filter((call) => call.url === TOKEN_URL)
    expect(tokenCalls.length).toBe(3)
    const verifiers = tokenCalls.map((call) => call.body.get('code_verifier'))
    expect(verifiers.every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
    expect(new Set(verifiers).size).toBe(1)
    expect(deriveCodeChallenge(verifiers[0]!)).toBe(challenge)
  })

  it('backs off the poll interval by 5s on slow_down before the next poll', async () => {
    const { impl } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [DEVICE_URL]: [deviceAuth({ interval: 5 })],
      [TOKEN_URL]: [
        jsonResponse({ error: 'slow_down' }, 400),
        jsonResponse({ access_token: 'OK', expires_in: 300 }),
      ],
    })
    const clock = fakeClock()
    const session = new Session(home.config(), impl, clock.sleepImpl, clock.nowImpl)

    await session.loginWithDeviceFlow(() => {})

    // First sleep uses the advertised 5s interval; after slow_down the interval
    // is bumped by 5s, so the second sleep is 10s (RFC 8628 §3.5 backoff).
    expect(clock.sleeps).toEqual([5_000, 10_000])
  })

  it('throws a friendly timeout error when the device window elapses without approval', async () => {
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      // Short window: with a 5s interval the loop can poll only a couple times.
      [DEVICE_URL]: [deviceAuth({ expires_in: 12, interval: 5 })],
      [TOKEN_URL]: [jsonResponse({ error: 'authorization_pending' }, 400)],
    })
    const clock = fakeClock()
    const session = new Session(home.config(), impl, clock.sleepImpl, clock.nowImpl)

    await expect(session.loginWithDeviceFlow(() => {})).rejects.toThrow('timed out')

    // No token was cached, and the loop stopped instead of spinning forever.
    expect(readCachedToken(home.dir)).toBeUndefined()
    const tokenCalls = calls.filter((call) => call.url === TOKEN_URL)
    expect(tokenCalls.length).toBeGreaterThan(0)
    expect(tokenCalls.length).toBeLessThan(5)
  })

  it('surfaces a terminal access_denied error from the token endpoint', async () => {
    const { impl } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [DEVICE_URL]: [deviceAuth()],
      [TOKEN_URL]: [
        jsonResponse({ error: 'access_denied', error_description: 'user declined' }, 400),
      ],
    })
    const clock = fakeClock()
    const session = new Session(home.config(), impl, clock.sleepImpl, clock.nowImpl)

    await expect(session.loginWithDeviceFlow(() => {})).rejects.toThrow('user declined')
    expect(readCachedToken(home.dir)).toBeUndefined()
  })

  it('surfaces an expired_token error from the token endpoint as a device login failure', async () => {
    // NOTE: the implementation does not special-case `expired_token`; it falls
    // through to the generic terminal error rather than the "timed out" path.
    const { impl } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [DEVICE_URL]: [deviceAuth()],
      [TOKEN_URL]: [jsonResponse({ error: 'expired_token' }, 400)],
    })
    const clock = fakeClock()
    const session = new Session(home.config(), impl, clock.sleepImpl, clock.nowImpl)

    await expect(session.loginWithDeviceFlow(() => {})).rejects.toThrow('Device login failed')
    expect(readCachedToken(home.dir)).toBeUndefined()
  })

  it('errors before polling when the server advertises no device endpoint', async () => {
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse({ token_endpoint: TOKEN_URL })],
    })
    const session = new Session(home.config(), impl)

    await expect(session.loginWithDeviceFlow(() => {})).rejects.toThrow('device authorization endpoint')
    // Only discovery was hit; we never POSTed a device authorization request.
    expect(calls.map((call) => call.url)).toEqual([DISCOVERY_URL])
  })
})

describe('getAccessToken client_credentials acquisition', () => {
  it('runs a client_credentials grant when a secret is set and no fresh token is cached', async () => {
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [TOKEN_URL]: [jsonResponse({ access_token: 'CC-TOKEN', expires_in: 300 })],
    })
    const session = new Session(home.config({ clientSecret: 'shh', clientId: 'svc' }), impl)

    // getAccessToken takes no device prompt, so this path is fully non-interactive.
    const token = await session.getAccessToken()
    expect(token).toBe('CC-TOKEN')

    // It posted a client_credentials grant to the token endpoint.
    const tokenCall = calls.find((call) => call.url === TOKEN_URL)
    expect(tokenCall?.method).toBe('POST')
    expect(tokenCall?.body.get('grant_type')).toBe('client_credentials')
    expect(tokenCall?.body.get('client_id')).toBe('svc')
    expect(tokenCall?.body.get('client_secret')).toBe('shh')

    // The minted token is cached for reuse.
    expect(readCachedToken(home.dir)?.access_token).toBe('CC-TOKEN')
    expect(readCachedToken(home.dir)?.client_id).toBe('svc')
  })

  it('reuses a still-fresh cached token without any client_credentials round-trip', async () => {
    const future = Math.floor(Date.now() / 1000) + 3_600
    writeCachedToken(home.dir, { access_token: 'CACHED', client_id: 'svc', expires_at: future })
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [TOKEN_URL]: [jsonResponse({ access_token: 'SHOULD-NOT-BE-USED' })],
    })
    const session = new Session(home.config({ clientSecret: 'shh', clientId: 'svc' }), impl)

    expect(await session.getAccessToken()).toBe('CACHED')
    expect(calls.length).toBe(0)
  })
})

describe('getAccessToken refresh-when-stale', () => {
  /** Build a cached token whose access leg is expired but refresh leg is valid. */
  function staleButRefreshable() {
    const now = Math.floor(Date.now() / 1000)
    return {
      access_token: 'STALE',
      refresh_token: 'GOOD-RT',
      client_id: 'admin-ui',
      expires_at: now - 60,
      refresh_expires_at: now + 3_600,
    }
  }

  it('refreshes with the refresh_token grant and persists the new token', async () => {
    writeCachedToken(home.dir, staleButRefreshable())
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [TOKEN_URL]: [jsonResponse({ access_token: 'REFRESHED', refresh_token: 'NEW-RT', expires_in: 300 })],
    })
    const session = new Session(home.config(), impl)

    expect(await session.getAccessToken()).toBe('REFRESHED')

    const tokenCall = calls.find((call) => call.url === TOKEN_URL)
    expect(tokenCall?.body.get('grant_type')).toBe('refresh_token')
    expect(tokenCall?.body.get('refresh_token')).toBe('GOOD-RT')
    expect(tokenCall?.body.get('client_id')).toBe('admin-ui')

    // The new token (and rotated refresh token) replace the stale cache entry.
    expect(readCachedToken(home.dir)?.access_token).toBe('REFRESHED')
    expect(readCachedToken(home.dir)?.refresh_token).toBe('NEW-RT')
  })

  it('falls back to the login error when refresh fails and no secret is configured', async () => {
    writeCachedToken(home.dir, staleButRefreshable())
    const { impl } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [TOKEN_URL]: [jsonResponse({ error: 'invalid_grant', error_description: 'refresh expired' }, 400)],
    })
    const session = new Session(home.config(), impl)

    await expect(session.getAccessToken()).rejects.toThrow('login')
  })

  it('falls back to client_credentials when refresh fails and a secret is configured', async () => {
    writeCachedToken(home.dir, { ...staleButRefreshable(), client_id: 'svc' })
    const { impl, calls } = scriptedFetch({
      [DISCOVERY_URL]: [jsonResponse(DISCOVERY)],
      [TOKEN_URL]: [
        // First call (refresh) fails, second call (client_credentials) succeeds.
        jsonResponse({ error: 'invalid_grant' }, 400),
        jsonResponse({ access_token: 'CC-FALLBACK', expires_in: 300 }),
      ],
    })
    const session = new Session(home.config({ clientSecret: 'shh', clientId: 'svc' }), impl)

    expect(await session.getAccessToken()).toBe('CC-FALLBACK')

    const grants = calls.filter((call) => call.url === TOKEN_URL).map((call) => call.body.get('grant_type'))
    expect(grants).toEqual(['refresh_token', 'client_credentials'])
    expect(readCachedToken(home.dir)?.access_token).toBe('CC-FALLBACK')
  })
})
