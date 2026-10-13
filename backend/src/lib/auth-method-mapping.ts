// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Maps between Keycloak's internal clientAuthenticatorType values and
 * standard OAuth 2.0 token_endpoint_auth_method values (RFC 7591).
 *
 * Keycloak uses:
 *   - 'client-secret'   → for both client_secret_basic and client_secret_post
 *   - 'client-jwt'      → for private_key_jwt (client-signed JWT assertion, verified by KC)
 *   - 'federated-jwt'   → for private_key_jwt where an IdP verifies the assertion
 *   - 'none'            → public clients (no authentication)
 *
 * Our proxy intercepts ALL private_key_jwt assertions (both user-facing and
 * backend services), validates them against the client's registered JWKS, then
 * re-signs with the proxy's own key. Keycloak verifies the re-signed assertion
 * via the 'proxy-smart-signing' IdP (federated-jwt).
 *
 * Standard OAuth values (RFC 7591 / RFC 7523):
 *   - 'none'                → public client
 *   - 'client_secret_basic' → HTTP Basic with client_id:client_secret
 *   - 'client_secret_post'  → client_secret in POST body
 *   - 'private_key_jwt'     → JWT assertion signed with client's private key
 */

import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'

/** The Keycloak IdP that verifies proxy-signed client assertions (federated-jwt). */
export const PROXY_SIGNING_IDP_ALIAS = 'proxy-smart-signing'

/** Binds a federated-jwt client to the proxy's signing IdP, with the client itself as the assertion subject. */
export function federatedJwtAttributes(clientId: string): Record<string, string> {
  return {
    'jwt.credential.issuer': PROXY_SIGNING_IDP_ALIAS,
    'jwt.credential.sub': clientId,
  }
}

/** Standard OAuth 2.0 token_endpoint_auth_method values */
export type TokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'private_key_jwt'

/**
 * Convert Keycloak's internal clientAuthenticatorType to a standard OAuth
 * token_endpoint_auth_method value for external consumption.
 *
 * Uses client attributes (JWKS config, service account flag) to disambiguate
 * cases where Keycloak stores 'client-secret' but the external-facing method
 * is actually 'private_key_jwt'.
 */
export function toTokenEndpointAuthMethod(client: ClientRepresentation): TokenEndpointAuthMethod {
  const kcType = client.clientAuthenticatorType

  // Public client
  if (client.publicClient || kcType === 'none') {
    return 'none'
  }

  // Keycloak's 'client-jwt' or 'federated-jwt' both map to private_key_jwt
  if (kcType === 'client-jwt' || kcType === 'federated-jwt') {
    return 'private_key_jwt'
  }

  // Backend services with JWKS registered → proxy validates JWT, uses secret internally
  if (
    client.serviceAccountsEnabled &&
    hasJwksConfig(client)
  ) {
    return 'private_key_jwt'
  }

  // Default: confidential client with client_secret_basic
  return 'client_secret_basic'
}

/**
 * Convert a standard OAuth token_endpoint_auth_method to the Keycloak
 * clientAuthenticatorType value for storage.
 *
 * For 'private_key_jwt', ALL clients (user-facing and backend services) use
 * 'federated-jwt' — the proxy validates the original JWT assertion against the
 * client's JWKS, re-signs it with the proxy's own key, and KC verifies the
 * re-signed assertion via the 'proxy-smart-signing' IdP.
 */
export function toKeycloakAuthType(
  method: TokenEndpointAuthMethod | string | undefined,
  _isBackendService?: boolean
): string {
  switch (method) {
    case 'none':
      return 'none'
    case 'private_key_jwt':
      // Proxy re-signs assertions with its own key;
      // KC verifies via the proxy-smart-signing IdP (federated-jwt)
      return 'federated-jwt'
    case 'client_secret_post':
    case 'client_secret_basic':
      return 'client-secret'
    default:
      // Unrecognized or undefined — default to client-secret for confidential
      return 'client-secret'
  }
}

/** Check if a client has JWKS configuration in its attributes */
function hasJwksConfig(client: ClientRepresentation): boolean {
  const attrs = client.attributes || {}
  return !!(
    attrs['use.jwks.url'] === 'true' ||
    attrs['jwks.url'] ||
    attrs['use.jwks.string'] === 'true' ||
    attrs['jwks.string']
  )
}
