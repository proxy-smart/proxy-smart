// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { config } from '@/config'
import { findClientByClientId } from '@/lib/keycloak-client-lookup'
import { getAttr } from '@/lib/keycloak-component-config'

/** Keycloak's own clients, which the proxy never touches. */
export const KEYCLOAK_BUILTIN_CLIENTS: ReadonlySet<string> = new Set([
  'account', 'account-console', 'admin-cli', 'broker',
  'realm-management', 'security-admin-console',
])

/** Keycloak's protocol for a client created without one. */
const OIDC_PROTOCOL = 'openid-connect'

/** SMART app type, the only marker an export-seeded app carries. */
const CLIENT_TYPE_ATTR = 'client_type'

/** Set on a client created by dynamic registration (RFC 7591). */
export const DYNAMIC_REGISTRATION_ATTRIBUTE = 'dynamic_registration'
/** Set on the proxy's stand-in for a client named by its metadata document URL. */
export const CIMD_CLIENT_ATTRIBUTE = 'client_id_metadata_document'
/** The `client_type` of the shared client MCP tools sign in with when they bring no registration of their own. */
const MCP_CLIENT_TYPE = 'mcp-client'

export type SelfOnboardedKind = 'metadata-document' | 'dynamic-registration' | 'mcp-client'

/** How a client a user's own software connected got into the realm; null for one an admin registered for a purpose. */
export function selfOnboardedKind(client: ClientRepresentation): SelfOnboardedKind | null {
  if (getAttr(client.attributes, CIMD_CLIENT_ATTRIBUTE) === 'true') return 'metadata-document'
  if (getAttr(client.attributes, DYNAMIC_REGISTRATION_ATTRIBUTE) === 'true') return 'dynamic-registration'
  if (getAttr(client.attributes, CLIENT_TYPE_ATTR) === MCP_CLIENT_TYPE) return 'mcp-client'
  return null
}

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
