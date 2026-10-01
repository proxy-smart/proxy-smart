/**
 * A cached token belongs to ONE deployment, and the CLI must not present it to another.
 *
 * The bug this pins: URL resolution is flag > env > persisted > default, the default is
 * localhost, and `login` never persisted the URL it authenticated against (writePersistedConfig
 * existed but was dead code). So `login --url https://beta…` followed by a bare command targeted
 * localhost with a beta token and returned an opaque 401 — observed 2026-08-01.
 *
 * The 401 was the harmless symptom. The dangerous one is two deployments that BOTH accept the
 * token: a shell with PROXY_SMART_URL pointing at production turns a beta-intended
 * `idps update` into a production write that succeeds silently. Hence a refusal before any
 * network call, rather than nicer handling of the 401.
 */
import { describe, expect, it } from 'bun:test'
import { readPersistedConfig, resolveConfig, writePersistedConfig } from '../src/config'
import { CliError } from '../src/output'
import {
  Session,
  deploymentMismatch,
  toCachedToken,
  writeCachedToken,
  type CachedToken,
} from '../src/session'
import { failingFetch, useTempHome } from './support'

const BETA = 'https://beta.proxy-smart.com'
const LOCAL = 'http://localhost:8445'
const PROD = 'https://api.proxy-smart.com'

const home = useTempHome('proxy-smart-cli-deploy-')

/** A token cached as if `login --url <url>` had just run. */
function cached(url?: string): CachedToken {
  return {
    access_token: 'at',
    client_id: 'admin-ui',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...(url === undefined ? {} : { url }),
  }
}

describe('toCachedToken', () => {
  it('records the deployment the token came from', () => {
    const token = toCachedToken({ access_token: 'at', expires_in: 300 }, 'admin-ui', 1000, BETA)
    expect(token.url).toBe(BETA)
  })

  it('omits the field when no url is given, so older caches stay valid', () => {
    const token = toCachedToken({ access_token: 'at', expires_in: 300 }, 'admin-ui', 1000)
    expect('url' in token).toBe(false)
  })
})

describe('deploymentMismatch', () => {
  it('accepts a token from the deployment being targeted', () => {
    expect(deploymentMismatch(cached(BETA), BETA)).toBeUndefined()
  })

  it('rejects a beta token aimed at localhost — the reported failure', () => {
    const message = deploymentMismatch(cached(BETA), LOCAL)
    expect(message).toBeDefined()
    // Both URLs must appear: not noticing they differ IS the failure mode.
    expect(message).toContain(BETA)
    expect(message).toContain(LOCAL)
  })

  it('rejects a beta token aimed at production, which would otherwise succeed', () => {
    expect(deploymentMismatch(cached(BETA), PROD)).toBeDefined()
  })

  it('trusts a cache written before this field existed', () => {
    // Upgrading the CLI must not force a re-login.
    expect(deploymentMismatch(cached(undefined), PROD)).toBeUndefined()
  })
})

describe('Session.getAccessToken', () => {
  it('returns the token when the deployment matches', async () => {
    writeCachedToken(home.dir, cached(BETA))
    const session = new Session(home.config({ url: BETA }), failingFetch)
    expect(await session.getAccessToken()).toBe('at')
  })

  it('throws before any network call when the deployment differs', async () => {
    writeCachedToken(home.dir, cached(BETA))
    const session = new Session(home.config({ url: LOCAL }), failingFetch)

    // failingFetch would throw a different error if a request were attempted, so reaching a
    // CliError proves the refusal happens first.
    await expect(session.getAccessToken()).rejects.toThrow(CliError)
    await expect(session.getAccessToken()).rejects.toThrow(/beta\.proxy-smart\.com/)
  })

  it('refuses a fresh token for the wrong deployment rather than silently refreshing it', async () => {
    // A still-valid refresh token must not be a way around the check.
    writeCachedToken(home.dir, {
      ...cached(BETA),
      expires_at: Math.floor(Date.now() / 1000) - 10,
      refresh_token: 'rt',
      refresh_expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const session = new Session(home.config({ url: PROD }), failingFetch)
    await expect(session.getAccessToken()).rejects.toThrow(CliError)
  })
})

describe('login persists the target', () => {
  it('writePersistedConfig round-trips the url', () => {
    // The mechanism `rememberDeployment` relies on. It existed unused before this change, which
    // is why login forgot its target between invocations.
    writePersistedConfig(home.dir, { url: BETA })
    expect(readPersistedConfig(home.dir).url).toBe(BETA)
  })

  it('does not let the persisted target beat an explicit env var', () => {
    // Persisting is deliberately NOT enough: env outranks a stored default, which is why
    // `login --url beta` in a shell with PROXY_SMART_URL=prod still sends bare commands to prod.
    // Pinned so nobody "fixes" the order and makes an env var silently ignorable.
    writePersistedConfig(home.dir, { url: BETA })
    const env = { PROXY_SMART_HOME: home.dir, PROXY_SMART_URL: PROD }
    expect(resolveConfig({}, env).url).toBe(PROD)
    // ...and an explicit flag still outranks the env var.
    expect(resolveConfig({ url: BETA }, env).url).toBe(BETA)
    // With no env var, the persisted value is what login left behind.
    expect(resolveConfig({}, { PROXY_SMART_HOME: home.dir }).url).toBe(BETA)
  })
})
