// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * The Keycloak identity-provider `config` map. Open (`additionalProperties`) because Elysia strips
 * undeclared body keys, and every provider type has keys of its own; the named ones are documentation.
 */
export const IdentityProviderConfig = t.Object({
  // ── OIDC / OAuth2 ──
  clientId: t.Optional(t.String({ description: 'OAuth2 client id issued by the provider. REQUIRED for oidc, oauth2, keycloak-oidc and the social providers.' })),
  clientSecret: t.Optional(t.String({ description: 'OAuth2 client secret. REQUIRED for oidc, oauth2, keycloak-oidc and the social providers. Reads return the mask "**********"; an update may send the mask back only while clientId, clientAuthMethod, tokenUrl, tokenIntrospectionUrl, baseUrl, tenantId and sandbox stay unchanged, otherwise the secret must be sent again.' })),
  authorizationUrl: t.Optional(t.String({ description: "The provider's authorization endpoint URL. REQUIRED for oidc, oauth2 and keycloak-oidc." })),
  tokenUrl: t.Optional(t.String({ description: "The provider's token endpoint URL. REQUIRED for oidc, oauth2 and keycloak-oidc." })),
  userInfoUrl: t.Optional(t.String({ description: 'UserInfo endpoint URL' })),
  issuer: t.Optional(t.String({ description: 'OIDC issuer URL, validated against the id token iss claim' })),
  defaultScopes: t.Optional(t.String({ description: 'Space-separated OAuth2 scopes to request (e.g. "openid profile email")' })),
  logoutUrl: t.Optional(t.String({ description: 'Logout endpoint URL' })),
  clientAuthMethod: t.Optional(t.String({ description: 'Client authentication method (client_secret_post, client_secret_basic, client_secret_jwt, private_key_jwt)' })),
  validateSignature: t.Optional(t.Boolean({ description: 'Validate signatures on tokens/assertions from this provider' })),
  useJwksUrl: t.Optional(t.Boolean({ description: 'Fetch the signing keys from jwksUrl rather than using a static certificate' })),
  jwksUrl: t.Optional(t.String({ description: "The provider's JWKS URL, used when useJwksUrl is true" })),
  pkceEnabled: t.Optional(t.Boolean({ description: 'Send a PKCE challenge on the authorization request' })),
  pkceMethod: t.Optional(t.String({ description: 'PKCE code challenge method (S256 or plain)' })),
  syncMode: t.Optional(t.String({ description: 'How brokered user data is synced on later logins: IMPORT, LEGACY or FORCE' })),
  allowAdminRoleMapping: t.Optional(t.Boolean({ description: "Let this provider's mappers grant admin roles or admin groups (Keycloak 26.8+, default false). Only a caller holding realm-management manage-realm may change it" })),

  // ── SAML ──
  entityId: t.Optional(t.String({ description: 'SAML entity ID' })),
  singleSignOnServiceUrl: t.Optional(t.String({ description: 'SAML SSO URL. REQUIRED for saml.' })),
  singleLogoutServiceUrl: t.Optional(t.String({ description: 'SAML SLO URL' })),
  metadataDescriptorUrl: t.Optional(t.String({ description: 'SAML metadata URL' })),
  signatureAlgorithm: t.Optional(t.String({ description: 'SAML signature algorithm' })),
  nameIdPolicyFormat: t.Optional(t.String({ description: 'SAML NameID format' })),
  signingCertificate: t.Optional(t.String({ description: 'SAML signing certificate' })),
  wantAuthnRequestsSigned: t.Optional(t.Boolean({ description: 'Require signed AuthN requests' })),

  // ── Kept for the admin UI, which writes it alongside the real keys ──
  displayName: t.Optional(t.String({ description: 'Display name for UI' })),
}, {
  title: 'IdentityProviderConfig',
  // Keycloak stores strings and coerces booleans and numbers.
  additionalProperties: t.Union([t.String(), t.Boolean(), t.Number()]),
})

