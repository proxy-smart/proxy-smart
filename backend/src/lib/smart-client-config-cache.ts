// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isCimdClientId, resolveCimdRedirectUris } from '@proxy-smart/auth'
import { derivedHomeUrl, usableHomeUrl } from './client-home-url'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { parsePatientFacing, parseServerAccess, type ServerAccess } from '@/lib/smart-client-enrichment'
import { logger } from '@/lib/logger'
import { smartLogger } from '@/lib/smart-logger'
import { TtlCache } from '@/lib/cache/ttl-cache'
import { outboundUrlPolicy } from '@/lib/url-validation'
import { NO_APP_STATE, parseAppStateRegistration, type AppStateRegistration } from '@/lib/app-state/registration'

export interface SmartClientConfig {
  /** true: fhirUser resolves to Patient; false: Practitioner; undefined: no resolution. */
  patientFacing?: boolean
  /** RFC 6749 §3.1.2.3 allowlist; empty rejects every redirect_uri. */
  redirectUris: string[]
  /** Keycloak baseUrl, only when it is an absolute http(s) URL. */
  homeUrl?: string
  launchUrl?: string
  appState?: AppStateRegistration
  serverAccess?: ServerAccess
  adminManaged?: boolean
}

/** `unavailable` stays distinct from `absent`: an empty allowlist fails closed, so an outage would read as misconfiguration. */
export type ClientLookup =
  | { status: 'found'; config: SmartClientConfig }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: string }

/** How the cache reaches the client directory. Injectable so tests need no module mocking. */
export type ClientLookupSource = (clientId: string) => Promise<ClientLookup>

const DEFAULT_TTL_MS = 5 * 60 * 1000
/** Absence is usually "not created yet", so re-ask soon (admin create/recreate races). */
const ABSENT_TTL_MS = 30 * 1000

const EMPTY_CONFIG: SmartClientConfig = { redirectUris: [] }

/** Exported for tests: bun's `mock.module` is process-global, so a sibling suite may mock this module. */
export function createClientConfigCache(source: ClientLookupSource) {
  const cache = new TtlCache<SmartClientConfig>({ ttlMs: DEFAULT_TTL_MS })

  /** A failed lookup is NEVER cached — that would stretch one hiccup across the whole TTL. */
  async function lookup(clientId: string): Promise<ClientLookup> {
    const cached = cache.get(clientId)
    if (cached) {
      return { status: 'found', config: cached }
    }

    const result = await source(clientId)

    if (result.status === 'found') {
      cache.set(clientId, result.config)
    } else if (result.status === 'absent') {
      cache.set(clientId, EMPTY_CONFIG, ABSENT_TTL_MS)
    }

    return result
  }

  /** Lenient reader: see getSmartClientConfig. */
  async function getSmartClientConfig(clientId: string): Promise<SmartClientConfig> {
    const result = await lookup(clientId)
    return result.status === 'found' ? result.config : EMPTY_CONFIG
  }

  /** Strict reader: see getRegisteredRedirectUris. */
  async function getRegisteredRedirectUris(clientId: string): Promise<string[]> {
    if (!clientId) return []
    if (isCimdClientId(clientId)) {
      return resolveCimdRedirectUris(clientId, { logger: smartLogger, urlPolicy: outboundUrlPolicy })
    }
    const result = await lookup(clientId)
    if (result.status === 'unavailable') {
      throw new Error(`Cannot read registered redirect URIs for "${clientId}": ${result.reason}`)
    }
    return result.status === 'found' ? result.config.redirectUris : []
  }

  /** Where a client's users belong: its registered Home URL, else its redirect origin. Never throws. */
  async function getClientHomeUrl(clientId: string): Promise<string | undefined> {
    if (!clientId || isCimdClientId(clientId)) return undefined
    const result = await lookup(clientId)
    if (result.status !== 'found' || result.config.adminManaged !== true) return undefined
    const { homeUrl, launchUrl, redirectUris } = result.config
    return homeUrl ?? derivedHomeUrl({ launchUrl, redirectUris })
  }

  async function getAppStateRegistration(clientId: string): Promise<AppStateRegistration> {
    if (!clientId) return NO_APP_STATE
    const result = await lookup(clientId)
    if (result.status === 'unavailable') {
      throw new Error(`Cannot read the App State codes registered for "${clientId}": ${result.reason}`)
    }
    return result.status === 'found' ? result.config.appState ?? NO_APP_STATE : NO_APP_STATE
  }

  /** Strict reader: null for a client Keycloak does not hold; throws when Keycloak cannot be asked. */
  async function getServerAccess(clientId: string): Promise<ServerAccess | null> {
    if (!clientId) return null
    const result = await lookup(clientId)
    if (result.status === 'unavailable') {
      throw new Error(`Cannot read the FHIR servers "${clientId}" may reach: ${result.reason}`)
    }
    return result.status === 'found' ? result.config.serverAccess ?? null : null
  }

  return {
    getSmartClientConfig,
    getAppStateRegistration,
    getServerAccess,
    getRegisteredRedirectUris,
    getClientHomeUrl,
    invalidate: (clientId: string) => cache.delete(clientId),
    clear: () => cache.clear(),
  }
}

