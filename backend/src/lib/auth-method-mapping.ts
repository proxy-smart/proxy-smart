// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Keycloak clientAuthenticatorType <-> RFC 7591 token_endpoint_auth_method. All private_key_jwt
// clients are federated-jwt: the proxy verifies against the client JWKS and re-signs for Keycloak.

import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'

/** The Keycloak IdP that verifies proxy-signed client assertions (federated-jwt). */
export const PROXY_SIGNING_IDP_ALIAS = 'proxy-smart-signing'

export function federatedJwtAttributes(clientId: string): Record<string, string> {
  return {
    'jwt.credential.issuer': PROXY_SIGNING_IDP_ALIAS,
    'jwt.credential.sub': clientId,
  }
}

export type TokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'private_key_jwt'

export function toTokenEndpointAuthMethod(client: ClientRepresentation): TokenEndpointAuthMethod {
  const kcType = client.clientAuthenticatorType

  if (client.publicClient || kcType === 'none') {
    return 'none'
  }

  if (kcType === 'client-jwt' || kcType === 'federated-jwt') {
    return 'private_key_jwt'
  }

  // Legacy backend services: client-secret in Keycloak, but the proxy validates their JWT.
  if (
    client.serviceAccountsEnabled &&
    hasJwksConfig(client)
  ) {
    return 'private_key_jwt'
  }

  return 'client_secret_basic'
}

export function toKeycloakAuthType(
  method: TokenEndpointAuthMethod | string | undefined,
  _isBackendService?: boolean
): string {
  switch (method) {
    case 'none':
      return 'none'
    case 'private_key_jwt':
      return 'federated-jwt'
    case 'client_secret_post':
    case 'client_secret_basic':
      return 'client-secret'
    default:
      return 'client-secret'
  }
}

function hasJwksConfig(client: ClientRepresentation): boolean {
  const attrs = client.attributes || {}
  return !!(
    attrs['use.jwks.url'] === 'true' ||
    attrs['jwks.url'] ||
    attrs['use.jwks.string'] === 'true' ||
    attrs['jwks.string']
  )
}
