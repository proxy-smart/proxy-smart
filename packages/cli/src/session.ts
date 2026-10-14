/**
 * Session + token lifecycle for the CLI.
 *
 * Responsibilities:
 *   - persist / read the cached token under ~/.proxy-smart/token.json
 *   - discover OAuth endpoints from the proxy's mirrored OIDC discovery
 *     document, so tokens are always minted through the proxy auth layer
 *     (audience binding, token enrichment, access control)
 *   - run the interactive device authorization flow (RFC 8628)
 *   - run the client_credentials flow (CI)
 *   - hand out a valid access token, transparently refreshing when possible
 *
 * The pure URL/body building lives in oauth.ts; this module owns the I/O.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  statSync,
} from 'fs'
import { join } from 'path'
import { type ResolvedConfig, tokenCachePath, clearTokenCache } from './config'
import {
  type AuthEndpoints,
  type DeviceAuthResponse,
  type TokenSet,
  asTokenError,
  clientCredentialsBody,
  deviceAuthBody,
  deviceTokenBody,
  endpointsFromMetadata,
  expiresAt,
  generatePkcePair,
  isTokenFresh,
  parseDeviceAuthResponse,
  parseOidcMetadata,
  parseTokenSet,
  proxyDiscoveryUrl,
  refreshTokenBody,
} from './oauth'
import { CliError } from './output'
import { isRecord, optionalNumber, optionalString } from './json'

/** Cached token record persisted to disk. */
export interface CachedToken {
  access_token: string
  refresh_token?: string
  /** Absolute expiry of the access token (epoch seconds). */
  expires_at?: number
  /** Absolute expiry of the refresh token (epoch seconds). */
  refresh_expires_at?: number
  scope?: string
  /** Client id the token was issued for (used to keep refresh consistent). */
  client_id: string
  /**
   * The proxy this token was minted against, normalised.
   *
   * A token is only valid for the deployment that issued it, and the resolved `--url` can change
   * between invocations (flag, then env, then persisted config, then localhost). Without this,
   * `login --url https://beta…` followed by a bare command silently presented a beta token to
   * whatever the default resolved to and returned an opaque 401. Worse, when the two DO both
   * accept the token — a shell with PROXY_SMART_URL pointing at production — the command would
   * succeed against the wrong environment. Recorded so {@link Session.getAccessToken} can refuse.
   *
   * Optional because a cache written by an older CLI has no such field; those are trusted as
   * before rather than forcing a re-login on upgrade.
   */
  url?: string
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' } as const

function parseCachedToken(value: unknown): CachedToken | undefined {
  if (!isRecord(value) || typeof value.access_token !== 'string' || typeof value.client_id !== 'string') {
    return undefined
  }
  return {
    access_token: value.access_token,
    refresh_token: optionalString(value.refresh_token),
    expires_at: optionalNumber(value.expires_at),
    refresh_expires_at: optionalNumber(value.refresh_expires_at),
    scope: optionalString(value.scope),
    client_id: value.client_id,
    url: optionalString(value.url),
  }
}

/**
 * Read the cached token from disk, tolerating a missing/partial/corrupt file.
 *
 * A concurrent writer (see `writeCachedToken`) renames a fully-written temp file
 * over `token.json`, so a reader should never observe a torn file. As defense in
 * depth we still treat any unreadable or non-JSON content as "no token" and
 * return `undefined` rather than throwing, so a single bad read never crashes a
 * command or forces a re-login when a valid token may simply be mid-rotation.
 */
export function readCachedToken(homeDir: string): CachedToken | undefined {
  const file = tokenCachePath(homeDir)
  if (!existsSync(file)) return undefined
  try {
    return parseCachedToken(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return undefined
  }
}

/**
 * Persist a token to disk with owner-only permissions, atomically.
 *
 * Several `proxy-smart` invocations can run back-to-back or concurrently and
 * each may read / refresh / write the token cache. A plain `writeFileSync` to
 * the real path is not atomic: a reader in another process can observe a
 * half-written file and treat it as corrupt, which surfaces as a spurious
 * `Not authenticated` / 401 and forces a re-login. To avoid that we write the
 * full payload to a unique temp file in the same directory (so `rename` stays on
 * one filesystem and is therefore atomic) and then `renameSync` it over the real
 * path. Readers only ever see the old file or the new file, never a torn one.
 */
export function writeCachedToken(homeDir: string, token: CachedToken): void {
  mkdirSync(homeDir, { recursive: true })
  const finalPath = tokenCachePath(homeDir)
  // Unique per write: pid keeps it distinct across processes, the random/time
  // suffix across rapid writes within one process. Both are fine to use in a
  // normal CLI runtime.
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`
  try {
    writeFileSync(tmpPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmpPath, finalPath)
  } catch (err) {
    // Best-effort cleanup so we never leak a temp file if the rename failed.
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // ignore cleanup failure
    }
    throw err
  }
}

/** Map a fresh token response onto a persisted CachedToken. */
export function toCachedToken(
  tokens: TokenSet,
  clientId: string,
  now = Math.floor(Date.now() / 1000),
  url?: string,
): CachedToken {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt(tokens.expires_in, now),
    refresh_expires_at: expiresAt(tokens.refresh_expires_in, now),
    scope: tokens.scope,
    client_id: clientId,
    ...(url === undefined ? {} : { url }),
  }
}

/**
 * The cached token is for a DIFFERENT deployment than this invocation targets.
 *
 * Returned as a message rather than thrown here so the caller decides; the wording names both
 * URLs because the whole failure mode is not noticing that they differ.
 */
export function deploymentMismatch(cached: CachedToken, targetUrl: string): string | undefined {
  if (!cached.url || cached.url === targetUrl) return undefined
  return (
    `The cached token was issued by ${cached.url}, but this command targets ${targetUrl}.\n` +
    `A token is only valid for the deployment that issued it. Either:\n` +
    `  proxy-smart --url ${cached.url} <command>          # use the deployment you logged in to\n` +
    `  proxy-smart login --url ${targetUrl}               # log in to the one you are targeting`
  )
}

/** Callback used to report device-flow progress to the user. */
export type DevicePrompt = (info: DeviceAuthResponse) => void

/** Delay helper injected into the session (real delay by default). */
export type SleepImpl = (ms: number) => Promise<void>

/** Clock helper injected into the session (real wall clock by default). */
export type NowImpl = () => number

/**
 * Manages OAuth endpoints + token acquisition for a single CLI invocation.
 * Discovery results are memoized for the lifetime of the instance.
 *
 * `fetchImpl`, `sleepImpl`, and `nowImpl` are injectable seams: production code
 * uses the real `fetch`, a `setTimeout`-based delay, and the wall clock, while
 * tests can drive the device-poll loop offline without sleeping for real time.
 */
export class Session {
  private endpoints?: AuthEndpoints

