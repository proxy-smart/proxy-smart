import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_PROXY_URL,
  DEFAULT_SCOPE,
  ENV,
  clearTokenCache,
  configPath,
  readPersistedConfig,
  resolveConfig,
  resolveHomeDir,
  tokenCachePath,
  writePersistedConfig,
} from '../src/config'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'proxy-smart-cli-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Minimal env stub: only the CLI-relevant vars, pinned home dir. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { [ENV.home]: home, ...extra }
}

describe('path helpers', () => {
  it('resolves home dir from the env override', () => {
    expect(resolveHomeDir(env())).toBe(home)
  })

  it('derives config + token cache paths under the home dir', () => {
    expect(configPath(home)).toBe(join(home, 'config.json'))
    expect(tokenCachePath(home)).toBe(join(home, 'token.json'))
  })
})

describe('persisted config round-trip', () => {
  it('returns an empty object when no config file exists', () => {
    expect(readPersistedConfig(home)).toEqual({})
  })

  it('writes and reads back a config file', () => {
    writePersistedConfig(home, { url: 'https://proxy', clientId: 'cli' })
    expect(readPersistedConfig(home)).toEqual({ url: 'https://proxy', clientId: 'cli' })
  })

  it('tolerates a corrupt config file', () => {
    writePersistedConfig(home, { url: 'https://proxy' })
    // Overwrite with garbage.
    writeFileSync(configPath(home), 'not json')
    expect(readPersistedConfig(home)).toEqual({})
  })
})

describe('resolveConfig precedence', () => {
  it('falls back to built-in defaults', () => {
    const config = resolveConfig({}, env())
    expect(config.url).toBe(DEFAULT_PROXY_URL)
    expect(config.clientId).toBe(DEFAULT_CLIENT_ID)
    expect(config.scope).toBe(DEFAULT_SCOPE)
    expect(config.clientSecret).toBeUndefined()
  })

  it('prefers env over the config file', () => {
    writePersistedConfig(home, { url: 'https://from-file', clientId: 'file-client' })
    const config = resolveConfig({}, env({ [ENV.url]: 'https://from-env' }))
    expect(config.url).toBe('https://from-env')
    // clientId still comes from the file since env did not set it.
    expect(config.clientId).toBe('file-client')
  })

  it('prefers explicit flags over env and file', () => {
    writePersistedConfig(home, { url: 'https://from-file' })
    const config = resolveConfig(
      { url: 'https://from-flag/', clientSecret: 'flag-secret' },
      env({ [ENV.url]: 'https://from-env' }),
    )
    expect(config.url).toBe('https://from-flag')
    expect(config.clientSecret).toBe('flag-secret')
  })

  it('normalizes the proxy URL', () => {
    expect(resolveConfig({ url: 'https://proxy/' }, env()).url).toBe('https://proxy')
  })

  /**
   * The Keycloak-direct escape hatch is gone. A stale config file or a lingering
   * PROXY_SMART_REALM in someone's shell must not resurrect it, so the resolved
   * config carries no Keycloak settings at all.
   */
  it('ignores leftover Keycloak settings from env and the config file', () => {
    writePersistedConfig(home, {
      url: 'https://proxy',
      ...({ realm: 'app', keycloakUrl: 'https://kc', directKeycloak: true } as object),
    })
    const config = resolveConfig(
      {},
      env({ PROXY_SMART_REALM: 'app', PROXY_SMART_KEYCLOAK_URL: 'https://kc', PROXY_SMART_DIRECT_KEYCLOAK: '1' }),
    ) as Record<string, unknown>

    expect(config.url).toBe('https://proxy')
    expect(config.realm).toBeUndefined()
    expect(config.keycloakUrl).toBeUndefined()
    expect(config.directKeycloak).toBeUndefined()
  })

  it('no longer recognizes the Keycloak env vars', () => {
    expect(Object.values(ENV)).not.toContain('PROXY_SMART_REALM')
    expect(Object.values(ENV)).not.toContain('PROXY_SMART_KEYCLOAK_URL')
    expect(Object.values(ENV)).not.toContain('PROXY_SMART_DIRECT_KEYCLOAK')
  })
})

describe('clearTokenCache', () => {
  it('removes the cached token file and is a no-op when absent', () => {
    const file = tokenCachePath(home)
    writeFileSync(file, '{}')
    expect(existsSync(file)).toBe(true)
    clearTokenCache(home)
    expect(existsSync(file)).toBe(false)
    // Second call must not throw.
    clearTokenCache(home)
  })
})
