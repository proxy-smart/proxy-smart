// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keycloak client reconciliation at startup: attributes Keycloak requires but
 * no realm-export carries, and the proxy-owned system clients whose secrets
 * live in config rather than in the committed export.
 */

import { logger } from '../lib/logger'
import { getAdminClient } from '../lib/kc-admin-factory'
import { loadRuntimeConfig } from '../lib/runtime-config'
import {
  ensureShlExchangeClient,
  ensureIntrospectionClientConfig,
  ensureResourceServerClients,
  ensureResourceIndicatorsScope,
  ensureAdminUiDeviceGrant,
} from '../lib/kc-system-provisioning'
import { reconcileLiteralAudiences } from '../lib/audience-mapper'

/** Keycloak's own clients, which we never touch. */
const INTERNAL_CLIENTS = new Set([
  'account', 'account-console', 'admin-cli', 'broker',
  'realm-management', 'security-admin-console',
])

/**
 * Ensure all Keycloak clients have the post.logout.redirect.uris attribute.
 * Keycloak 25+ requires this attribute for post-logout redirects to work;
 * "+" means "use the same URIs as Valid Redirect URIs".
 * Idempotent — safe to call on every startup.
 */
export async function ensurePostLogoutRedirectUris(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug('Skipping post-logout redirect URI check — no admin credentials configured')
    return
  }

  try {
    const clients = await admin.clients.find()
    let repaired = 0

    for (const client of clients) {
      if (!client.id || !client.clientId || INTERNAL_CLIENTS.has(client.clientId)) continue
      if (client.attributes?.['post.logout.redirect.uris']) continue

      try {
        await admin.clients.update({ id: client.id }, {
          attributes: {
            ...client.attributes,
            'post.logout.redirect.uris': '+',
          },
        })
        repaired++
        logger.keycloak.debug(`Set post.logout.redirect.uris for client "${client.clientId}"`)
      } catch (error) {
        logger.keycloak.warn(`Could not update post.logout.redirect.uris for "${client.clientId}"`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (repaired > 0) {
      logger.keycloak.info(`✅ Set post.logout.redirect.uris on ${repaired} client(s)`)
    } else {
      logger.keycloak.info('✅ All clients already have post.logout.redirect.uris configured')
    }
  } catch (error) {
    logger.keycloak.warn('Could not auto-repair post-logout redirect URIs', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Reconcile proxy-owned Keycloak system clients whose secrets live in config
 * (never in the committed realm-export). Runs as the admin-service service
 * account. Idempotent and non-fatal.
 */
export async function ensureSystemClients(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug('Skipping system-client reconcile — no admin credentials configured')
    return
  }

  await ensureShlExchangeClient(admin)
  await ensureIntrospectionClientConfig(admin)
  // RFC 8707 resource clients, whose resource_url must match this environment's
  // baseUrl — production was still carrying dev localhost URLs.
  await ensureResourceServerClients(admin)
  // After the resource clients — the scope's mappers name them as audiences.
  await ensureResourceIndicatorsScope(admin)
  // Lets the admin UI work without a browser or a client secret.
  await ensureAdminUiDeviceGrant(admin)
  // Keycloak 26.7.5 drops client audiences that name no client, e.g. the MCP URL.
  await reconcileLiteralAudiences(admin).catch((error) => {
    logger.keycloak.warn('Could not reconcile literal audience mappers', { error })
  })
}

/**
 * Load consent, SMART access control and brand settings from realm attributes now,
 * rather than on the first admin request that needs them.
 */
export async function loadRuntimeConfigEagerly(): Promise<void> {
  try {
    const admin = await getAdminClient()
    if (!admin) return

    await loadRuntimeConfig(admin)
    logger.keycloak.info('✅ Runtime config loaded from Keycloak realm attributes')
  } catch (error) {
    logger.keycloak.warn('Could not eagerly load runtime config — will load on first admin request', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
