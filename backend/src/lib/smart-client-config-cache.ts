// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SMART Client Config Cache
 *
 * Lightweight in-memory cache of per-client configuration relevant to
 * token-time decisions (e.g., patientFacing flag for fhirUser resolution).
 *
 * Populated lazily from Keycloak client attributes on first request.
 * Avoids hitting Keycloak admin API on every token exchange.
 */

import { isCimdClientId, resolveCimdRedirectUris } from '@proxy-smart/auth'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { parsePatientFacing } from '@/lib/smart-client-enrichment'
import { logger } from '@/lib/logger'
import { smartLogger } from '@/lib/smart-logger'
import { TtlCache } from '@/lib/cache/ttl-cache'

export interface SmartClientConfig {
  /** If true → resolve fhirUser to Patient. If false → Practitioner. If undefined → no resolution (backward compat). */
  patientFacing?: boolean
  /**
   * The redirect URIs registered for this client in Keycloak.
   * Used to validate the authorize/callback redirect_uri (RFC 6749 §3.1.2.3)
   * so the proxy never forwards an authorization code to an unregistered URI.
   * Empty array → no registered URIs (or client unknown) → reject all.
   */
  redirectUris: string[]
}

/**
 * The three distinguishable outcomes of asking Keycloak about a client.
 *
 * `unavailable` exists because collapsing it into `absent` is what turns a
 * Keycloak hiccup into "this client has no registered redirect URIs", and the
 * redirect_uri check is fail-closed on an empty allowlist — so an infrastructure
 * failure came out as a client-configuration error and rejected every launch.
 */
export type ClientLookup =
  | { status: 'found'; config: SmartClientConfig }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: string }

/** How the cache reaches the client directory. Injectable so tests need no module mocking. */
export type ClientLookupSource = (clientId: string) => Promise<ClientLookup>

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
/** Absence is usually "not created yet", so re-ask soon (admin create/recreate races). */
const ABSENT_TTL_MS = 30 * 1000

const EMPTY_CONFIG: SmartClientConfig = { redirectUris: [] }

/**
 * Build a caching client-config reader over a lookup source.
 *
 * Exported so tests can drive the caching and failure semantics through a fake
 * source. `mock.module` is process-global in bun, so a sibling test that mocks
 * this whole module would otherwise make these paths untestable.
 */
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
      return resolveCimdRedirectUris(clientId, { logger: smartLogger })
    }
    const result = await lookup(clientId)
    if (result.status === 'unavailable') {
      throw new Error(`Cannot read registered redirect URIs for "${clientId}": ${result.reason}`)
    }
    return result.status === 'found' ? result.config.redirectUris : []
  }

  return {
    getSmartClientConfig,
    getRegisteredRedirectUris,
    invalidate: (clientId: string) => cache.delete(clientId),
    clear: () => cache.clear(),
  }
}

const defaultCache = createClientConfigCache(fetchClientConfig)

/**
 * Get the SMART client config for a given clientId.
 *
 * Lenient by design: token-time enrichment only reads `patientFacing`, and an
 * unreachable Keycloak must not stop a token being issued. Callers that need a
 * trustworthy allowlist use `getRegisteredRedirectUris`, which fails loudly.
 */
export async function getSmartClientConfig(clientId: string): Promise<SmartClientConfig> {
  return defaultCache.getSmartClientConfig(clientId)
}

/**
 * Get the redirect URIs registered for a client (RFC 6749 §3.1.2.3).
 *
 * TWO SOURCES, because a client can register two ways and only one of them puts
 * anything in Keycloak:
 *
 *   CIMD  — `client_id` is an https URL and the client publishes its own
 *           `redirect_uris` there. Keycloak holds no record of the client, so the
 *           document is the only source of truth. This is the RECOMMENDED
 *           registration method as of MCP 2026-07-28.
 *   DCR   — `client_id` is a Keycloak client id; ask Keycloak. Deprecated by the
 *           same spec revision, still the path SMART apps use.
 *
 * Routing both through one function is what lets the authorize interceptor stay
 * uniform: it asks "what may this client redirect to" and does not care how the
 * client registered. An earlier attempt special-cased CIMD at the interception
 * site instead, which silently delegated an authorization-server MUST to Keycloak.
 *
 * Returns an empty array for an unknown client or an unverifiable metadata
 * document — the caller treats an empty allowlist as "reject every redirect_uri"
 * (fail-closed).
 *
 * THROWS when Keycloak could not be asked at all. That is not the same as "this
 * client has no registered URIs", and the callers act on the difference: both
 * the authorize interceptor and the callback handler already answer a thrown
 * lookup with `Unable to validate redirect_uri` and an error-level log, instead
 * of blaming the client's configuration for an outage on our side.
 *
 * Wired into `@proxy-smart/auth`'s `getRegisteredRedirectUris` dependency.
 */
export async function getRegisteredRedirectUris(clientId: string): Promise<string[]> {
  return defaultCache.getRegisteredRedirectUris(clientId)
}

/**
 * Invalidate cache for a specific client (call after admin updates).
 */
export function invalidateClientConfig(clientId: string): void {
  defaultCache.invalidate(clientId)
}

/**
 * Clear the entire client config cache.
 */
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

    return {
      status: 'found',
      config: { patientFacing: parsePatientFacing(clients[0].attributes), redirectUris },
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error'
    logger.auth.error('Cannot reach Keycloak to read client config', { clientId, error: reason })
    return { status: 'unavailable', reason }
  }
}