export const IdentityProvider = t.Object({
  alias: t.Optional(t.String({ description: 'Provider alias (unique identifier)' })),
  providerId: t.Optional(t.String({ description: 'Provider type (oidc, saml, etc.)' })),
  displayName: t.Optional(t.String({ description: 'Display name' })),
  enabled: t.Optional(t.Boolean({ description: 'Whether the provider is enabled' })),
  config: t.Optional(t.Record(t.String(), t.Any({ description: 'Provider configuration' }))),
  addReadTokenRoleOnCreate: t.Optional(t.Boolean()),
  firstBrokerLoginFlowAlias: t.Optional(t.String()),
  internalId: t.Optional(t.String()),
  linkOnly: t.Optional(t.Boolean()),
  hideOnLogin: t.Optional(t.Boolean()),
  postBrokerLoginFlowAlias: t.Optional(t.String()),
  storeToken: t.Optional(t.Boolean()),
  trustEmail: t.Optional(t.Boolean()),
  organizationIds: t.Optional(t.Array(t.String())),
  organizationId: t.Optional(t.String())
}, { title: 'IdentityProvider' })

export const CreateIdentityProviderRequest = t.Object({
  alias: t.String({ description: 'Provider alias (unique identifier)' }),
  providerId: t.String({ description: 'Provider type (oidc, saml, etc.)' }),
  displayName: t.Optional(t.String({ description: 'Display name for UI' })),
  enabled: t.Optional(t.Boolean({ description: 'Whether to enable the provider', default: true })),
  config: IdentityProviderConfig,
  // Identity linking / broker flow settings
  firstBrokerLoginFlowAlias: t.Optional(t.String({ description: 'Authentication flow for first broker login (e.g. "first broker login")' })),
  postBrokerLoginFlowAlias: t.Optional(t.String({ description: 'Authentication flow to run after broker login' })),
  trustEmail: t.Optional(t.Boolean({ description: 'Trust email provided by this identity provider for automatic account linking' })),
  linkOnly: t.Optional(t.Boolean({ description: 'If true, users cannot log in through this provider, only link existing accounts' })),
  hideOnLogin: t.Optional(t.Boolean({ description: 'Hide this provider from the login page' })),
  organizationIds: t.Optional(t.Array(t.String(), { description: 'Keycloak organizations to link this IdP to; users brokered through it join each as managed members. Replaces the current links; an empty list unlinks all' })),
  organizationId: t.Optional(t.String({ description: 'Deprecated: a single organization link. Use organizationIds, which wins when both are sent. An empty string unlinks all' }))
}, { title: 'CreateIdentityProviderRequest' })

export const UpdateIdentityProviderRequest = t.Object({
  displayName: t.Optional(t.String({ description: 'Display name' })),
  enabled: t.Optional(t.Boolean({ description: 'Enable or disable the provider' })),
  config: t.Optional(IdentityProviderConfig),
  // Identity linking / broker flow settings
  firstBrokerLoginFlowAlias: t.Optional(t.String({ description: 'Authentication flow for first broker login (e.g. "first broker login")' })),
  postBrokerLoginFlowAlias: t.Optional(t.String({ description: 'Authentication flow to run after broker login' })),
  trustEmail: t.Optional(t.Boolean({ description: 'Trust email provided by this identity provider for automatic account linking' })),
  linkOnly: t.Optional(t.Boolean({ description: 'If true, users cannot log in through this provider, only link existing accounts' })),
  hideOnLogin: t.Optional(t.Boolean({ description: 'Hide this provider from the login page' })),
  organizationIds: t.Optional(t.Array(t.String(), { description: 'Keycloak organizations to link this IdP to; users brokered through it join each as managed members. Replaces the current links; an empty list unlinks all' })),
  organizationId: t.Optional(t.String({ description: 'Deprecated: a single organization link. Use organizationIds, which wins when both are sent. An empty string unlinks all' }))
}, { title: 'UpdateIdentityProviderRequest' })

// ==================== Response Schemas ====================

