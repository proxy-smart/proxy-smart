// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The Keycloak client representation for a new SMART app, and the two things
 * worth refusing before we create one.
 */

import type { CreateSmartAppRequestType } from '@/schemas'
import {
  homeUrlFor,
  resolveAuthenticatorType,
  resolveClientType,
  withProxyCallback,
} from './client-config'

export interface CreatePlan {
  representation: Record<string, unknown>
  isBackendService: boolean
  clientAuthenticatorType: string
  /** Stated explicitly because nothing fetches a jwksUri to discover it. */
  signingAlg: string
}

/**
 * Reasons not to attempt the create at all.
 *
 * A scope cannot be both default and optional on one client — Keycloak refuses the second
 * assignment with `unknown_error` and "consult the server log", naming neither the scope nor
 * the reason, and the client is left half-created. Say which scopes overlap instead.
 */
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

  return null
}

export function buildCreatePlan(body: CreateSmartAppRequestType): CreatePlan {
  const effectiveClientType = resolveClientType(body, body.publicClient)

  const isBackendService = effectiveClientType === 'backend-service'
  // Backend-service clients are always confidential (service accounts require it)
  const isPublicClient = isBackendService ? false : (body.publicClient ?? effectiveClientType === 'public')

  const clientAuthenticatorType = resolveAuthenticatorType({
    tokenEndpointAuthMethod: body.tokenEndpointAuthMethod,
    isBackendService,
    isPublicClient,
    hasKeyMaterial: Boolean(body.jwksUri || body.publicKey || body.jwksString),
  })

  /*
   * The algorithm the client signs assertions with. An inline JWKS carries its own `alg`, but a
   * jwksUri is never fetched, so the caller has to say — and defaulting silently to RS384 gave
   * an ES384 client a Keycloak config that rejects every assertion it sends.
   */
  const signingAlg = body.tokenEndpointAuthSigningAlg || 'RS384'

  const storesJwks = isBackendService || clientAuthenticatorType === 'federated-jwt'
  const homeUrl = homeUrlFor(body.redirectUris, body.launchUrl)

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
      ...(body.smartVersion && { 'smart_version': body.smartVersion }),
      ...(body.fhirVersion && { 'fhir_version': body.fhirVersion }),
      // Store the original UI appType as client_type attribute
      ...(body.appType && { 'client_type': body.appType }),
      // If no appType, fallback to clientType
      ...(!body.appType && isBackendService && { 'client_type': 'backend-service' }),

      // Store JWKS info for JWT authentication (proxy-side validation for backend
      // services, or stored for proxy-side validation on federated-jwt clients)
      ...(body.jwksUri && storesJwks && {
        'use.jwks.url': 'true',
        'jwks.url': body.jwksUri,
      }),
      // Inline JWKS string (alternative to jwksUri)
      ...(body.jwksString && !body.jwksUri && storesJwks && {
        'use.jwks.string': 'true',
        'jwks.string': body.jwksString,
      }),

      // Federated-jwt: KC verifies proxy-signed assertions via the IdP
      ...(clientAuthenticatorType === 'federated-jwt' && {
        'jwt.credential.issuer': 'proxy-smart-signing',
        'jwt.credential.sub': body.clientId,
      }),

      // Metadata fields
      ...(body.launchUrl && { 'launch_url': body.launchUrl }),
      ...(body.logoUri && { 'logo_uri': body.logoUri }),
      ...(body.tosUri && { 'tos_uri': body.tosUri }),
      ...(body.policyUri && { 'policy_uri': body.policyUri }),
      ...(body.contacts && body.contacts.length > 0 && { 'contacts': body.contacts.join(',') }),

      // Server access control
      ...(body.serverAccessType && { 'server_access_type': body.serverAccessType }),
      ...(body.allowedServerIds && body.allowedServerIds.length > 0 && {
        'allowed_server_ids': body.allowedServerIds.join(','),
      }),

      // Organization assignment
      ...(body.organizationIds && body.organizationIds.length > 0 && {
        'organization_ids': body.organizationIds.join(','),
      }),

      // Scope set reference
      ...(body.scopeSetId && { 'scope_set_id': body.scopeSetId }),

      // PKCE configuration
      ...(body.requirePkce && { 'pkce.code.challenge.method': 'S256' }),

      // Token exchange (RFC 8693) — Keycloak 26+ standard token exchange V2
      ...(body.tokenExchangeEnabled !== undefined && { 'standard.token.exchange.enabled': String(body.tokenExchangeEnabled) }),

      // Custom access token lifespan (overrides realm default)
      ...(body.accessTokenLifespan && { 'access.token.lifespan': String(body.accessTokenLifespan) }),

      // User type & role restrictions
      ...(body.allowedFhirUserTypes && body.allowedFhirUserTypes.length > 0 && {
        'allowed_fhir_user_types': body.allowedFhirUserTypes.join(','),
      }),
      ...(body.requiredRoles && body.requiredRoles.length > 0 && {
        'required_roles': body.requiredRoles.join(','),
      }),

      // fhirUser resolution mode
      // Empty string clears it, matching the other attributes here, and enrichment reads
      // anything that is not 'true'/'false' back as undefined — the passthrough default.
      ...(body.patientFacing !== undefined && {
        'patient_facing': body.patientFacing === null ? '' : String(body.patientFacing),
      }),

      // Session timeout overrides
      ...(body.clientSessionIdleTimeout !== undefined && { 'client.session.idle.timeout': String(body.clientSessionIdleTimeout) }),
      ...(body.clientSessionMaxLifespan !== undefined && { 'client.session.max.lifespan': String(body.clientSessionMaxLifespan) }),

      // Logout settings
      ...(body.backchannelLogoutUrl && { 'backchannel.logout.url': body.backchannelLogoutUrl }),
      ...(body.frontChannelLogoutUrl && { 'frontchannel.logout.url': body.frontChannelLogoutUrl }),

      // Keycloak 25+ requires explicit post-logout redirect URI config
      'post.logout.redirect.uris': '+',
    },
    clientAuthenticatorType,

    // Consent & scope settings
    ...(body.consentRequired !== undefined && { consentRequired: body.consentRequired }),
    ...(body.fullScopeAllowed !== undefined && { fullScopeAllowed: body.fullScopeAllowed }),

    // Front-channel logout top-level flag
    ...(body.frontChannelLogoutUrl && { frontchannelLogout: true }),

    // Pass explicit client secret when provided (confidential clients only)
    ...(body.secret && clientAuthenticatorType === 'client-secret' && { secret: body.secret }),

    standardFlowEnabled: !isBackendService, // Authorization code flow
    implicitFlowEnabled: false, // Not recommended for SMART
    directAccessGrantsEnabled: false, // Not used in SMART
    serviceAccountsEnabled: isBackendService, // Enable for client_credentials

    // Scopes are assigned after creation, by name
    defaultClientScopes: [],
    optionalClientScopes: [],
  }

  return { representation, isBackendService, clientAuthenticatorType, signingAlg }
}
