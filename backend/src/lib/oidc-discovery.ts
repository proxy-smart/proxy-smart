// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Proxy OIDC / OAuth discovery sanitizer.
 *
 * Keycloak's `/.well-known/openid-configuration` advertises endpoints that point
 * straight at Keycloak (`.../realms/<realm>/protocol/openid-connect/...`) plus an
 * `mtls_endpoint_aliases` object with mTLS-bound variants. When the proxy mirrors
 * that document it MUST NOT leak those Keycloak-direct URLs: a client (or an mTLS
 * client) that reads them would bypass the proxy's auth layer entirely (SMART
 * launch-context enrichment, Backend Services JWT validation, audience binding).
 *
 * This module is the single source of truth for turning Keycloak's discovery doc
 * into a proxy-safe one. Every spread-based discovery handler funnels through
 * {@link sanitizeDiscoveryDocument} so the rewrite/strip rules stay DRY and
 * consistent across all variants.
 */

import { config } from '../config'
import { KEYCLOAK_BUILTIN_DEFAULT_SCOPES } from './oauth-scopes'
import { RESOURCE_INDICATORS_SCOPE } from './smart-client-enrichment'
import { TOKEN_EXCHANGE_GRANT } from './token-actor'
import { stringArray } from './type-guards'

/** Marker that identifies a Keycloak-direct OpenID Connect endpoint URL. */
const KEYCLOAK_DIRECT_MARKER = '/protocol/openid-connect/'

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * What a client can use THROUGH the proxy, which every discovery document intersects with what
 * Keycloak declares. Keycloak's own lists name flows the proxy never carries: implicit and hybrid
 * responses bypass the code-for-token step where launch context is added, password and CIBA have
 * no proxy route, and tls_client_auth / client_secret_jwt cannot survive the proxy re-signing
 * client assertions.
 */
export const PROXY_OAUTH_SUPPORT = {
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials', TOKEN_EXCHANGE_GRANT, DEVICE_CODE_GRANT],
  responseTypes: ['code'],
  confidentialClientAuthMethods: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
  /** The proxy verifies client assertions itself, so these are its algorithms, not Keycloak's. */
  get clientAssertionSigningAlgs(): string[] {
    return config.smart.clientAssertionAlgorithms
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
 * Endpoint keys the proxy actually fronts with a dedicated `/auth/*` route.
 * Each is rewritten to the proxy origin so clients transit the proxy.
 *
 * `issuer` is here too, and it is the load-bearing one. Every caller serves this
 * document FROM the proxy origin, and RFC 8414 §3.3 requires a metadata document's
 * `issuer` to match the URL it was retrieved from. Passing Keycloak's realm issuer
 * straight through — which is what happened while only the endpoints were
 * rewritten — published a document that asserts Keycloak's identity while
 * advertising the proxy's endpoints. A client that enforces §3.3 should reject it
 * outright, and one that does not gets an issuer it will later compare the RFC 9207
 * `iss` against, which the proxy (not Keycloak) now sends.
 *
 * This does NOT change who mints tokens. Keycloak still does, and its tokens still
 * carry its own `iss`; access tokens are opaque to OAuth clients, and RFC 9207
 * constrains the authorization RESPONSE, not the token. Consumers that genuinely
 * need Keycloak's OIDC identity — SMART apps validating an id_token — read it from
 * `.well-known/smart-configuration` or the realm's own discovery document, both of
 * which still advertise the realm issuer.
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
    // RP-Initiated Logout is fronted by the proxy's /auth/logout route, which
    // proxies the Keycloak end-session call server-side.
    end_session_endpoint: `${baseUrl}/auth/logout`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
  } satisfies Record<string, string>
}

