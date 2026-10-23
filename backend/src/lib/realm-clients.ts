// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'

/** Keycloak's own clients, which the proxy never touches. */
export const KEYCLOAK_BUILTIN_CLIENTS: ReadonlySet<string> = new Set([
  'account', 'account-console', 'admin-cli', 'broker',
  'realm-management', 'security-admin-console',
])

const ADMIN_UI_CLIENT = 'admin-ui'

/** SMART app type, the only marker an export-seeded app carries. */
const CLIENT_TYPE_ATTR = 'client_type'

/** An app a user or service signs in to, as the admin views list them: not built in, not the admin UI, not bearer-only. */
export function isRealmAppClient(client: ClientRepresentation): boolean {
  const clientId = client.clientId ?? ''
  return client.protocol === 'openid-connect'
    && !client.bearerOnly
    && !KEYCLOAK_BUILTIN_CLIENTS.has(clientId)
    && clientId !== ADMIN_UI_CLIENT
}

/**
 * A SMART app, however it got into the realm. `smart_app` is written only when a client is
 * created through the admin API or DCR; an export-seeded app carries only `client_type`.
 */
export function isSmartAppClient(client: ClientRepresentation): boolean {
  return client.attributes?.smart_app !== undefined || client.attributes?.[CLIENT_TYPE_ATTR] !== undefined
}