  constructor(
    private readonly config: ResolvedConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: SleepImpl = sleep,
    private readonly nowImpl: NowImpl = Date.now,
  ) {}

  /**
   * Resolve OAuth endpoints by discovering them from the proxy's mirrored OIDC
   * document, so every grant goes through the proxy auth layer (token =
   * `${proxy}/auth/token`, device = the proxy's `/auth/device`).
   *
   * There is deliberately no way to point this at Keycloak instead. The proxy
   * rewrites these endpoints to itself and validates the audience fail-closed,
   * so a token minted straight from Keycloak is rejected on the very next
   * call — an escape hatch here only produces a confusing 401.
   */
  async resolveEndpoints(): Promise<AuthEndpoints> {
    if (this.endpoints) return this.endpoints

    const url = proxyDiscoveryUrl(this.config.url)
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new CliError(
        `Failed to discover OAuth endpoints from the proxy at ${url} (HTTP ${res.status}). ` +
          `Check ${'PROXY_SMART_URL'} (or --url) points at a running proxy.`,
      )
    }
    const meta = parseOidcMetadata(await res.json())
    this.endpoints = endpointsFromMetadata(meta)
    return this.endpoints
  }

  /**
   * Run the interactive device authorization flow and persist the result.
   * `prompt` is invoked once with the verification URL + user code.
   */
  async loginWithDeviceFlow(prompt: DevicePrompt): Promise<CachedToken> {
    const endpoints = await this.resolveEndpoints()
    if (!endpoints.deviceAuthorizationEndpoint) {
      throw new CliError(
        'The authorization server does not advertise a device authorization endpoint. ' +
          'Use client-credentials auth instead (set PROXY_SMART_CLIENT_SECRET).',
      )
    }

    // Always send PKCE (RFC 7636, S256) for the device flow: it is the public
    // client best practice and is required by clients such as `admin-ui` that
    // Keycloak configures with `pkce.code.challenge.method: S256`. One pair is
    // generated per login; the challenge goes in the authorization request and
    // the same verifier is replayed on every token poll.
    const pkce = generatePkcePair()

    const authRes = await this.fetchImpl(endpoints.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: deviceAuthBody(this.config.clientId, this.config.scope, this.config.clientSecret, pkce.challenge),
    })
    if (!authRes.ok) {
      throw new CliError(`Device authorization request failed (HTTP ${authRes.status}): ${await safeText(authRes)}`)
    }
    const device = parseDeviceAuthResponse(await authRes.json())
    prompt(device)

