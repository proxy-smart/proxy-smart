// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** Mirrored discovery docs must never leak Keycloak-direct URLs: clients reading them would bypass the proxy's auth layer. */

import { KEYCLOAK_BUILTIN_DEFAULT_SCOPES } from './oauth-scopes'
import { RESOURCE_INDICATORS_SCOPE } from './smart-client-enrichment'
import { TOKEN_EXCHANGE_GRANT } from './token-actor'
import { stringArray } from './type-guards'
import { acceptedAssertionAlgorithms } from './client-jwks'

const KEYCLOAK_DIRECT_MARKER = '/protocol/openid-connect/'

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * Intersected with Keycloak's lists. Implicit/hybrid skip launch-context enrichment, password/CIBA have no route,
 * and tls_client_auth/client_secret_jwt cannot survive the proxy re-signing client assertions.
 */
export const PROXY_OAUTH_SUPPORT = {
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials', TOKEN_EXCHANGE_GRANT, DEVICE_CODE_GRANT],
  responseTypes: ['code'],
  confidentialClientAuthMethods: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
  /** The proxy verifies client assertions itself, so these are its algorithms, not Keycloak's. */
  get clientAssertionSigningAlgs(): string[] {
    return acceptedAssertionAlgorithms()
  },
} as const

/** Keycloak plumbing scopes: present in its discovery, never something a client should request. */
const KEYCLOAK_INTERNAL_SCOPES: ReadonlySet<string> = new Set([
  ...KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  'microprofile-jwt',
  'basic',
  'service_account',
  RESOURCE_INDICATORS_SCOPE,
])

function supportedOf(supported: readonly string[], declared: unknown): string[] {
  const keycloak = stringArray(declared)
  return keycloak ? supported.filter((item) => keycloak.includes(item)) : [...supported]
}

/**
 * The scopes a client can request: Keycloak's client scopes without its plumbing, led by the
 * preferred list where Keycloak has those scopes. Without a Keycloak list, the preferred one stands.
 */
export function advertisedScopes(oidcConfig: Record<string, unknown>, preferred: readonly string[] = []): string[] {
  const keycloak = stringArray(oidcConfig.scopes_supported)
  if (!keycloak) return [...new Set(preferred)]
  const requestable = keycloak.filter((scope) => !KEYCLOAK_INTERNAL_SCOPES.has(scope))
  return [...new Set([...preferred.filter((scope) => requestable.includes(scope)), ...requestable])]
}

/** Keycloak advertises `none` only with CIMD enabled, yet DCR always creates public clients with it. */
function tokenEndpointAuthMethods(oidcConfig: Record<string, unknown>): string[] {
  return [...supportedOf(PROXY_OAUTH_SUPPORT.confidentialClientAuthMethods, oidcConfig.token_endpoint_auth_methods_supported), 'none']
}

/** The grant, response type, client authentication and scope lists every discovery document shares. */
export function proxyOAuthCapabilities(oidcConfig: Record<string, unknown>, preferredScopes: readonly string[] = []) {
  return {
    grant_types_supported: supportedOf(PROXY_OAUTH_SUPPORT.grantTypes, oidcConfig.grant_types_supported),
    response_types_supported: supportedOf(PROXY_OAUTH_SUPPORT.responseTypes, oidcConfig.response_types_supported),
    token_endpoint_auth_methods_supported: tokenEndpointAuthMethods(oidcConfig),
    token_endpoint_auth_signing_alg_values_supported: [...PROXY_OAUTH_SUPPORT.clientAssertionSigningAlgs],
    // SMART 2.2 and OAuth 2.1: S256 only, never plain.
    code_challenge_methods_supported: ['S256'],
    scopes_supported: advertisedScopes(oidcConfig, preferredScopes),
  }
}

/** Introspection and revocation are fronted the same way, so they share the token endpoint's limits. */
function endpointAuthCapabilities(oidcConfig: Record<string, unknown>) {
  const confidential = PROXY_OAUTH_SUPPORT.confidentialClientAuthMethods
  return {
    introspection_endpoint_auth_methods_supported: supportedOf(confidential, oidcConfig.introspection_endpoint_auth_methods_supported),
    introspection_endpoint_auth_signing_alg_values_supported: [...PROXY_OAUTH_SUPPORT.clientAssertionSigningAlgs],
    revocation_endpoint_auth_methods_supported: [...supportedOf(confidential, oidcConfig.revocation_endpoint_auth_methods_supported), 'none'],
    revocation_endpoint_auth_signing_alg_values_supported: [...PROXY_OAUTH_SUPPORT.clientAssertionSigningAlgs],
  }
}

/**
 * `issuer` is the proxy origin: RFC 8414 §3.3 requires it to match the retrieval URL, and the proxy sends the RFC 9207 `iss`.
 * Keycloak still mints tokens; its realm issuer stays in smart-configuration for id_token validation.
 */
export function proxyOAuthEndpoints(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/auth/authorize`,
    token_endpoint: `${baseUrl}/auth/token`,
    device_authorization_endpoint: `${baseUrl}/auth/device`,
    introspection_endpoint: `${baseUrl}/auth/introspect`,
    revocation_endpoint: `${baseUrl}/auth/revoke`,
    userinfo_endpoint: `${baseUrl}/auth/userinfo`,
    registration_endpoint: `${baseUrl}/auth/register`,
    end_session_endpoint: `${baseUrl}/auth/logout`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
  } satisfies Record<string, string>
}

/** No proxy route exists for these, so they are dropped; Keycloak's own URL would be a bypass. */
const UNSUPPORTED_LEAK_KEYS = [
  'mtls_endpoint_aliases',
  'pushed_authorization_request_endpoint',
  'backchannel_authentication_endpoint',
] as const

/** `baseUrl` is the proxy origin without a trailing slash. */
export function sanitizeDiscoveryDocument(
  oidcConfig: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    ...oidcConfig,
    ...proxyOAuthEndpoints(baseUrl),
  }

  for (const key of UNSUPPORTED_LEAK_KEYS) {
    delete sanitized[key]
  }

  // Catches Keycloak-direct fields not listed above, e.g. check_session_iframe.
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'string' && value.includes(KEYCLOAK_DIRECT_MARKER)) {
      delete sanitized[key]
    }
  }

  return sanitized
}

export function buildOpenIdConfiguration(
  oidcConfig: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    ...sanitizeDiscoveryDocument(oidcConfig, baseUrl),
    ...proxyOAuthCapabilities(oidcConfig),
    ...endpointAuthCapabilities(oidcConfig),
  }
  delete document.client_id_metadata_document_supported
  return document
}

/**
 * RFC 8414 metadata shared by every discovery path. CIMD is not advertised: the proxy rewrites redirect_uri,
 * which Keycloak's CIMD executor rejects, so MCP clients use /auth/register.
 */
export function buildAuthorizationServerMetadata(
  oidcConfig: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const endpoints = proxyOAuthEndpoints(baseUrl)

  return {
    // RFC 8414 §3: the proxy is the AS from the client's view.
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorization_endpoint,
    token_endpoint: endpoints.token_endpoint,
    device_authorization_endpoint: endpoints.device_authorization_endpoint,
    jwks_uri: endpoints.jwks_uri,
    registration_endpoint: endpoints.registration_endpoint,
    revocation_endpoint: endpoints.revocation_endpoint,
    // RFC 9207: required because the MCP callback redirects with `iss`.
    authorization_response_iss_parameter_supported: true,
    client_registration_types_supported: ['dynamic_client_registration'],
    ...proxyOAuthCapabilities(oidcConfig),
  }
}
