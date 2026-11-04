// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { logger } from '@/lib/logger'
import { errorResponseStatus } from '@/lib/type-guards'
import { getAdminClient } from '@/lib/kc-admin-factory'

/** CORS_ORIGINS merged with the webOrigins of the clients registered in Keycloak. */
let cachedOrigins: string[] = []
let nextRefreshAt = 0
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const RETRY_INTERVAL_MS = 30 * 1000

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

/** SMART App Launch requires any-origin CORS for discovery, and User-access Brands for the Brand Bundle. */
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

/** Called on startup and after client mutations; failures keep the previous origins. */
export async function refreshCorsOrigins(): Promise<void> {
  try {
    const admin = await getAdminClient()
    if (!admin) {
      cachedOrigins = config.cors.origins
      nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS
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

    const staticOrigins = config.cors.origins
    cachedOrigins = [...new Set([...staticOrigins, ...dynamicOrigins])].filter(Boolean)
    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS

    logger.auth.debug('CORS origins refreshed', {
      static: staticOrigins.length,
      dynamic: dynamicOrigins.size,
      total: cachedOrigins.length,
    })
  } catch (error) {
    nextRefreshAt = Date.now() + RETRY_INTERVAL_MS
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

/** Starts at most one background refresh per interval, however many requests arrive. */
export function refreshIfStale(): void {
  if (Date.now() < nextRefreshAt) return
  nextRefreshAt = Date.now() + RETRY_INTERVAL_MS
  refreshCorsOrigins().catch(() => {})
}

/** The request's `Origin` when allowed, for `Access-Control-Allow-Origin`; null otherwise. */
export function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('origin')
  if (!origin) return null
  return isOriginAllowed(origin) ? origin : null
}
