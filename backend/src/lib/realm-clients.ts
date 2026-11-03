// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { config } from '@/config'
import { findClientByClientId } from '@/lib/keycloak-client-lookup'

/** Keycloak's own clients, which the proxy never touches. */
export const KEYCLOAK_BUILTIN_CLIENTS: ReadonlySet<string> = new Set([
  'account', 'account-console', 'admin-cli', 'broker',
  'realm-management', 'security-admin-console',
])

/** Keycloak's protocol for a client created without one. */
const OIDC_PROTOCOL = 'openid-connect'

/** SMART app type, the only marker an export-seeded app carries. */
const CLIENT_TYPE_ATTR = 'client_type'

/** An app a user or service signs in to, as the admin views list them: not built in, not the admin UI, not bearer-only. */
export function isRealmAppClient(client: ClientRepresentation): boolean {
  const clientId = client.clientId ?? ''
  return (client.protocol ?? OIDC_PROTOCOL) === OIDC_PROTOCOL
    && !client.bearerOnly
    && !KEYCLOAK_BUILTIN_CLIENTS.has(clientId)
    && clientId !== config.keycloak.adminUiClientId
}

/** The realm app with this client id; undefined for an unknown client and for the clients isRealmAppClient leaves out. */
export async function findRealmAppClient(admin: KcAdminClient, clientId: string): Promise<ClientRepresentation | undefined> {
  const client = await findClientByClientId(admin, clientId)
  return client && isRealmAppClient(client) ? client : undefined
}

/**
 * A SMART app, however it got into the realm. `smart_app` is written only when a client is
 * created through the admin API or DCR; an export-seeded app carries only `client_type`.
 */
export function isSmartAppClient(client: ClientRepresentation): boolean {
  return client.attributes?.smart_app !== undefined || client.attributes?.[CLIENT_TYPE_ATTR] !== undefined
}