export const IdentityProviderResponse = t.Object({
  alias: t.Optional(t.String({ description: 'Provider alias' })),
  providerId: t.Optional(t.String({ description: 'Provider type' })),
  displayName: t.Optional(t.String({ description: 'Display name' })),
  enabled: t.Optional(t.Boolean({ description: 'Whether provider is enabled' })),
  config: t.Optional(t.Record(t.String(), t.Any({ description: 'Provider configuration' }))),
  addReadTokenRoleOnCreate: t.Optional(t.Boolean()),
  firstBrokerLoginFlowAlias: t.Optional(t.String()),
  internalId: t.Optional(t.String()),
  linkOnly: t.Optional(t.Boolean()),
  hideOnLogin: t.Optional(t.Boolean()),
  postBrokerLoginFlowAlias: t.Optional(t.String()),
  storeToken: t.Optional(t.Boolean()),
  trustEmail: t.Optional(t.Boolean()),
  organizationIds: t.Optional(t.Array(t.String(), { description: 'Organizations this IdP is linked to that the caller may view' })),
  organizationId: t.Optional(t.String({ description: 'Deprecated: the first of organizationIds' })),
  userCount: t.Optional(t.Number({ description: 'Number of users linked via this identity provider' }))
}, { title: 'IdentityProviderResponse' })

// ==================== Identity Provider Mappers ====================

/**
 * Claim/assertion mappers attached to an identity provider. These write the
 * custom user attributes (fhirUser, organization) that SMART launches depend
 * on when a user is brokered through an external IdP.
 */

export const IdentityProviderMapperResponse = t.Object({
  id: t.Optional(t.String({ description: 'Keycloak mapper ID' })),
  name: t.String({ description: 'Mapper name' }),
  identityProviderMapper: t.String({ description: 'Keycloak mapper type ID (e.g. oidc-user-attribute-idp-mapper)' }),
  userAttribute: t.Optional(t.String({ description: 'Target Keycloak user attribute' })),
  externalName: t.Optional(t.String({ description: 'Source claim (OIDC) or assertion attribute (SAML)' })),
  syncMode: t.Optional(t.String({ description: 'Sync mode (INHERIT, IMPORT, LEGACY, FORCE)' })),
  config: t.Record(t.String(), t.String(), { description: 'Raw mapper configuration' })
}, { title: 'IdentityProviderMapperResponse' })

export const IdentityProviderMapperDefinition = t.Object({
  name: t.String({ description: 'Mapper name provisioned in Keycloak' }),
  userAttribute: t.String({ description: 'Keycloak user attribute written by this mapper' }),
  externalName: t.String({ description: 'Claim or assertion attribute read from the external identity' }),
  required: t.Boolean({ description: 'Whether a provider is only healthy when this mapper exists' }),
  syncMode: t.String({ description: 'Sync mode used when provisioning' }),
  description: t.String({ description: 'Why this mapper is needed' })
}, { title: 'IdentityProviderMapperDefinition' })

export const IdentityProviderMapperStatus = t.Object({
  alias: t.String({ description: 'Provider alias' }),
  providerId: t.String({ description: 'Provider type' }),
  displayName: t.Optional(t.String({ description: 'Display name' })),
  enabled: t.Boolean({ description: 'Whether the provider is enabled' }),
  attributeMapperType: t.Union([t.String(), t.Null()], {
    description: 'Mapper type used for attribute imports, null when the provider supports none'
  }),
  mappers: t.Array(IdentityProviderMapperResponse, { description: 'Mappers currently attached to the provider' }),
  missingRequired: t.Array(t.String(), { description: 'Names of required mappers that are missing' }),
  missingOptional: t.Array(t.String(), { description: 'Names of optional mappers that are missing' }),
  misconfigured: t.Array(
    t.Object({
      name: t.String({ description: 'Definition the mapper is meant to satisfy' }),
      mapper: t.String({ description: 'Name the mapper carries in Keycloak' }),
      differences: t.Array(t.String(), { description: 'What differs, as "field is X, expected Y"' })
    }),
    { description: 'Mappers that EXIST but do not do what their definition asks — e.g. syncMode IMPORT where FORCE is required, which stops later logins refreshing the attribute' }
  ),
  healthy: t.Boolean({ description: 'Whether all required attribute imports are present AND correctly configured' }),
  unsupported: t.Boolean({ description: 'Whether the provider supports attribute-import mappers at all' }),
  userFacing: t.Boolean({
    description: 'False for machine trust anchors (client-assertion federation), where user attributes do not apply'
  })
}, { title: 'IdentityProviderMapperStatus' })

export const IdentityProviderMapperStatusResponse = t.Object({
  status: t.Array(IdentityProviderMapperStatus),
  definitions: t.Array(IdentityProviderMapperDefinition, {
    description: 'Mappers the proxy expects on every identity provider'
  }),
  timestamp: t.String()
}, { title: 'IdentityProviderMapperStatusResponse' })

