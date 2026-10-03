// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * How a registration request maps onto a Keycloak client: which kind of client
 * it is, how it authenticates, and the two URI fields the proxy owns.
 *
 * Create and update both need the appType mapping, and they had it twice.
 */

import { config } from '@/config'
import { toKeycloakAuthType } from '@/lib/auth-method-mapping'
import { DEFAULT_CALLBACK_PATH, resolveClientHomeUrl } from '@proxy-smart/auth'

/** The UI's appType vocabulary, as the request schemas declare it. */
export type AppType = 'agent' | 'backend-service' | 'standalone-app' | 'ehr-launch'
export type ClientType = 'public' | 'confidential' | 'backend-service'

/**
 * Ensure the proxy's own /auth/smart-callback URI is always present in a
 * client's redirectUris. Keycloak validates the redirect_uri at the
 * authorization endpoint, and the proxy rewrites every client's redirect_uri
 * to this callback during the SMART launch flow, so it must be registered.
 * Backend-service clients never use the authorization code flow — skip them.
 */
export function withProxyCallback(redirectUris: string[], isBackendService: boolean): string[] {
  if (isBackendService) return redirectUris
  const proxyCallback = `${config.baseUrl}${DEFAULT_CALLBACK_PATH}`
  return redirectUris.includes(proxyCallback) ? redirectUris : [...redirectUris, proxyCallback]
}

/**
 * The client's Home URL, which Keycloak offers as "Back to application". Admin-created apps carry
 * no RFC 7591 `client_uri`, so their SMART launch URL and redirect origins are what there is.
 */
export function homeUrlFor(
  redirectUris: readonly string[] | undefined,
  launchUrl?: string,
): string | undefined {
  return resolveClientHomeUrl({ launchUrl, redirectUris, proxyBaseUrl: config.baseUrl })
}

/**
 * Resolve the backend clientType from the UI's appType.
 *
 * `publicFallback` decides what a browser app becomes: create reads the
 * request's publicClient flag, update reads what the client already is.
 */
export function resolveClientType(
  input: { appType?: string; clientType?: string },
  publicFallback: boolean | undefined,
): string | undefined {
  if (!input.appType) return input.clientType

  if (input.appType === 'agent' || input.appType === 'backend-service') {
    return 'backend-service'
  }
  if (input.appType === 'standalone-app' || input.appType === 'ehr-launch') {
    return publicFallback ? 'public' : 'confidential'
  }
  return input.clientType
}

/**
 * The Keycloak clientAuthenticatorType for a new client.
 *
 * federated-jwt everywhere a client authenticates with an assertion: the proxy
 * validates the client's JWT, re-signs it with its own key, and Keycloak
 * verifies that through the proxy-smart-signing IdP.
 */
export function resolveAuthenticatorType(input: {
  tokenEndpointAuthMethod?: string
  isBackendService: boolean
  isPublicClient: boolean
  hasKeyMaterial: boolean
}): string {
  if (input.tokenEndpointAuthMethod) {
    return toKeycloakAuthType(input.tokenEndpointAuthMethod, input.isBackendService)
  }
  if (input.isBackendService) return 'federated-jwt'
  if (input.isPublicClient) return 'none'
  return input.hasKeyMaterial ? 'federated-jwt' : 'client-secret'
}
