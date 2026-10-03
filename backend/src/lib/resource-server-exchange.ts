// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Resource servers that exchange the tokens issued for them (RFC 8707 + RFC 8693).
 *
 * An MCP client must send `resource=<the server's URL>`, and Keycloak then narrows the
 * token's `aud` to exactly that URL. Standard token exchange only lets a client exchange
 * a token whose `aud` holds its own client id. So a server that wants to exchange what it
 * is handed (to read FHIR as itself, with the actor chain recorded) must be a client whose
 * id IS its resource URL, carrying `resource_url` = that same URL.
 */
import type KcAdminClient from '@keycloak/keycloak-admin-client'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'

/** Keycloak client attribute the RFC 8707 post-processor matches a requested `resource` against. */
export const RESOURCE_URL_ATTR = 'resource_url'

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** A client whose id is its own resource URL. */
export function isExchangeResourceServer(client: Pick<ClientRepresentation, 'clientId' | 'attributes'>): boolean {
  const clientId = client.clientId
  return Boolean(clientId && isHttpsUrl(clientId) && client.attributes?.[RESOURCE_URL_ATTR] === clientId)
}

/** Why a client cannot be marked as a resource server, or null when it can. */
export function resourceServerRejection(clientId: string): string | null {
  return isHttpsUrl(clientId)
    ? null
    : 'A resource server must use its https resource URL as its client id, so tokens issued for that URL can be exchanged by it'
}

/** The attribute that marks (or unmarks) a client as a resource server. */
export function resourceServerAttribute(clientId: string, enabled: boolean): Record<string, string> {
  return { [RESOURCE_URL_ATTR]: enabled ? clientId : '' }
}

/** Every exchange resource server in the realm, by client id. */
export async function exchangeResourceServerIds(admin: KcAdminClient): Promise<string[]> {
  const clients = await admin.clients.find()
  return clients.filter(isExchangeResourceServer).flatMap((client) => (client.clientId ? [client.clientId] : []))
}
