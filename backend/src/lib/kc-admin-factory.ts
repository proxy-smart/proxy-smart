// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Keycloak Admin Client Factory
 *
 * Creates a KcAdminClient that authenticates with the service account, and
 * hands the same one back on every call.
 *
 * Extracted to its own module so tests can mock it without needing to mock
 * the @keycloak/keycloak-admin-client npm package (which has inconsistent
 * mock.module behaviour across platforms in bun).
 *
 * WHY A TOKEN PROVIDER, NOT admin.auth() PER CALL. Ten modules call this — every
 * SMART callback, every token exchange that stamps a last login, the login
 * page's brand colour — and each call used to be its own client_credentials
 * round trip to Keycloak.
 *
 * Caching the authenticated client instead would break: the library refreshes
 * an expired token with a refresh token, and Keycloak issues none for
 * client_credentials (test/kc-admin-client-client-credentials.test.ts pins that
 * contract after it took the backend down). `getAccessToken()` would reach
 * `Cannot refresh token: missing refresh token or credentials` one access-token
 * lifespan in — about a minute — and every admin call would fail from there.
 *
 * A registered TokenProvider sidesteps the refresh path entirely: the library
 * asks it for a bearer on every request (resources/agent.js), and it answers
 * from a TokenCache that re-authenticates only when the token is near expiry.
 */

import KcAdminClient from '@keycloak/keycloak-admin-client'
import type { KeycloakAdapterConfig } from '@proxy-smart/auth'
import { config } from '@/config'
import { TokenCache, type FetchedToken } from '@/lib/cache/token-cache'

/**
 * A Keycloak connection with its service-account credentials actually present.
 *
 * Narrowed from the adapter's config rather than declared again: that type is
 * already the shared vocabulary for "how to reach Keycloak", and three parallel
 * spellings of four fields is how they drift. Required, because "configured" is
 * the precondition for authenticating at all — the alternative is optional
 * fields and a non-null assertion at every use.
 */
export type AdminConnection =
  Required<Pick<KeycloakAdapterConfig, 'baseUrl' | 'realm' | 'adminClientId' | 'adminClientSecret'>>

/** Where a factory reads its connection. Injectable so tests need no env or module mocking. */
export type AdminConnectionSource = () => AdminConnection | null

function connectionFromConfig(): AdminConnection | null {
  if (!config.keycloak.isConfigured) return null

  const { baseUrl, realm, adminClientId, adminClientSecret } = config.keycloak
  if (!baseUrl || !realm || !adminClientId || !adminClientSecret) return null

  return { baseUrl, realm, adminClientId, adminClientSecret }
}

/**
 * What makes one admin client different from another. The admin UI can repoint
 * Keycloak at runtime, so the client and its token are keyed on this rather
 * than assumed constant for the process.
 *
 * Carries the secret, so it is a map key and never a log field.
 */
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

/**
 * Build an admin-client factory over a connection source.
 *
 * Exported so tests can drive a real client against a fake Keycloak without
 * touching process.env, which is process-global and therefore cannot differ
 * between two tests running at once.
 */
export function createAdminClientFactory(readConnection: AdminConnectionSource) {
  const tokens = new TokenCache()
  let cached: { identity: string; client: KcAdminClient } | null = null

  return {
    async getClient(): Promise<KcAdminClient | null> {
      const connection = readConnection()
      if (!connection) return null

      const identity = identityOf(connection)

      /*
       * Eager, so a refused credential still surfaces here rather than inside
       * whichever admin call happens to run first, which is where admin.auth()
       * used to raise it. A cache hit makes this free.
       */
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

    /**
     * Force the next request to mint a fresh token, keeping the client.
     *
     * For the caller that changes what its own service account may do: the
     * cached bearer predates the new role, and `admin.auth()` cannot replace it
     * because a registered provider takes precedence in `getAccessToken()`.
     */
    invalidateToken(): void {
      tokens.clear()
    },

    /** Drop the cached client and its token. For tests, and for a credential rotation. */
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

/**
 * Force the next admin request to mint a fresh token.
 *
 * Call after changing what the service account itself may do: the cached bearer
 * was issued before the change and does not carry it.
 */
export function invalidateAdminToken(): void {
  defaultFactory.invalidateToken()
}

/** Drop the process-wide cached client. For tests, and for a credential rotation. */
export function resetAdminClient(): void {
  defaultFactory.reset()
}
