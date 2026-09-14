// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keycloak Admin Client Factory
 *
 * One authenticated KcAdminClient, reused. It carries a TokenProvider rather
 * than a token from admin.auth(), because client_credentials issues no refresh
 * token and the library's own refresh path therefore cannot work — see
 * test/kc-admin-client-client-credentials.test.ts.
 *
 * A separate module so tests can mock it instead of the npm package.
 */

import KcAdminClient from '@keycloak/keycloak-admin-client'
import type { KeycloakAdapterConfig } from '@proxy-smart/auth'
import { config } from '@/config'
import { TokenCache, type FetchedToken } from '@/lib/cache/token-cache'

/** The adapter's connection, narrowed to the case where credentials are present. */
export type AdminConnection =
  Required<Pick<KeycloakAdapterConfig, 'baseUrl' | 'realm' | 'adminClientId' | 'adminClientSecret'>>

/** Injectable so tests need no process.env, which cannot differ between concurrent tests. */
export type AdminConnectionSource = () => AdminConnection | null

function connectionFromConfig(): AdminConnection | null {
  if (!config.keycloak.isConfigured) return null

  const { baseUrl, realm, adminClientId, adminClientSecret } = config.keycloak
  if (!baseUrl || !realm || !adminClientId || !adminClientSecret) return null

  return { baseUrl, realm, adminClientId, adminClientSecret }
}

/** Carries the secret: a map key, never a log field. */
const identityOf = (connection: AdminConnection): string =>
  [connection.baseUrl, connection.realm, connection.adminClientId, connection.adminClientSecret].join(' ')

async function requestToken(connection: AdminConnection): Promise<FetchedToken> {
  const tokenUrl = `${connection.baseUrl}/realms/${connection.realm}/protocol/openid-connect/token`
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: connection.adminClientId,
      client_secret: connection.adminClientSecret,
    }),
  })

  if (!res.ok) {
    throw new Error(`Keycloak admin token request failed: ${res.status}`)
  }

  const data: { access_token: string; expires_in?: number } = await res.json()
  return { token: data.access_token, expiresInSeconds: data.expires_in }
}

export function createAdminClientFactory(readConnection: AdminConnectionSource) {
  const tokens = new TokenCache()
  let cached: { identity: string; client: KcAdminClient } | null = null

  return {
    async getClient(): Promise<KcAdminClient | null> {
      const connection = readConnection()
      if (!connection) return null

      const identity = identityOf(connection)
      // Eager, so a refused credential surfaces here rather than mid-request.
      await tokens.get(identity, () => requestToken(connection))

      if (cached?.identity !== identity) {
        const client = new KcAdminClient({
          baseUrl: connection.baseUrl,
          realmName: connection.realm,
        })
        client.registerTokenProvider({
          getAccessToken: () => tokens.get(identity, () => requestToken(connection)),
        })
        cached = { identity, client }
      }

      return cached.client
    },

    /** After the service account's own roles change: the cached bearer predates them. */
    invalidateToken(): void {
      tokens.clear()
    },

    reset(): void {
      tokens.clear()
      cached = null
    },
  }
}

const defaultFactory = createAdminClientFactory(connectionFromConfig)

/** Create and authenticate a Keycloak admin client, or null if not configured. */
export function getAdminClient(): Promise<KcAdminClient | null> {
  return defaultFactory.getClient()
}

/** After the service account's own roles change: the cached bearer predates them. */
export function invalidateAdminToken(): void {
  defaultFactory.invalidateToken()
}

export function resetAdminClient(): void {
  defaultFactory.reset()
}
