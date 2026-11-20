// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from '../lib/logger'
import { getAdminClient } from '../lib/kc-admin-factory'
import { loadRuntimeConfig } from '../lib/runtime-config'
import {
  ensureShlExchangeClient,
  ensureIntrospectionClientConfig,
  ensureResourceServerClients,
  ensureResourceIndicatorsScope,
  ensureAdminUiDeviceGrant,
  ensureSubjectScope,
  reconcileClientHomeUrls,
} from '../lib/kc-system-provisioning'
import { KEYCLOAK_BUILTIN_CLIENTS } from '../lib/realm-clients'
import { reconcileLiteralAudiences } from '../lib/audience-mapper'
import { adoptKeycloakCimdPolicy } from '../lib/cimd-policy'
import { ensureAdvertisedScopes } from '../lib/smart-scope-provisioning'

/** Keycloak 25+ needs post.logout.redirect.uris for logout redirects; "+" reuses the valid redirect URIs. */
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
      if (!client.id || !client.clientId || KEYCLOAK_BUILTIN_CLIENTS.has(client.clientId)) continue
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

/** Proxy-owned system clients whose secrets live in config, never in the committed realm-export. */
export async function ensureSystemClients(): Promise<void> {
  const admin = await getAdminClient()
  if (!admin) {
    logger.keycloak.debug('Skipping system-client reconcile — no admin credentials configured')
    return
  }

  await ensureShlExchangeClient(admin)
  await ensureIntrospectionClientConfig(admin)
  await ensureResourceServerClients(admin)
  // After the resource clients: the scope's mappers name them as audiences.
  await ensureResourceIndicatorsScope(admin)
  // Keycloak's CIMD policy refuses the proxy callback; the proxy stands in for CIMD clients instead.
  await adoptKeycloakCimdPolicy(admin).catch((error) => {
    logger.keycloak.warn('Could not hand CIMD over from Keycloak to the proxy', { error })
  })
  await ensureAdminUiDeviceGrant(admin)
  await ensureSubjectScope(admin)
  await ensureAdvertisedScopes(admin)
  // Keycloak 26.7.5 drops client audiences that name no client, e.g. the MCP URL.
  await reconcileLiteralAudiences(admin).catch((error) => {
    logger.keycloak.warn('Could not reconcile literal audience mappers', { error })
  })
  await reconcileClientHomeUrls(admin).catch((error) => {
    logger.keycloak.warn('Could not reconcile client home URLs', { error })
  })
}

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