/**
 * Keys to remove outright because the proxy does NOT front them. Advertising
 * Keycloak's own URL for these would be a bypass, and the proxy has no route to
 * rewrite them to — so they are dropped rather than leaked.
 *
 *  - mtls_endpoint_aliases: nested object of mTLS-bound Keycloak endpoints. The
 *    proxy does not front mTLS-bound endpoints at all.
 *  - pushed_authorization_request_endpoint / backchannel_authentication_endpoint:
 *    no corresponding proxy route exists.
 */
const UNSUPPORTED_LEAK_KEYS = [
  'mtls_endpoint_aliases',
  'pushed_authorization_request_endpoint',
  'backchannel_authentication_endpoint',
] as const

/**
 * Produce a proxy-safe discovery document from Keycloak's parsed OIDC config.
 *
 * Rewrites the endpoints the proxy fronts to the proxy origin, removes the
 * unsupported endpoints the proxy cannot front, and then defensively drops ANY
 * remaining top-level value that still points at a Keycloak-direct
 * `/protocol/openid-connect/` URL. The result contains no Keycloak-direct URLs
 * and no `mtls_endpoint_aliases` key.
 *
 * @param oidcConfig Keycloak's parsed `/.well-known/openid-configuration` body.
 * @param baseUrl    Proxy origin (no trailing slash).
 * @returns A new object safe to advertise from the proxy's discovery endpoints.
 */
export function sanitizeDiscoveryDocument(
  oidcConfig: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    ...oidcConfig,
    ...proxyOAuthEndpoints(baseUrl),
  }

  // Drop the endpoints the proxy does not front.
  for (const key of UNSUPPORTED_LEAK_KEYS) {
    delete sanitized[key]
  }

  // Defensive sweep: remove any leftover top-level value that still advertises a
  // Keycloak-direct openid-connect URL (covers fields not enumerated above, e.g.
  // check_session_iframe / frontchannel_logout endpoints Keycloak may add).
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
 * Build the OAuth 2.0 Authorization Server Metadata document (RFC 8414) the proxy
 * advertises, derived from Keycloak's parsed OIDC config.
 *
 * Every discovery path serves the SAME authorization server, so they all build the
 * document here. Three hand-written copies had drifted apart: the path-appending
 * variant omitted `authorization_response_iss_parameter_supported` and
 * `client_registration_types_supported`, while the two under `/.well-known` omitted
 * `client_id_metadata_document_supported` — so an MCP client saw different
 * capabilities depending on which discovery path it resolved first.
 *
 * CIMD is not advertised. The proxy rewrites every intercepted redirect_uri to its own callback,
 * and Keycloak's CIMD executor requires the redirect_uri to match the client's metadata document
 * exactly, so a CIMD client is refused ("Invalid Client Metadata") whatever the realm policy says.
 * MCP clients register through /auth/register instead, which adds the proxy callback.
 *
 * @param oidcConfig Keycloak's parsed `/.well-known/openid-configuration` body.
 * @param baseUrl    Proxy origin (no trailing slash).
 */
export function buildAuthorizationServerMetadata(
  oidcConfig: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const endpoints = proxyOAuthEndpoints(baseUrl)

  return {
    // RFC 8414 3: issuer MUST be the authorization server's URL. The proxy acts as
    // AS from a client's perspective (it owns registration and fronts authorize/token),
    // so this is the proxy origin, not Keycloak's realm issuer.
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorization_endpoint,
    token_endpoint: endpoints.token_endpoint,
    device_authorization_endpoint: endpoints.device_authorization_endpoint,
    jwks_uri: endpoints.jwks_uri,
    registration_endpoint: endpoints.registration_endpoint,
    revocation_endpoint: endpoints.revocation_endpoint,
    // RFC 9207. The proxy intercepts the callback for the MCP resource and redirects
    // with `iss` = this document's `issuer`. Advertising it is REQUIRED of any server
    // that emits it.
    authorization_response_iss_parameter_supported: true,
    client_registration_types_supported: ['dynamic_client_registration'],
    ...proxyOAuthCapabilities(oidcConfig),
  }
}
