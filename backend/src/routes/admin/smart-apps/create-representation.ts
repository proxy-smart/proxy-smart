// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/** The Keycloak client representation for a new SMART app, and what to refuse before creating one. */

import type { CreateSmartAppRequestType } from '@/schemas'
import {
  clientSecurityAttributes,
  descriptiveAttributes,
  grantsFor,
  isAgent,
  passthroughAttributes,
  resolveAuthenticatorType,
  resolveClientType,
  withProxyCallback,
} from './client-config'
import { homeUrlToStore } from '@/lib/client-home-url'
import { resourceServerAttribute, resourceServerRejection } from '@/lib/resource-server-exchange'
import { appStateAttributes } from '@/lib/app-state/registration'

export interface CreatePlan {
  representation: Record<string, unknown>
  isBackendService: boolean
  clientAuthenticatorType: string
  /** Stated explicitly because nothing fetches a jwksUri to discover it. */
  signingAlg: string
}

/** Keycloak answers a scope that is both default and optional with an opaque unknown_error and a half-created client. */
export function validateCreateRequest(body: CreateSmartAppRequestType): string | null {
  const overlappingScopes = (body.defaultClientScopes || []).filter((scope) =>
    [...(body.optionalClientScopes || []), ...(body.systemScopes || [])].includes(scope),
  )
  if (overlappingScopes.length > 0) {
    return `These scopes are listed as both default and optional: ${overlappingScopes.join(', ')}. `
      + 'A scope may be one or the other, not both.'
  }

  const isBackendService = resolveClientType(body, body.publicClient) === 'backend-service'
  if (isBackendService && !body.publicKey && !body.jwksUri && !body.jwksString) {
    return 'Backend Services clients require publicKey, jwksUri, or jwksString for JWT authentication'
  }

  if (body.resourceServer) {
    const rejection = resourceServerRejection(body.clientId)
    if (rejection) return rejection
  }

  return null
}

export function buildCreatePlan(body: CreateSmartAppRequestType): CreatePlan {
  const effectiveClientType = resolveClientType(body, body.publicClient)

  const isBackendService = effectiveClientType === 'backend-service'
  const isPublicClient = isBackendService ? false : (body.publicClient ?? effectiveClientType === 'public')
  const grants = grantsFor(effectiveClientType, { appType: body.appType, serviceAccount: body.serviceAccountsEnabled })
  // An agent exists to exchange the tokens it is handed, so it gets the grant unless told otherwise.
  const tokenExchange = body.tokenExchangeEnabled ?? (isAgent(body.appType) ? true : undefined)

  const clientAuthenticatorType = resolveAuthenticatorType({
    tokenEndpointAuthMethod: body.tokenEndpointAuthMethod,
    isBackendService,
    isPublicClient,
    hasKeyMaterial: Boolean(body.jwksUri || body.publicKey || body.jwksString),
  })

  // A jwksUri is never fetched, so its signing algorithm cannot be detected.
  const signingAlg = body.tokenEndpointAuthSigningAlg || 'RS384'

  const storesJwks = isBackendService || clientAuthenticatorType === 'federated-jwt'
  const homeUrl = homeUrlToStore(body.homeUrl, undefined, { launchUrl: body.launchUrl, redirectUris: body.redirectUris })

  const representation = {
    clientId: body.clientId,
    name: body.name,
    ...(body.description && { description: body.description }),
    enabled: true,
    protocol: 'openid-connect',
    publicClient: isPublicClient,
    redirectUris: withProxyCallback(body.redirectUris || [], isBackendService),
    ...(homeUrl && { baseUrl: homeUrl }),
    webOrigins: body.webOrigins || [],
    attributes: {
      'smart_app': 'true',
      ...descriptiveAttributes(body, { keepEmpty: false }),
      ...(body.appType && { 'client_type': body.appType }),
      ...(!body.appType && isBackendService && { 'client_type': 'backend-service' }),

      ...(body.jwksUri && storesJwks && {
        'use.jwks.url': 'true',
        'jwks.url': body.jwksUri,
      }),
      ...(body.jwksString && !body.jwksUri && storesJwks && {
        'use.jwks.string': 'true',
        'jwks.string': body.jwksString,
      }),

      ...(tokenExchange !== undefined && { 'standard.token.exchange.enabled': String(tokenExchange) }),
      ...(body.resourceServer && resourceServerAttribute(body.clientId, true)),

      ...clientSecurityAttributes({
        clientId: body.clientId,
        clientAuthenticatorType,
        standardFlowEnabled: grants.standardFlowEnabled,
        serviceAccountsEnabled: grants.serviceAccountsEnabled,
        accessTokenLifespan: body.accessTokenLifespan || undefined,
        requirePkce: body.requirePkce,
      }),

      ...passthroughAttributes(body),
      ...appStateAttributes(body),
      'post.logout.redirect.uris': '+',
    },
    clientAuthenticatorType,

    ...(body.consentRequired !== undefined && { consentRequired: body.consentRequired }),
    ...(body.fullScopeAllowed !== undefined && { fullScopeAllowed: body.fullScopeAllowed }),

    ...(body.frontChannelLogoutUrl && { frontchannelLogout: true }),

    ...(body.secret && clientAuthenticatorType === 'client-secret' && { secret: body.secret }),

    standardFlowEnabled: grants.standardFlowEnabled,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: grants.serviceAccountsEnabled,

    defaultClientScopes: [],
    optionalClientScopes: [],
  }

  return { representation, isBackendService, clientAuthenticatorType, signingAlg }
}