    const tokens = await this.pollForDeviceToken(endpoints.tokenEndpoint, device, pkce.verifier)
    const cached = toCachedToken(tokens, this.config.clientId, undefined, this.config.url)
    writeCachedToken(this.config.homeDir, cached)
    return cached
  }

  /** Run a client_credentials grant and persist the result. */
  async loginWithClientCredentials(): Promise<CachedToken> {
    if (!this.config.clientSecret) {
      throw new CliError('client_credentials login requires a client secret (PROXY_SMART_CLIENT_SECRET or --client-secret).')
    }
    const endpoints = await this.resolveEndpoints()
    const tokens = await this.exchange(
      endpoints.tokenEndpoint,
      clientCredentialsBody(this.config.clientId, this.config.clientSecret, this.config.scope),
    )
    const cached = toCachedToken(tokens, this.config.clientId, undefined, this.config.url)
    writeCachedToken(this.config.homeDir, cached)
    return cached
  }

  /**
   * Return a valid access token for API calls.
   *
   * Strategy:
   *   1. cached, still-fresh access token → use it
   *   2. cached refresh token still valid → refresh transparently
   *   3. client secret available → run client_credentials (CI ergonomics)
   *   4. otherwise → tell the user to `login`
   */
  async getAccessToken(): Promise<string> {
    const cached = readCachedToken(this.config.homeDir)

    // Refuse a token minted elsewhere BEFORE any network call. Checked first because the
    // dangerous case is the one that would otherwise succeed: a token both deployments
    // accept, applied to the wrong one.
    if (cached) {
      const mismatch = deploymentMismatch(cached, this.config.url)
      if (mismatch) throw new CliError(mismatch)
    }

    if (cached && isTokenFresh(cached.expires_at)) {
      return cached.access_token
    }

    if (cached?.refresh_token && isTokenFresh(cached.refresh_expires_at)) {
      const refreshed = await this.refreshSingleFlight(cached)
      if (refreshed) return refreshed
    }

    if (this.config.clientSecret) {
      const cc = await this.loginWithClientCredentials()
      return cc.access_token
    }

    throw new CliError('Not authenticated. Run `proxy-smart login` first.')
  }

  /**
   * Refresh the access token, serializing across processes so concurrent
   * invocations do not both refresh and clobber each other's freshly-rotated
   * token (which, with refresh-token rotation, can invalidate the survivor and
   * force a re-login).
   *
   * Best-effort single-flight:
   *   - Acquire a short-lived exclusive lock file next to the cache.
   *   - If we win the lock, refresh, persist atomically, and return the token.
   *   - If another process holds the lock, wait briefly and re-read the cache;
   *     that process has very likely just written a fresh token, so we reuse it
   *     and skip a redundant refresh. If the cache is still not fresh after the
   *     wait, fall back to refreshing ourselves.
   *
   * The lock is always released in `finally`, is bounded by a short wait, and is
   * broken if stale, so it can never deadlock. On any refresh error we return
   * `undefined` so `getAccessToken` falls through to its other strategies.
   */
  private async refreshSingleFlight(cached: CachedToken): Promise<string | undefined> {
    const lockFd = tryAcquireLock(this.config.homeDir)

    if (lockFd === undefined) {
      // Another process is refreshing. Wait briefly, then prefer its result.
      await this.sleepImpl(250)
      const reread = readCachedToken(this.config.homeDir)
      if (reread && isTokenFresh(reread.expires_at)) return reread.access_token
      // The other process did not (yet) produce a fresh token; fall through and
      // refresh from the freshest refresh_token we can see.
      const source = reread?.refresh_token && isTokenFresh(reread.refresh_expires_at) ? reread : cached
      return this.doRefresh(source)
    }

    try {
      // We hold the lock. Re-read under the lock in case another process
      // refreshed between our first read and acquiring the lock.
      const reread = readCachedToken(this.config.homeDir)
      if (reread && isTokenFresh(reread.expires_at)) return reread.access_token
      const source = reread?.refresh_token && isTokenFresh(reread.refresh_expires_at) ? reread : cached
      return this.doRefresh(source)
    } finally {
      releaseLock(this.config.homeDir, lockFd)
    }
  }

  /**
   * Perform a single refresh-token exchange and persist the result atomically.
   * Returns the new access token, or `undefined` if the refresh failed (the
   * caller then falls through to its remaining auth strategies).
   */
  private async doRefresh(cached: CachedToken): Promise<string | undefined> {
    if (!cached.refresh_token) return undefined
    try {
      const endpoints = await this.resolveEndpoints()
      const tokens = await this.exchange(
        endpoints.tokenEndpoint,
        refreshTokenBody(cached.client_id, cached.refresh_token, this.config.clientSecret),
      )
      const refreshed = toCachedToken(tokens, cached.client_id)
      writeCachedToken(this.config.homeDir, refreshed)
      return refreshed.access_token
    } catch {
      // fall through to other strategies on refresh failure
      return undefined
    }
  }

  /** Forget any cached token. */
  logout(): void {
    clearTokenCache(this.config.homeDir)
  }

  /**
   * Poll the token endpoint until the user approves the device, or it expires.
   * `codeVerifier` is the PKCE verifier (RFC 7636) replayed on every poll so the
   * server can match it against the challenge sent in the authorization request.
   */
  private async pollForDeviceToken(
    tokenEndpoint: string,
    device: DeviceAuthResponse,
    codeVerifier: string,
  ): Promise<TokenSet> {
    const deadline = this.nowImpl() + device.expires_in * 1000
    let intervalMs = (device.interval ?? 5) * 1000

    while (this.nowImpl() < deadline) {
      await this.sleepImpl(intervalMs)
      const res = await this.fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: deviceTokenBody(this.config.clientId, device.device_code, this.config.clientSecret, codeVerifier),
      })
      const payload: unknown = await res.json()

      if (res.ok) return parseTokenSet(payload)

      const err = asTokenError(payload)
      if (err?.error === 'authorization_pending') continue
      if (err?.error === 'slow_down') {
        intervalMs += 5000
        continue
      }
      throw new CliError(`Device login failed: ${err?.error_description ?? err?.error ?? `HTTP ${res.status}`}`)
    }
    throw new CliError('Device login timed out before authorization was granted.')
  }

  /** POST a form body to a token endpoint and parse the token response. */
  private async exchange(tokenEndpoint: string, body: string): Promise<TokenSet> {
    const res = await this.fetchImpl(tokenEndpoint, { method: 'POST', headers: FORM_HEADERS, body })
    const payload: unknown = await res.json()
    if (!res.ok) {
      const err = asTokenError(payload)
      throw new CliError(`Token request failed: ${err?.error_description ?? err?.error ?? `HTTP ${res.status}`}`)
    }
    return parseTokenSet(payload)
  }
}

