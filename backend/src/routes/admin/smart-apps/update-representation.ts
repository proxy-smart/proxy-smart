// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Keycloak's PUT takes a complete client: an absent field keeps the stored value, an empty string clears it.

import { federatedJwtAttributes, toKeycloakAuthType } from '@/lib/auth-method-mapping'
import type { UpdateSmartAppRequestType } from '@/schemas'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { homeUrlToStore } from '@/lib/client-home-url'
import { config } from '@/config'
import { ACCESS_TOKEN_LIFESPAN_ATTRIBUTE, PKCE_METHOD_ATTRIBUTE, descriptiveAttributes, grantsFor, passthroughAttributes, resolveClientType, withProxyCallback } from './client-config'
import { resourceServerAttribute } from '@/lib/resource-server-exchange'
import { appStateAttributes } from '@/lib/app-state/registration'
import { MASKED_SECRET } from '@/lib/secret-mask'
import { keyMaterialAttributes } from './key-material'

export function buildUpdateRepresentation(
  body: UpdateSmartAppRequestType,
  existing: ClientRepresentation,
): ClientRepresentation {
  const effectiveClientType = body.clientType
    ?? resolveClientType(body, existing.publicClient)

  // Keycloak verifies every private_key_jwt client's proxy-signed assertions through the signing IdP.
  const usesAssertionAuth = (
    body.tokenEndpointAuthMethod === 'private_key_jwt'
    || effectiveClientType === 'backend-service'
    || existing.serviceAccountsEnabled
  ) && Boolean(
    body.jwksUri || body.publicKey || body.jwksString
    || existing.attributes?.['use.jwks.url'] === 'true'
    || existing.attributes?.['use.jwks.string'] === 'true',
  )

  const grants = effectiveClientType === undefined ? undefined : grantsFor(effectiveClientType, {
    appType: body.appType ?? existing.attributes?.['client_type'],
    serviceAccount: body.serviceAccountsEnabled,
  })
  // A client turned into a backend service gets the short Backend Services lifetime unless one is set.
  const becomesBackendService = grants?.serviceAccountsEnabled === true
    && existing.attributes?.[ACCESS_TOKEN_LIFESPAN_ATTRIBUTE] === undefined
  const accessTokenLifespan = body.accessTokenLifespan
    ?? (becomesBackendService ? config.smart.backendServiceTokenLifespanSeconds : undefined)

  return {
    clientId: existing.clientId,
    name: body.name ?? existing.name,
    description: body.description ?? existing.description,
    enabled: body.enabled ?? existing.enabled,
    publicClient: existing.publicClient,
    standardFlowEnabled: existing.standardFlowEnabled,
    serviceAccountsEnabled: existing.serviceAccountsEnabled,
    directAccessGrantsEnabled: existing.directAccessGrantsEnabled,
    implicitFlowEnabled: existing.implicitFlowEnabled,
    // The mask comes back from our own reads; storing it would replace the real secret.
    ...(body.secret && body.secret !== MASKED_SECRET && !existing.publicClient && { secret: body.secret }),
    redirectUris: withProxyCallback(
      body.redirectUris ?? existing.redirectUris ?? [],
      existing.standardFlowEnabled === false,
    ),
    // An explicit homeUrl wins; otherwise a usable stored one is kept and a missing one derived.
    baseUrl: homeUrlToStore(body.homeUrl, existing.baseUrl, {
      launchUrl: body.launchUrl ?? existing.attributes?.['launch_url'],
      redirectUris: body.redirectUris ?? existing.redirectUris,
    }),
    webOrigins: body.webOrigins ?? existing.webOrigins,
    attributes: {
      ...existing.attributes,
      ...(body.appType && { 'client_type': body.appType }),
      // Keycloak 25+ requires an explicit post-logout redirect URI config.
      'post.logout.redirect.uris': existing.attributes?.['post.logout.redirect.uris'] || '+',
      ...descriptiveAttributes(body, { keepEmpty: true }),
      ...(body.tokenExchangeEnabled !== undefined && { 'standard.token.exchange.enabled': String(body.tokenExchangeEnabled) }),
      ...(body.resourceServer !== undefined && existing.clientId && resourceServerAttribute(existing.clientId, body.resourceServer)),
      ...(accessTokenLifespan !== undefined && { [ACCESS_TOKEN_LIFESPAN_ATTRIBUTE]: String(accessTokenLifespan) }),
      // Empty clears the requirement, which Keycloak reads as PKCE not enforced.
      ...(body.requirePkce !== undefined && { [PKCE_METHOD_ATTRIBUTE]: body.requirePkce ? 'S256' : '' }),
      ...passthroughAttributes(body),
      ...appStateAttributes(body),
      ...keyMaterialAttributes({
        jwksUri: body.jwksUri,
        jwksString: body.jwksString,
        publicKeyPem: body.publicKey,
        signingAlg: body.tokenEndpointAuthSigningAlg,
      }),
      ...(usesAssertionAuth && existing.clientId && federatedJwtAttributes(existing.clientId)),
    },
    ...(body.consentRequired !== undefined && { consentRequired: body.consentRequired }),
    ...(body.fullScopeAllowed !== undefined && { fullScopeAllowed: body.fullScopeAllowed }),
    ...(body.frontChannelLogoutUrl !== undefined && { frontchannelLogout: !!body.frontChannelLogoutUrl }),
    ...grants,
    ...(effectiveClientType === undefined && body.serviceAccountsEnabled !== undefined && {
      serviceAccountsEnabled: body.serviceAccountsEnabled && !existing.publicClient,
    }),
    ...(body.tokenEndpointAuthMethod !== undefined && {
      clientAuthenticatorType: toKeycloakAuthType(
        body.tokenEndpointAuthMethod,
        effectiveClientType === 'backend-service' || !!existing.serviceAccountsEnabled,
      ),
    }),
  }
}