const defaultCache = createClientConfigCache(fetchClientConfig)

/** Lenient: an unreachable Keycloak must not block token issuance. Use getRegisteredRedirectUris for a trustworthy allowlist. */
export async function getSmartClientConfig(clientId: string): Promise<SmartClientConfig> {
  return defaultCache.getSmartClientConfig(clientId)
}

/**
 * RFC 6749 §3.1.2.3 allowlist from the CIMD document (https client_id) or Keycloak (DCR); empty fails closed.
 * Throws when Keycloak cannot be asked, so callers report an outage instead of a client misconfiguration.
 */
export async function getRegisteredRedirectUris(clientId: string): Promise<string[]> {
  return defaultCache.getRegisteredRedirectUris(clientId)
}

/** A client's home, for links that must send its users back (see getClientHomeUrl in the cache). */
export async function getClientHomeUrl(clientId: string): Promise<string | undefined> {
  return defaultCache.getClientHomeUrl(clientId)
}

/** The App State codes an app is registered for; throws when Keycloak cannot be asked. */
export async function getAppStateRegistration(clientId: string): Promise<AppStateRegistration> {
  return defaultCache.getAppStateRegistration(clientId)
}

/** The FHIR servers a client may reach; throws when Keycloak cannot be asked. */
export async function getClientServerAccess(clientId: string): Promise<ServerAccess | null> {
  return defaultCache.getServerAccess(clientId)
}

export function invalidateClientConfig(clientId: string): void {
  defaultCache.invalidate(clientId)
}

export function clearClientConfigCache(): void {
  defaultCache.clear()
}

async function fetchClientConfig(clientId: string): Promise<ClientLookup> {
  try {
    const admin = await getAdminClient()
    if (!admin) {
      return { status: 'unavailable', reason: 'Keycloak admin credentials are not configured' }
    }

    const clients = await admin.clients.find({ clientId, max: 1 })
    if (!clients || clients.length === 0) {
      logger.auth.warn('Keycloak has no such client', { clientId })
      return { status: 'absent' }
    }

    const redirectUris = Array.isArray(clients[0].redirectUris) ? clients[0].redirectUris : []
    const baseUrl = clients[0].baseUrl
    const homeUrl = usableHomeUrl(baseUrl)
    const launchUrl = clients[0].attributes?.['launch_url']
    const selfRegistered = String(clients[0].attributes?.['dynamic_registration']) === 'true'

    return {
      status: 'found',
      config: {
        patientFacing: parsePatientFacing(clients[0].attributes),
        redirectUris,
        homeUrl,
        ...(typeof launchUrl === 'string' && { launchUrl }),
        appState: parseAppStateRegistration(clients[0].attributes),
        serverAccess: parseServerAccess(clients[0].attributes),
        adminManaged: clients[0].enabled !== false && !selfRegistered,
      },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error'
    logger.auth.error('Cannot reach Keycloak to read client config', { clientId, error: reason })
    return { status: 'unavailable', reason }
  }
}
