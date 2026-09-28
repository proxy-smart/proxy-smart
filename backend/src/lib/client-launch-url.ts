// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Resolve a SMART app's registered launch URL by OAuth client id.
 *
 * A SMART app's launch URL lives on its Keycloak client as the `launch_url`
 * attribute (set via the Smart Apps admin API — see routes/admin/smart-apps.ts).
 * This is the authoritative source for "where does this app live", used to route
 * an SHL recipient back into the app that minted the share (e.g. the DICOM
 * viewer) rather than the patient portal.
 *
 * Reads via a Keycloak service-account admin client (same pattern as
 * cors-origins.ts) and caches per-clientId with a short TTL so the SHL create
 * path doesn't pay an admin round-trip every time. Fails soft: any error or
 * missing attribute resolves to `null` so the caller falls back to the portal.
 */
import KcAdminClient from '@keycloak/keycloak-admin-client'
import { config } from '@/config'
import { logger } from '@/lib/logger'
import { getAttr } from '@/lib/smart-client-enrichment'
import { TtlCache } from '@/lib/cache/ttl-cache'

const launchUrls = new TtlCache<string | null>({ ttlMs: 5 * 60 * 1000 })

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
    const { adminClientId, adminClientSecret, baseUrl, realm } = config.keycloak
    if (!adminClientId || !adminClientSecret || !baseUrl || !realm) return null

    const admin = new KcAdminClient({ baseUrl, realmName: realm })
    await admin.auth({
      grantType: 'client_credentials',
      clientId: adminClientId,
      clientSecret: adminClientSecret,
    })
    const clients = await admin.clients.find({ clientId, max: 1 })
    return getAttr(clients[0]?.attributes, 'launch_url') ?? null
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
