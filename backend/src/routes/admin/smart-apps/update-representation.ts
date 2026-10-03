// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The Keycloak client representation for an update.
 *
 * Keycloak's PUT expects a complete representation, so every field falls back
 * to what the client already has; an absent field means "leave it", and an
 * empty string means "clear it". That is why the conditions here test
 * `!== undefined` where the create path tests truthiness.
 */

import { toKeycloakAuthType } from '@/lib/auth-method-mapping'
import type { UpdateSmartAppRequestType } from '@/schemas'
import type ClientRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientRepresentation'
import { homeUrlToStore } from '@/lib/client-home-url'
import { resolveClientType, withProxyCallback } from './client-config'

const csv = (values: string[]): string => values.length > 0 ? values.join(',') : ''

export function buildUpdateRepresentation(
  body: UpdateSmartAppRequestType,
  existing: ClientRepresentation,
): ClientRepresentation {
  const effectiveClientType = body.clientType
    ?? resolveClientType(body, existing.publicClient)

  /*
   * Set for ALL clients using private_key_jwt (user-facing and backend
   * services): Keycloak verifies proxy-signed assertions through the
   * proxy-smart-signing IdP.
   */
  const usesAssertionAuth = (
    body.tokenEndpointAuthMethod === 'private_key_jwt'
    || effectiveClientType === 'backend-service'
    || existing.serviceAccountsEnabled
  ) && Boolean(
    body.jwksUri || body.publicKey || body.jwksString
    || existing.attributes?.['use.jwks.url'] === 'true'
    || existing.attributes?.['use.jwks.string'] === 'true',
  )

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
    // Update client secret when provided (confidential clients only)
    ...(body.secret && !existing.publicClient && { secret: body.secret }),
    redirectUris: withProxyCallback(
      body.redirectUris ?? existing.redirectUris ?? [],
      existing.serviceAccountsEnabled === true && !existing.standardFlowEnabled,
    ),
    // An explicit homeUrl wins; otherwise a usable stored one is kept and a missing one derived.
    baseUrl: homeUrlToStore(body.homeUrl, existing.baseUrl, {
      launchUrl: body.launchUrl ?? existing.attributes?.['launch_url'],
      redirectUris: body.redirectUris ?? existing.redirectUris,
    }),
    webOrigins: body.webOrigins ?? existing.webOrigins,
    attributes: {
      ...existing.attributes,
      // Store appType as client_type attribute
      ...(body.appType && { 'client_type': body.appType }),
      // Keycloak 25+ requires explicit post-logout redirect URI config
      'post.logout.redirect.uris': existing.attributes?.['post.logout.redirect.uris'] || '+',
      // Plain strings, as the create path writes them. Keycloak's
      // ClientRepresentation.attributes is Map<String,String>, so an array here
      // fails to deserialize and the whole PUT comes back as
      // "Cannot parse the JSON: unknown_error" with no field named.
      ...(body.smartVersion !== undefined && { smart_version: body.smartVersion }),
      ...(body.fhirVersion !== undefined && { fhir_version: body.fhirVersion }),
      // Server access control
      ...(body.serverAccessType !== undefined && { 'server_access_type': body.serverAccessType }),
      ...(body.allowedServerIds !== undefined && { 'allowed_server_ids': csv(body.allowedServerIds) }),
      // Organization assignment
      ...(body.organizationIds !== undefined && { 'organization_ids': csv(body.organizationIds) }),
      // Token exchange (RFC 8693) — Keycloak 26+ standard token exchange V2
      ...(body.tokenExchangeEnabled !== undefined && { 'standard.token.exchange.enabled': String(body.tokenExchangeEnabled) }),
      // Custom access token lifespan (overrides realm default)
      ...(body.accessTokenLifespan !== undefined && { 'access.token.lifespan': String(body.accessTokenLifespan) }),
      // User type & role restrictions
      ...(body.allowedFhirUserTypes !== undefined && { 'allowed_fhir_user_types': csv(body.allowedFhirUserTypes) }),
      ...(body.requiredRoles !== undefined && { 'required_roles': csv(body.requiredRoles) }),
      // fhirUser resolution mode
      // Empty string clears it, matching the other attributes here, and enrichment reads
      // anything that is not 'true'/'false' back as undefined — the passthrough default.
      ...(body.patientFacing !== undefined && {
        'patient_facing': body.patientFacing === null ? '' : String(body.patientFacing),
      }),
      // Metadata fields
      ...(body.launchUrl !== undefined && { 'launch_url': body.launchUrl }),
      ...(body.logoUri !== undefined && { 'logo_uri': body.logoUri }),
      ...(body.tosUri !== undefined && { 'tos_uri': body.tosUri }),
      ...(body.policyUri !== undefined && { 'policy_uri': body.policyUri }),
      ...(body.contacts !== undefined && { 'contacts': csv(body.contacts) }),
      // Session timeout overrides
      ...(body.clientSessionIdleTimeout !== undefined && { 'client.session.idle.timeout': String(body.clientSessionIdleTimeout) }),
      ...(body.clientSessionMaxLifespan !== undefined && { 'client.session.max.lifespan': String(body.clientSessionMaxLifespan) }),
      // Logout settings
      ...(body.backchannelLogoutUrl !== undefined && { 'backchannel.logout.url': body.backchannelLogoutUrl || '' }),
      ...(body.frontChannelLogoutUrl !== undefined && { 'frontchannel.logout.url': body.frontChannelLogoutUrl || '' }),
      ...(usesAssertionAuth && {
        'jwt.credential.issuer': 'proxy-smart-signing',
        'jwt.credential.sub': existing.clientId,
      }),
    },
    // Consent & scope settings (top-level Keycloak properties)
    ...(body.consentRequired !== undefined && { consentRequired: body.consentRequired }),
    ...(body.fullScopeAllowed !== undefined && { fullScopeAllowed: body.fullScopeAllowed }),
    // Front-channel logout top-level flag
    ...(body.frontChannelLogoutUrl !== undefined && { frontchannelLogout: !!body.frontChannelLogoutUrl }),
    // Client type changes affect serviceAccountsEnabled + standardFlowEnabled + publicClient
    ...(effectiveClientType !== undefined && {
      publicClient: effectiveClientType === 'public',
      serviceAccountsEnabled: effectiveClientType === 'backend-service',
      standardFlowEnabled: effectiveClientType !== 'backend-service',
    }),
    // Token endpoint auth method → Keycloak clientAuthenticatorType
    ...(body.tokenEndpointAuthMethod !== undefined && {
      clientAuthenticatorType: toKeycloakAuthType(
        body.tokenEndpointAuthMethod,
        effectiveClientType === 'backend-service' || !!existing.serviceAccountsEnabled,
      ),
    }),
  }
}
