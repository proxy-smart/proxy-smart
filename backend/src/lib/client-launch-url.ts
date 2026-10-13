// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// A SMART app's launch URL is the `launch_url` attribute on its Keycloak client, or for a dynamically
// registered app one of its comma-separated `smart.launch_uris`.
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getAttr } from '@/lib/keycloak-component-config'
import { getAdminClient } from '@/lib/kc-admin-factory'
import { TtlCache } from '@/lib/cache/ttl-cache'

const launchUrls = new TtlCache<string | null>({ ttlMs: 5 * 60 * 1000 })
const registeredApps = new TtlCache<RegisteredClient[]>({ ttlMs: 60 * 1000 })

/**
 * The registered `launch_url` for the given OAuth client id, or `null` when the
 * client is unknown, has no launch URL, or Keycloak is unreachable. Cached.
 */
export async function resolveClientLaunchUrl(clientId: string): Promise<string | null> {
  if (!clientId) return null
  return launchUrls.getOrLoad(clientId, () => readLaunchUrl(clientId))
}

async function readLaunchUrl(clientId: string): Promise<string | null> {
  try {
    const admin = await getAdminClient()
    if (!admin) return null
    const clients = await admin.clients.find({ clientId, max: 1 })
    return registeredLaunchUrls(clients[0]?.attributes)[0] ?? null
  } catch (error) {
    logger.auth.warn('Failed to resolve client launch_url from Keycloak', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Where an SHL recipient lands: the minting app's launch URL, else the configured portal.
 * A root launch URL is kept unless it is the proxy's own root, which serves the proxy homepage.
 */
export function resolveShlViewerBase(launchUrl: string | null | undefined, portalUrl: string | null | undefined): string {
  const fallback = portalUrl || `${config.baseUrl}/apps/patient-portal/`
  if (!launchUrl) return fallback
  try {
    const u = new URL(launchUrl)
    const isProxyRoot = u.origin === new URL(config.baseUrl).origin && u.pathname === '/'
    return isProxyRoot ? fallback : `${u.origin}${u.pathname}`
  } catch {
    return fallback
  }
}

export interface RegisteredClient {
  clientId?: string
  enabled?: boolean
  attributes?: Record<string, unknown>
}

export interface RegisteredApp {
  clientId: string
  launchUrl: string
}

export type RegisteredAppLookup =
  | { status: 'found'; app: RegisteredApp }
  | { status: 'absent' }
  | { status: 'ambiguous'; clientIds: string[] }
  | { status: 'unavailable'; reason: string }

function comparableLaunchUrl(url: string): string | null {
  try {
    const parsed = new URL(url, `${config.baseUrl}/`)
    parsed.hash = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.href
  } catch {
    return null
  }
}

/** Every launch URL a client registered: `launch_url` from the admin API, `smart.launch_uris` from DCR. */
export function registeredLaunchUrls(attributes: Record<string, unknown> | undefined): string[] {
  const dynamic = (getAttr(attributes, 'smart.launch_uris') ?? '').split(',').map((uri) => uri.trim())
  return [getAttr(attributes, 'launch_url'), ...dynamic].filter((uri): uri is string => !!uri)
}

export function matchAppByLaunchUrl(clients: readonly RegisteredClient[], launchUrl: string): RegisteredAppLookup {
  const wanted = comparableLaunchUrl(launchUrl)
  if (!wanted) return { status: 'absent' }

  const matches: RegisteredApp[] = []
  for (const client of clients) {
    if (!client.clientId || client.enabled === false) continue
    const registered = registeredLaunchUrls(client.attributes).find((uri) => comparableLaunchUrl(uri) === wanted)
    if (!registered) continue
    matches.push({ clientId: client.clientId, launchUrl: new URL(registered, `${config.baseUrl}/`).href })
  }

  if (matches.length === 1) return { status: 'found', app: matches[0] }
  if (matches.length > 1) return { status: 'ambiguous', clientIds: matches.map((m) => m.clientId) }
  return { status: 'absent' }
}

async function listRegisteredClients(): Promise<RegisteredClient[]> {
  const admin = await getAdminClient()
  if (!admin) throw new Error('Keycloak admin credentials are not configured')
  return admin.clients.find()
}

export async function findAppByLaunchUrl(launchUrl: string): Promise<RegisteredAppLookup> {
  try {
    return matchAppByLaunchUrl(await registeredApps.getOrLoad('clients', listRegisteredClients), launchUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.auth.warn('Cannot read registered SMART apps from Keycloak', { error: reason })
    return { status: 'unavailable', reason }
  }
}
