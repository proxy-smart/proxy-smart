// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keeps the client scopes the proxy advertises present in Keycloak. A scope in
 * `.well-known/smart-configuration` that the realm lacks answers the spec's own
 * example requests with invalid_scope; realm imports skip existing realms, so this
 * runs at startup rather than relying on the export.
 */

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import { config } from '../config'
import { logger } from './logger'
import { ensureScopesExist } from './smart-client-enrichment'
import { smartScopesSupported } from './smart-config'

type ScopeAdmin = { clientScopes: Pick<KcAdminClient['clientScopes'], 'find' | 'create'> }

/** The scope a SMART bearer token needs at /auth/introspect; assigned to clients that may introspect. */
async function ensureIntrospectionScope(admin: ScopeAdmin, existing: ReadonlySet<string | undefined>): Promise<void> {
  const name = config.smart.introspectionScope
  if (existing.has(name)) return
  await admin.clientScopes.create({
    name,
    description: 'Lets a SMART app or backend service introspect tokens issued to any client (SMART 2.2 Token Introspection)',
    protocol: 'openid-connect',
    attributes: {
      'include.in.token.scope': 'true',
      'display.on.consent.screen': 'false',
    },
  })
  logger.keycloak.info('Created the token introspection client scope', { name })
}

export async function ensureAdvertisedScopes(admin: ScopeAdmin): Promise<void> {
  try {
    const existing = await admin.clientScopes.find()
    await ensureScopesExist(admin, smartScopesSupported(), existing)
    await ensureIntrospectionScope(admin, new Set(existing.map((scope) => scope.name)))
  } catch (error) {
    logger.keycloak.warn('Could not ensure the advertised client scopes', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
