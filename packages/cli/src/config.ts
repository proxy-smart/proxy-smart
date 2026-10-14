/**
 * Centralized configuration for the proxy-smart CLI.
 *
 * Resolution order (highest precedence first):
 *   1. explicit command-line flags
 *   2. environment variables (PROXY_SMART_*)
 *   3. persisted config file at ~/.proxy-smart/config.json
 *   4. built-in defaults
 *
 * Keeping this in one module means every command resolves settings the same
 * way and there is a single source of truth for the on-disk layout.
 */
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { isRecord, optionalString } from './json'

/** Built-in fallback for the proxy base URL when nothing else is provided. */
export const DEFAULT_PROXY_URL = 'http://localhost:8445'

/**
 * Default OAuth client used for the interactive (device) login flow.
 *
 * Reuses the realm's existing public `admin-ui` client (the one the admin
 * webapp signs in with) rather than minting a dedicated CLI client. The backend
 * `validateAdminToken` already accepts tokens whose `azp` is `admin-ui`, so a
 * device-flow token (azp=admin-ui + realm role `admin`) passes the admin API
 * with no extra audience config. The `admin-ui` client has the RFC 8628 device
 * authorization grant enabled in every realm export.
 */
export const DEFAULT_CLIENT_ID = 'admin-ui'

/** Default scopes requested for admin sessions. */
export const DEFAULT_SCOPE = 'openid profile email'

/** Environment variable names recognized by the CLI (single source of truth). */
export const ENV = {
  url: 'PROXY_SMART_URL',
  clientId: 'PROXY_SMART_CLIENT_ID',
  clientSecret: 'PROXY_SMART_CLIENT_SECRET',
  scope: 'PROXY_SMART_SCOPE',
  home: 'PROXY_SMART_HOME',
} as const

/** Shape of the persisted ~/.proxy-smart/config.json file. */
export interface PersistedConfig {
  url?: string
  clientId?: string
  scope?: string
}

/** Per-invocation overrides parsed from global flags. */
export interface ConfigOverrides {
  url?: string
  clientId?: string
  clientSecret?: string
  scope?: string
}

/** Fully resolved configuration consumed by the rest of the CLI. */
export interface ResolvedConfig {
  /** Proxy base URL, no trailing slash. The proxy is the authorization server. */
  url: string
  /** OAuth client id. */
  clientId: string
  /** OAuth client secret (only set for client_credentials / confidential flows). */
  clientSecret?: string
  /** Requested scopes. */
  scope: string
  /** Directory that holds config + token cache. */
  homeDir: string
}

/** Strip a single trailing slash so URL joins stay predictable. */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Absolute path to the CLI home directory (~/.proxy-smart by default). */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV.home] ?? join(homedir(), '.proxy-smart')
}

/** Path to the persisted config file. */
export function configPath(homeDir: string): string {
  return join(homeDir, 'config.json')
}

/** Path to the cached token file. */
export function tokenCachePath(homeDir: string): string {
  return join(homeDir, 'token.json')
}

/** Read and parse the persisted config file, tolerating a missing/corrupt file. */
export function readPersistedConfig(homeDir: string): PersistedConfig {
  const file = configPath(homeDir)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!isRecord(parsed)) return {}
    const url = optionalString(parsed.url)
    const clientId = optionalString(parsed.clientId)
    const scope = optionalString(parsed.scope)
    return { ...(url && { url }), ...(clientId && { clientId }), ...(scope && { scope }) }
  } catch {
    return {}
  }
}

/** Persist config to disk, creating the home directory if needed. */
export function writePersistedConfig(homeDir: string, config: PersistedConfig): void {
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(configPath(homeDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Resolve the effective configuration from flags, env, and the config file.
 * Pure aside from reading the (optionally injected) env and config file —
 * which makes it straightforward to unit test.
 */
export function resolveConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const homeDir = resolveHomeDir(env)
  const persisted = readPersistedConfig(homeDir)

  return {
    url: normalizeUrl(overrides.url ?? env[ENV.url] ?? persisted.url ?? DEFAULT_PROXY_URL),
    clientId: overrides.clientId ?? env[ENV.clientId] ?? persisted.clientId ?? DEFAULT_CLIENT_ID,
    clientSecret: overrides.clientSecret ?? env[ENV.clientSecret],
    scope: overrides.scope ?? env[ENV.scope] ?? persisted.scope ?? DEFAULT_SCOPE,
    homeDir,
  }
}

/** Remove the cached token, if present. */
export function clearTokenCache(homeDir: string): void {
  const file = tokenCachePath(homeDir)
  if (existsSync(file)) rmSync(file)
}
