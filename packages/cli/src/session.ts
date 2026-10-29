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

export interface CachedToken {
  access_token: string
  refresh_token?: string
  /** Epoch seconds. */
  expires_at?: number
  /** Epoch seconds. */
  refresh_expires_at?: number
  scope?: string
  client_id: string
  /** Normalised proxy URL that minted the token; absent in caches from older CLIs, which stay trusted. */
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

/** Unreadable or corrupt content counts as "no token" rather than throwing. */
export function readCachedToken(homeDir: string): CachedToken | undefined {
  const file = tokenCachePath(homeDir)
  if (!existsSync(file)) return undefined
  try {
    return parseCachedToken(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return undefined
  }
}

/** Owner-only, atomic write: temp file in the same dir, then rename, so concurrent readers never see a torn file. */
export function writeCachedToken(homeDir: string, token: CachedToken): void {
  mkdirSync(homeDir, { recursive: true })
  const finalPath = tokenCachePath(homeDir)
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`
  try {
    writeFileSync(tmpPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmpPath, finalPath)
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // ignore cleanup failure
    }
    throw err
  }
}

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
    // Keycloak before 26.8 answered 0 for an offline token with no exp, which means no deadline.
    refresh_expires_at: tokens.refresh_expires_in === 0 ? undefined : expiresAt(tokens.refresh_expires_in, now),
    scope: tokens.scope,
    client_id: clientId,
    ...(url === undefined ? {} : { url }),
  }
}

/** Message when the cached token was minted by a different deployment than the target. */
export function deploymentMismatch(cached: CachedToken, targetUrl: string): string | undefined {
  if (!cached.url || cached.url === targetUrl) return undefined
  return (
    `The cached token was issued by ${cached.url}, but this command targets ${targetUrl}.\n` +
    `A token is only valid for the deployment that issued it. Either:\n` +
    `  proxy-smart --url ${cached.url} <command>          # use the deployment you logged in to\n` +
    `  proxy-smart login --url ${targetUrl}               # log in to the one you are targeting`
  )
}

export type DevicePrompt = (info: DeviceAuthResponse) => void

export type SleepImpl = (ms: number) => Promise<void>

export type NowImpl = () => number

export class Session {
  private endpoints?: AuthEndpoints

  constructor(
    private readonly config: ResolvedConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: SleepImpl = sleep,
    private readonly nowImpl: NowImpl = Date.now,
  ) {}

  /** Discovered from the proxy only: it validates audience fail-closed, so a Keycloak-minted token would 401. */
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

  async loginWithDeviceFlow(prompt: DevicePrompt): Promise<CachedToken> {
    const endpoints = await this.resolveEndpoints()
    if (!endpoints.deviceAuthorizationEndpoint) {
      throw new CliError(
        'The authorization server does not advertise a device authorization endpoint. ' +
          'Use client-credentials auth instead (set PROXY_SMART_CLIENT_SECRET).',
      )
    }

    // PKCE S256 is required by clients like admin-ui (Keycloak pkce.code.challenge.method).
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

  async getAccessToken(): Promise<string> {
    const cached = readCachedToken(this.config.homeDir)

    // Before any network call: a token both deployments accept would otherwise hit the wrong one.
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

  /** Cross-process single-flight: with refresh-token rotation, two concurrent refreshes can invalidate the survivor. */
  private async refreshSingleFlight(cached: CachedToken): Promise<string | undefined> {
    const lockFd = tryAcquireLock(this.config.homeDir)

    if (lockFd === undefined) {
      await this.sleepImpl(250)
      const reread = readCachedToken(this.config.homeDir)
      if (reread && isTokenFresh(reread.expires_at)) return reread.access_token
      const source = reread?.refresh_token && isTokenFresh(reread.refresh_expires_at) ? reread : cached
      return this.doRefresh(source)
    }

    try {
      const reread = readCachedToken(this.config.homeDir)
      if (reread && isTokenFresh(reread.expires_at)) return reread.access_token
      const source = reread?.refresh_token && isTokenFresh(reread.refresh_expires_at) ? reread : cached
      return this.doRefresh(source)
    } finally {
      releaseLock(this.config.homeDir, lockFd)
    }
  }

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
      return undefined
    }
  }

  logout(): void {
    clearTokenCache(this.config.homeDir)
  }

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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim()
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tokenLockPath(homeDir: string): string {
  return join(homeDir, 'token.lock')
}

/** A refresh is one round-trip; an older lock belongs to a dead process and is broken. */
const STALE_LOCK_MS = 5_000

/** Exclusive-create lock; returns the fd, or undefined while a live process holds it. */
function tryAcquireLock(homeDir: string): number | undefined {
  mkdirSync(homeDir, { recursive: true })
  const lockPath = tokenLockPath(homeDir)
  try {
    return openSync(lockPath, 'wx', 0o600)
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs
      if (age > STALE_LOCK_MS) {
        rmSync(lockPath, { force: true })
        return openSync(lockPath, 'wx', 0o600)
      }
    } catch {
      try {
        return openSync(lockPath, 'wx', 0o600)
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

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