export const IdentityProviderMapperFixResponse = t.Object({
  message: t.String(),
  alias: t.String({ description: 'Provider the mappers were provisioned on' }),
  attributeMapperType: t.Union([t.String(), t.Null()], { description: 'Mapper type used for provisioning' }),
  created: t.Array(t.String(), { description: 'Names of mappers created by this call' }),
  repaired: t.Array(t.String(), { description: 'Names of mappers that existed but were corrected in place' }),
  skipped: t.Array(t.String(), { description: 'Names of mappers already present and correctly configured' }),
  unsupported: t.Boolean({ description: 'Whether the provider supports attribute-import mappers at all' }),
  userFacing: t.Boolean({ description: 'False when the provider is a machine trust anchor; nothing is provisioned' }),
  errors: t.Array(t.String(), { description: 'Any errors encountered' }),
  timestamp: t.String()
}, { title: 'IdentityProviderMapperFixResponse' })

export const IdentityProviderMapperTypeProperty = t.Object({
  name: t.String({ description: 'Config key' }),
  label: t.Optional(t.String({ description: 'Human readable label' })),
  helpText: t.Optional(t.String({ description: 'Help text' })),
  type: t.Optional(t.String({ description: 'Property type (String, boolean, List, ...)' })),
  defaultValue: t.Optional(t.String({ description: 'Default value, stringified' })),
  options: t.Optional(t.Array(t.String(), { description: 'Allowed values for List properties' })),
  secret: t.Optional(t.Boolean({ description: 'Whether the value is secret' })),
  required: t.Optional(t.Boolean({ description: 'Whether the property must be set' }))
}, { title: 'IdentityProviderMapperTypeProperty' })

export const IdentityProviderMapperTypeResponse = t.Object({
  id: t.String({ description: 'Mapper type ID used as identityProviderMapper' }),
  name: t.Optional(t.String({ description: 'Mapper type display name' })),
  category: t.Optional(t.String({ description: 'Mapper category' })),
  helpText: t.Optional(t.String({ description: 'What this mapper type does' })),
  properties: t.Array(IdentityProviderMapperTypeProperty, { description: 'Configurable properties' })
}, { title: 'IdentityProviderMapperTypeResponse' })

export const CreateIdentityProviderMapperRequest = t.Object({
  name: t.String({ description: 'Mapper name (unique per provider)' }),
  identityProviderMapper: t.String({ description: 'Keycloak mapper type ID (see GET /admin/idps/:alias/mapper-types)' }),
  config: t.Record(t.String(), t.String(), { description: 'Mapper configuration keyed by the type\'s property names' })
}, { title: 'CreateIdentityProviderMapperRequest' })

export const UpdateIdentityProviderMapperRequest = t.Object({
  name: t.Optional(t.String({ description: 'Mapper name' })),
  identityProviderMapper: t.Optional(t.String({ description: 'Keycloak mapper type ID' })),
  config: t.Optional(t.Record(t.String(), t.String(), { description: 'Configuration entries to merge into the mapper' }))
}, { title: 'UpdateIdentityProviderMapperRequest' })

// TypeScript type inference helpers
export type IdentityProviderType = Static<typeof IdentityProvider>
export type IdentityProviderConfigType = Static<typeof IdentityProviderConfig>
export type CreateIdentityProviderRequestType = Static<typeof CreateIdentityProviderRequest>
export type UpdateIdentityProviderRequestType = Static<typeof UpdateIdentityProviderRequest>
export type IdentityProviderResponseType = Static<typeof IdentityProviderResponse>
export type IdentityProviderMapperResponseType = Static<typeof IdentityProviderMapperResponse>
export type IdentityProviderMapperStatusResponseType = Static<typeof IdentityProviderMapperStatusResponse>
export type IdentityProviderMapperFixResponseType = Static<typeof IdentityProviderMapperFixResponse>
export type IdentityProviderMapperTypeResponseType = Static<typeof IdentityProviderMapperTypeResponse>
export type CreateIdentityProviderMapperRequestType = Static<typeof CreateIdentityProviderMapperRequest>
export type UpdateIdentityProviderMapperRequestType = Static<typeof UpdateIdentityProviderMapperRequest>