/** Read a response body as text, never throwing. */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim()
  } catch {
    return ''
  }
}

/** Promise-based delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Path to the cross-process refresh lock that guards token rotation. */
function tokenLockPath(homeDir: string): string {
  return join(homeDir, 'token.lock')
}

/**
 * A lock is considered stale (and may be broken) once it is older than this.
 * A real refresh is a single token-endpoint round-trip, so a few seconds is a
 * generous ceiling; anything older almost certainly belongs to a process that
 * died before releasing the lock.
 */
const STALE_LOCK_MS = 5_000

/**
 * Try to acquire the cross-process refresh lock with an exclusive-create open
 * (`wx`). Returns the open file descriptor on success, or `undefined` if the
 * lock is currently held by another (live) process. A lock file older than
 * `STALE_LOCK_MS` is treated as abandoned and broken so we can never deadlock
 * on a crashed process.
 */
function tryAcquireLock(homeDir: string): number | undefined {
  mkdirSync(homeDir, { recursive: true })
  const lockPath = tokenLockPath(homeDir)
  try {
    return openSync(lockPath, 'wx', 0o600)
  } catch {
    // Lock exists. Break it if it is stale, then retry once.
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs
      if (age > STALE_LOCK_MS) {
        rmSync(lockPath, { force: true })
        return openSync(lockPath, 'wx', 0o600)
      }
    } catch {
      // The lock vanished or could not be inspected; retry once below.
      try {
        return openSync(lockPath, 'wx', 0o600)
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

/** Release the refresh lock: close the descriptor and remove the lock file. */
function releaseLock(homeDir: string, fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // ignore
  }
  try {
    rmSync(tokenLockPath(homeDir), { force: true })
  } catch {
    // ignore
  }
}
