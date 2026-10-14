// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * How a registration request maps onto a Keycloak client: which kind of client
 * it is, how it authenticates, and the two URI fields the proxy owns.
 *
 * Create and update both need the appType mapping, and they had it twice.
 */

import { config } from '@/config'
import { federatedJwtAttributes, toKeycloakAuthType } from '@/lib/auth-method-mapping'
import { DEFAULT_CALLBACK_PATH } from '@proxy-smart/auth'

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

export interface ClientGrants {
  publicClient: boolean
  standardFlowEnabled: boolean
  serviceAccountsEnabled: boolean
}

/**
 * An agent acts for a signed-in user: it exchanges the token it is handed (RFC 8693) and is
 * recorded as the actor (`act`) while `sub` stays the user. A backend service acts as itself.
 */
export function isAgent(appType: string | undefined): boolean {
  return appType === 'agent'
}

/**
 * The flows a client may use. Backend services and agents never log a user in. Only a
 * backend service, which acts as itself, gets client_credentials: an agent never holds a
 * token without a user behind it. An explicit `serviceAccount` wins either way.
 */
export function grantsFor(
  clientType: string | undefined,
  options: { appType?: string; serviceAccount?: boolean } = {},
): ClientGrants {
  const confidentialService = clientType === 'backend-service'
  return {
    publicClient: clientType === 'public',
    standardFlowEnabled: !confidentialService,
    serviceAccountsEnabled: confidentialService && (options.serviceAccount ?? !isAgent(options.appType)),
  }
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

export const PKCE_METHOD_ATTRIBUTE = 'pkce.code.challenge.method'
export const ACCESS_TOKEN_LIFESPAN_ATTRIBUTE = 'access.token.lifespan'

export interface ClientSecurityPolicy {
  clientId: string
  clientAuthenticatorType: string
  standardFlowEnabled: boolean
  serviceAccountsEnabled: boolean
  accessTokenLifespan?: number
  /** Undefined means the default: S256 for every client that runs the authorization code flow. */
  requirePkce?: boolean
}

/**
 * How a new client authenticates, how long its tokens live and whether it must use PKCE.
 * The admin API and dynamic registration both create clients through this, so the two cannot drift.
 */
export function clientSecurityAttributes(policy: ClientSecurityPolicy): Record<string, string> {
  const lifespan = policy.accessTokenLifespan
    ?? (policy.serviceAccountsEnabled ? config.smart.backendServiceTokenLifespanSeconds : undefined)
  return {
    ...(policy.clientAuthenticatorType === 'federated-jwt' && federatedJwtAttributes(policy.clientId)),
    ...(policy.standardFlowEnabled && policy.requirePkce !== false && { [PKCE_METHOD_ATTRIBUTE]: 'S256' }),
    ...(lifespan !== undefined && { [ACCESS_TOKEN_LIFESPAN_ATTRIBUTE]: String(lifespan) }),
  }
}
