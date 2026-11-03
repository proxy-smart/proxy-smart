// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Dynamic CORS origins cache.
 * 
 * Derives allowed origins from registered SMART app webOrigins in Keycloak,
 * merged with static CORS_ORIGINS from env. Refreshed on startup and whenever
 * SMART apps are created/updated via admin API.
 */
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { errorResponseStatus } from '@/lib/type-guards'
import { getAdminClient } from '@/lib/kc-admin-factory'

/** Cached set of allowed origins, each matched exactly */
let cachedOrigins: string[] = []
let lastRefresh = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Get all allowed CORS origins (static env + dynamic from Keycloak clients).
 * Uses a cached value that refreshes every 5 minutes.
 */
export function getAllowedOrigins(): string[] {
  return cachedOrigins.length > 0 ? cachedOrigins : config.cors.origins
}

/** scheme://host[:port] with a default port dropped and the host lowercased, or null for anything else. */
function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/** An exact origin match: a look-alike such as `https://allowed.example.evil` must not pass. */
export function isOriginAllowed(origin: string): boolean {
  const candidate = normalizeOrigin(origin)
  if (!candidate) return false
  return getAllowedOrigins().some(o => normalizeOrigin(o) === candidate)
}

const PUBLIC_READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Documents a client reads before it holds a token. SMART App Launch requires CORS from any origin
 * for the discovery endpoints, and User-access Brands for every GET of the Brand Bundle.
 */
export function isPublicDiscoveryPath(path: string, method: string): boolean {
  if (!PUBLIC_READ_METHODS.has(method.toUpperCase())) return false
  const fhirBase = `/${config.name}/[^/]+/[^/]+/`
  return [
    new RegExp(`^${fhirBase}(\\.well-known/smart-configuration|metadata)$`),
    /^\/branding\.json$/,
    /^\/(auth\/)?\.well-known\/[^/]+(\/.*)?$/,
    /^\/app-state\/metadata$/,
  ].some((pattern) => pattern.test(path))
}

/**
 * Refresh the CORS origins cache from Keycloak client webOrigins.
 * Called on startup and after SMART app mutations.
 */
export async function refreshCorsOrigins(): Promise<void> {
  try {
    const admin = await getAdminClient()
    if (!admin) {
      cachedOrigins = config.cors.origins
      // A deployed stack without admin credentials ignores every registered webOrigin, so say so.
      if (process.env.NODE_ENV === 'production') {
        logger.auth.error('No Keycloak admin credentials — SMART app webOrigins cannot be read', {
          adminClientId: config.keycloak.adminClientId ?? '(unset)',
          hasSecret: !!config.keycloak.adminClientSecret,
          consequence: `CORS is limited to CORS_ORIGINS (${cachedOrigins.length} origin(s))`,
        })
      }
      return
    }

    const clients = await admin.clients.find()

    // Collect all unique webOrigins from Keycloak clients
    const dynamicOrigins = new Set<string>()
    for (const client of clients) {
      for (const origin of client.webOrigins ?? []) {
        if (origin === '+') {
          // Keycloak's "+" means every origin of the client's redirect URIs.
          for (const uri of client.redirectUris ?? []) {
            const derived = normalizeOrigin(uri)
            if (derived) dynamicOrigins.add(derived)
          }
        } else if (origin && origin !== '*') {
          dynamicOrigins.add(origin)
        }
      }
    }

    // Merge static (env) origins with dynamic (Keycloak) origins
    const staticOrigins = config.cors.origins
    cachedOrigins = [...new Set([...staticOrigins, ...dynamicOrigins])].filter(Boolean)
    lastRefresh = Date.now()

    logger.auth.debug('CORS origins refreshed', {
      static: staticOrigins.length,
      dynamic: dynamicOrigins.size,
      total: cachedOrigins.length,
    })
  } catch (error) {
    // Admin-client errors often say only "Unable to determine error message"; name what was attempted.
    const detail = error instanceof Error ? error.message : String(error)
    const status = errorResponseStatus(error)
    logger.auth.error('Failed to refresh CORS origins from Keycloak — falling back to CORS_ORIGINS', {
      detail,
      ...(status ? { status } : {}),
      keycloakBaseUrl: config.keycloak.baseUrl,
      realm: config.keycloak.realm,
      adminClientId: config.keycloak.adminClientId,
      consequence: 'SMART app webOrigins are NOT in effect',
    })
    if (cachedOrigins.length === 0) {
      cachedOrigins = config.cors.origins
    }
  }
}

/**
 * Refresh if cache is stale (older than TTL). Non-blocking.
 */
export function refreshIfStale(): void {
  if (Date.now() - lastRefresh > CACHE_TTL_MS) {
    refreshCorsOrigins().catch(() => {})
  }
}

/**
 * The request's `Origin` when it is allowed, for echoing back in
 * `Access-Control-Allow-Origin`; null when absent or not allowed.
 */
export function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('origin')
  if (!origin) return null
  return isOriginAllowed(origin) ? origin : null
}
