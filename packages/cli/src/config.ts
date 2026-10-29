import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { isRecord, optionalString } from './json'

export const DEFAULT_PROXY_URL = 'http://localhost:8445'

/** validateAdminToken accepts azp=admin-ui, and every realm export enables the RFC 8628 device grant on it. */
export const DEFAULT_CLIENT_ID = 'admin-ui'

export const DEFAULT_SCOPE = 'openid profile email'

export const ENV = {
  url: 'PROXY_SMART_URL',
  clientId: 'PROXY_SMART_CLIENT_ID',
  clientSecret: 'PROXY_SMART_CLIENT_SECRET',
  scope: 'PROXY_SMART_SCOPE',
  home: 'PROXY_SMART_HOME',
} as const

export interface PersistedConfig {
  url?: string
  clientId?: string
  scope?: string
}

export interface ConfigOverrides {
  url?: string
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface ResolvedConfig {
  /** No trailing slash. */
  url: string
  clientId: string
  clientSecret?: string
  scope: string
  homeDir: string
}

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV.home] ?? join(homedir(), '.proxy-smart')
}

export function configPath(homeDir: string): string {
  return join(homeDir, 'config.json')
}

export function tokenCachePath(homeDir: string): string {
  return join(homeDir, 'token.json')
}

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

export function writePersistedConfig(homeDir: string, config: PersistedConfig): void {
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(configPath(homeDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/** Precedence: flags, then PROXY_SMART_* env, then ~/.proxy-smart/config.json, then defaults. */
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

export function clearTokenCache(homeDir: string): void {
  const file = tokenCachePath(homeDir)
  if (existsSync(file)) rmSync(file)
}
