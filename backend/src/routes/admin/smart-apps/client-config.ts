// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '@/config'
import { federatedJwtAttributes, toKeycloakAuthType } from '@/lib/auth-method-mapping'
import { DEFAULT_CALLBACK_PATH } from '@proxy-smart/auth'

export type AppType = 'agent' | 'backend-service' | 'standalone-app' | 'ehr-launch'
export type ClientType = 'public' | 'confidential' | 'backend-service'

// The proxy rewrites redirect_uri to its own callback during SMART launch, so Keycloak must know it.
export function withProxyCallback(redirectUris: string[], isBackendService: boolean): string[] {
  if (isBackendService) return redirectUris
  const proxyCallback = `${config.baseUrl}${DEFAULT_CALLBACK_PATH}`
  return redirectUris.includes(proxyCallback) ? redirectUris : [...redirectUris, proxyCallback]
}

/** `publicFallback`: create passes the request's publicClient flag, update the client's current one. */
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

/** Agents act for a user via RFC 8693 exchange (`act` claim); backend services act as themselves. */
export function isAgent(appType: string | undefined): boolean {
  return appType === 'agent'
}

// Agents get no client_credentials: they never hold a token without a user behind it.
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

/** Shared by the admin API and dynamic registration so the two cannot drift. */
export function clientSecurityAttributes(policy: ClientSecurityPolicy): Record<string, string> {
  const lifespan = policy.accessTokenLifespan
    ?? (policy.serviceAccountsEnabled ? config.smart.backendServiceTokenLifespanSeconds : undefined)
  return {
    ...(policy.clientAuthenticatorType === 'federated-jwt' && federatedJwtAttributes(policy.clientId)),
    ...(policy.standardFlowEnabled && policy.requirePkce !== false && { [PKCE_METHOD_ATTRIBUTE]: 'S256' }),
    ...(lifespan !== undefined && { [ACCESS_TOKEN_LIFESPAN_ATTRIBUTE]: String(lifespan) }),
  }
}
