// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'
import { AttributesMap, OptionalEnum, APP_TYPES, CLIENT_TYPES } from './common'

/**
 * SMART App/Client Management schemas
 */

/** Keycloak stores a client description in a 255-character column and answers anything longer with unknown_error. */
const AppDescription = t.String({ maxLength: 255, description: 'Application description (at most 255 characters)' })

export const SmartApp = t.Object({
  id: t.Optional(t.String({ description: 'Internal ID' })),
  clientId: t.Optional(t.String({ description: 'OAuth2 client ID' })),
  name: t.Optional(t.String({ description: 'Application name' })),
  description: t.Optional(AppDescription),
  enabled: t.Optional(t.Boolean({ description: 'Whether the app is enabled' })),
  protocol: t.Optional(t.String({ description: 'Protocol (openid-connect)' })),
  publicClient: t.Optional(t.Boolean({ description: 'Whether this is a public client' })),
  redirectUris: t.Optional(t.Array(t.String(), { description: 'Allowed redirect URIs' })),
  webOrigins: t.Optional(t.Array(t.String(), { description: 'Allowed web origins (CORS)' })),
  attributes: t.Optional(AttributesMap),
  clientAuthenticatorType: t.Optional(t.String({ description: 'Keycloak internal auth type (use tokenEndpointAuthMethod instead)' })),
  tokenEndpointAuthMethod: OptionalEnum(['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'], { description: 'Standard OAuth 2.0 token endpoint authentication method (RFC 7591)' }),
  tokenEndpointAuthSigningAlg: OptionalEnum(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'], { description: 'Algorithm the client signs its assertions with, for private_key_jwt. Detected from an inline JWKS; state it when using jwksUri, which is not fetched. Defaults to RS384.' }),
  serviceAccountsEnabled: t.Optional(t.Boolean({ description: 'Enable service accounts' })),
  standardFlowEnabled: t.Optional(t.Boolean({ description: 'Enable authorization code flow' })),
  implicitFlowEnabled: t.Optional(t.Boolean({ description: 'Enable implicit flow' })),
  directAccessGrantsEnabled: t.Optional(t.Boolean({ description: 'Enable direct access grants' })),
  defaultClientScopes: t.Optional(t.Array(t.String(), { description: 'Default scopes' })),
  optionalClientScopes: t.Optional(t.Array(t.String(), { description: 'Optional scopes' })),
  appType: OptionalEnum(APP_TYPES),
  clientType: OptionalEnum(CLIENT_TYPES),
  secret: t.Optional(t.String({ description: 'Client secret for symmetric authentication (only for confidential clients)' })),
  access: t.Optional(t.Record(t.String(), t.Boolean(), { description: 'Keycloak admin console permissions (configure, manage, view) - informational only' })),
  
  // Additional UI/metadata fields
  launchUrl: t.Optional(t.String({ description: 'SMART App launch URL' })),
  homeUrl: t.Optional(t.String({ pattern: '^(https?://.*)?$', description: 'Home URL that "Back to application" links to. Empty derives it from the launch URL and redirect URIs.' })),
  logoUri: t.Optional(t.String({ description: 'Logo URI for application display' })),
  tosUri: t.Optional(t.String({ description: 'Terms of Service URI' })),
  policyUri: t.Optional(t.String({ description: 'Privacy Policy URI' })),
  contacts: t.Optional(t.Array(t.String(), { description: 'Contact emails or names' })),
  
  // Server access control
  serverAccessType: OptionalEnum(['all-servers', 'selected-servers', 'user-person-servers'], { description: 'FHIR server access control type' }),
  allowedServerIds: t.Optional(t.Array(t.String(), { description: 'List of allowed FHIR server IDs' })),
  
  // Scope set reference
  scopeSetId: t.Optional(t.String({ description: 'Reference to a predefined scope set configuration' })),
  
  // PKCE and offline access
  requirePkce: t.Optional(t.Boolean({ description: 'Require PKCE for public clients' })),
  allowOfflineAccess: t.Optional(t.Boolean({ description: 'Allow offline access (refresh tokens)' })),
  
  // Organization assignment
  organizationIds: t.Optional(t.Array(t.String(), { description: 'Keycloak Organization IDs this app is assigned to. Empty/undefined means available to all organizations.' })),
  
  // Token exchange & audience mappers
  tokenExchangeEnabled: t.Optional(t.Boolean({ description: 'Enable Standard Token Exchange (RFC 8693) for this client' })),
  resourceServer: t.Optional(t.Boolean({ description: 'This app is also an RFC 8707 resource server at its client id, which must then be its https URL. Tokens an MCP client obtains for that URL can be exchanged by this app (RFC 8693), with the actor chain recorded.' })),
  accessTokenLifespan: t.Optional(t.Number({ description: 'Access token lifespan in seconds (overrides realm default)' })),
  audienceClients: t.Optional(t.Array(t.String(), { description: 'Client IDs to add as audience mappers on this client (oidc-audience-mapper)' })),
  
  // User type & role restrictions
  allowedFhirUserTypes: t.Optional(t.Array(t.String(), { description: 'Restrict access to specific FHIR user types (e.g. Practitioner, Patient). Empty means no restriction.' })),
  requiredRoles: t.Optional(t.Array(t.String(), { description: 'Realm roles required to access this app. Users without these roles are denied at login.' })),
  
  // fhirUser resolution
  patientFacing: t.Optional(t.Boolean({ description: 'If true, resolves fhirUser to Patient (from Person links). If false, resolves to Practitioner. If undefined, uses raw fhirUser as-is (backward compat).' })),
  
  // Consent & scope settings
  consentRequired: t.Optional(t.Boolean({ description: 'Whether the user must explicitly consent to scopes at login' })),
  fullScopeAllowed: t.Optional(t.Boolean({ description: 'If true, all realm and client roles are added to the token. If false, only assigned roles.' })),
  
  // Session timeout settings
  clientSessionIdleTimeout: t.Optional(t.Number({ description: 'Client session idle timeout in seconds (overrides realm default)' })),
  clientSessionMaxLifespan: t.Optional(t.Number({ description: 'Client session max lifespan in seconds (overrides realm default)' })),
  
  // Logout settings
  backchannelLogoutUrl: t.Optional(t.String({ description: 'Backchannel logout URL — server receives logout token on session end' })),
  frontChannelLogoutUrl: t.Optional(t.String({ description: 'Front-channel logout URL — browser redirected here on logout' }))
}, { title: 'SmartApp' })

export const CreateSmartAppRequest = t.Object({
  clientId: t.String({ description: 'OAuth2 client ID (must be unique)' }),
  name: t.String({ description: 'Application name' }),
  description: t.Optional(AppDescription),
  publicClient: t.Optional(t.Boolean({ description: 'Whether this is a public client (ignored for backend-service type)' })),
  redirectUris: t.Optional(t.Array(t.String(), { description: 'Allowed redirect URIs' })),
  webOrigins: t.Optional(t.Array(t.String(), { description: 'Allowed web origins' })),
  defaultClientScopes: t.Optional(t.Array(t.String(), { description: 'Default SMART scopes' })),
  optionalClientScopes: t.Optional(t.Array(t.String(), { description: 'Optional SMART scopes' })),
  smartVersion: t.Optional(t.String({ description: 'SMART App Launch version' })),
  fhirVersion: t.Optional(t.String({ description: 'FHIR version' })),
  appType: OptionalEnum(APP_TYPES),
  clientType: OptionalEnum(CLIENT_TYPES),
  tokenEndpointAuthMethod: OptionalEnum(['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'], { description: 'Standard OAuth 2.0 token endpoint authentication method (RFC 7591)' }),
  tokenEndpointAuthSigningAlg: OptionalEnum(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'], { description: 'Algorithm the client signs its assertions with, for private_key_jwt. Detected from an inline JWKS; state it when using jwksUri, which is not fetched. Defaults to RS384.' }),
  secret: t.Optional(t.String({ description: 'Client secret for symmetric authentication (only for confidential clients)' })),
  publicKey: t.Optional(t.String({ description: 'Public key for JWT authentication (PEM format)' })),
  jwksUri: t.Optional(t.String({ description: 'JWKS URI for JWT authentication' })),
  jwksString: t.Optional(t.String({ description: 'Inline JWKS JSON string containing public keys for JWT authentication (alternative to jwksUri or publicKey)' })),
  systemScopes: t.Optional(t.Array(t.String(), { description: 'System-level scopes for backend services' })),
  
  // Additional UI/metadata fields
  launchUrl: t.Optional(t.String({ description: 'SMART App launch URL' })),
  homeUrl: t.Optional(t.String({ pattern: '^(https?://.*)?$', description: 'Home URL that "Back to application" links to. Empty derives it from the launch URL and redirect URIs.' })),
  logoUri: t.Optional(t.String({ description: 'Logo URI for application display' })),
  tosUri: t.Optional(t.String({ description: 'Terms of Service URI' })),
  policyUri: t.Optional(t.String({ description: 'Privacy Policy URI' })),
  contacts: t.Optional(t.Array(t.String(), { description: 'Contact emails or names' })),
  
  // Server access control
  serverAccessType: OptionalEnum(['all-servers', 'selected-servers', 'user-person-servers'], { description: 'FHIR server access control type' }),
  allowedServerIds: t.Optional(t.Array(t.String(), { description: 'List of allowed FHIR server IDs (when serverAccessType is selected-servers)' })),
  
  // Scope set reference
  scopeSetId: t.Optional(t.String({ description: 'Reference to a predefined scope set configuration' })),
  
  // PKCE and offline access
  requirePkce: t.Optional(t.Boolean({ description: 'Require Proof Key for Code Exchange (PKCE) for public clients' })),
  allowOfflineAccess: t.Optional(t.Boolean({ description: 'Allow offline access (refresh tokens)' })),
  
  // Organization assignment
  organizationIds: t.Optional(t.Array(t.String(), { description: 'Keycloak Organization IDs this app is assigned to' })),
  
  // Token exchange & audience mappers
  tokenExchangeEnabled: t.Optional(t.Boolean({ description: 'Enable Standard Token Exchange (RFC 8693) for this client' })),
  resourceServer: t.Optional(t.Boolean({ description: 'This app is also an RFC 8707 resource server at its client id, which must then be its https URL. Tokens an MCP client obtains for that URL can be exchanged by this app (RFC 8693), with the actor chain recorded.' })),
  accessTokenLifespan: t.Optional(t.Number({ description: 'Access token lifespan in seconds (overrides realm default)' })),
  audienceClients: t.Optional(t.Array(t.String(), { description: 'Client IDs to add as audience mappers (oidc-audience-mapper)' })),
  
  // User type & role restrictions
  allowedFhirUserTypes: t.Optional(t.Array(t.String(), { description: 'Restrict access to specific FHIR user types (e.g. Practitioner, Patient). Empty means no restriction.' })),
  requiredRoles: t.Optional(t.Array(t.String(), { description: 'Realm roles required to access this app. Users without these roles are denied at login.' })),
  
  // fhirUser resolution
  patientFacing: t.Optional(t.Union([t.Boolean(), t.Null()], { description: 'If true, resolves fhirUser to Patient (from Person links). If false, resolves to Practitioner. Null clears it, restoring the raw-passthrough default for an app that resolves the Person itself or serves both roles. Omit to leave unchanged.' })),
  
  // Consent & scope settings
  consentRequired: t.Optional(t.Boolean({ description: 'Whether the user must explicitly consent to scopes at login' })),
  fullScopeAllowed: t.Optional(t.Boolean({ description: 'If true, all realm and client roles are added to the token. If false, only assigned roles.' })),
  
  // Session timeout settings
  clientSessionIdleTimeout: t.Optional(t.Number({ description: 'Client session idle timeout in seconds (overrides realm default)' })),
  clientSessionMaxLifespan: t.Optional(t.Number({ description: 'Client session max lifespan in seconds (overrides realm default)' })),
  
  // Logout settings
  backchannelLogoutUrl: t.Optional(t.String({ description: 'Backchannel logout URL — server receives logout token on session end' })),
  frontChannelLogoutUrl: t.Optional(t.String({ description: 'Front-channel logout URL — browser redirected here on logout' }))
}, { title: 'CreateSmartAppRequest' })

export const UpdateSmartAppRequest = t.Object({
  name: t.Optional(t.String({ description: 'Application name' })),
  description: t.Optional(AppDescription),
  enabled: t.Optional(t.Boolean({ description: 'Whether the app is enabled' })),
  publicClient: t.Optional(t.Boolean({ description: 'Whether this is a public client' })),
  redirectUris: t.Optional(t.Array(t.String(), { description: 'Allowed redirect URIs' })),
  webOrigins: t.Optional(t.Array(t.String(), { description: 'Allowed web origins' })),
  defaultClientScopes: t.Optional(t.Array(t.String(), { description: 'Default SMART scopes' })),
  optionalClientScopes: t.Optional(t.Array(t.String(), { description: 'Optional SMART scopes' })),
  smartVersion: t.Optional(t.String({ description: 'SMART App Launch version' })),
  fhirVersion: t.Optional(t.String({ description: 'FHIR version' })),
  appType: OptionalEnum(APP_TYPES),
  clientType: OptionalEnum(CLIENT_TYPES),
  tokenEndpointAuthMethod: OptionalEnum(['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'], { description: 'Standard OAuth 2.0 token endpoint authentication method (RFC 7591)' }),
  tokenEndpointAuthSigningAlg: OptionalEnum(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'], { description: 'Algorithm the client signs its assertions with, for private_key_jwt. Detected from an inline JWKS; state it when using jwksUri, which is not fetched. Defaults to RS384.' }),
  secret: t.Optional(t.String({ description: 'Client secret for symmetric authentication (only for confidential clients)' })),
  publicKey: t.Optional(t.String({ description: 'Public key for JWT authentication (PEM format)' })),
  jwksUri: t.Optional(t.String({ description: 'JWKS URI for JWT authentication' })),
  jwksString: t.Optional(t.String({ description: 'Inline JWKS JSON string containing public keys for JWT authentication (alternative to jwksUri or publicKey)' })),
  systemScopes: t.Optional(t.Array(t.String(), { description: 'System-level scopes for backend services' })),
  
  // Additional UI/metadata fields
  launchUrl: t.Optional(t.String({ description: 'SMART App launch URL' })),
  homeUrl: t.Optional(t.String({ pattern: '^(https?://.*)?$', description: 'Home URL that "Back to application" links to. Empty derives it from the launch URL and redirect URIs.' })),
  logoUri: t.Optional(t.String({ description: 'Logo URI for application display' })),
  tosUri: t.Optional(t.String({ description: 'Terms of Service URI' })),
  policyUri: t.Optional(t.String({ description: 'Privacy Policy URI' })),
  contacts: t.Optional(t.Array(t.String(), { description: 'Contact emails or names' })),
  
  // Server access control
  serverAccessType: OptionalEnum(['all-servers', 'selected-servers', 'user-person-servers'], { description: 'FHIR server access control type' }),
  allowedServerIds: t.Optional(t.Array(t.String(), { description: 'List of allowed FHIR server IDs' })),
  
  // Scope set reference
  scopeSetId: t.Optional(t.String({ description: 'Reference to a predefined scope set configuration' })),
  
  // PKCE and offline access
  requirePkce: t.Optional(t.Boolean({ description: 'Require PKCE for public clients' })),
  allowOfflineAccess: t.Optional(t.Boolean({ description: 'Allow offline access (refresh tokens)' })),
  
  // Organization assignment
  organizationIds: t.Optional(t.Array(t.String(), { description: 'Keycloak Organization IDs this app is assigned to' })),
  
  // Token exchange & audience mappers
  tokenExchangeEnabled: t.Optional(t.Boolean({ description: 'Enable Standard Token Exchange (RFC 8693) for this client' })),
  resourceServer: t.Optional(t.Boolean({ description: 'This app is also an RFC 8707 resource server at its client id, which must then be its https URL. Tokens an MCP client obtains for that URL can be exchanged by this app (RFC 8693), with the actor chain recorded.' })),
  accessTokenLifespan: t.Optional(t.Number({ description: 'Access token lifespan in seconds (overrides realm default)' })),
  audienceClients: t.Optional(t.Array(t.String(), { description: 'Client IDs to add as audience mappers (oidc-audience-mapper)' })),
  
  // User type & role restrictions
  allowedFhirUserTypes: t.Optional(t.Array(t.String(), { description: 'Restrict access to specific FHIR user types (e.g. Practitioner, Patient). Empty means no restriction.' })),
  requiredRoles: t.Optional(t.Array(t.String(), { description: 'Realm roles required to access this app. Users without these roles are denied at login.' })),
  
  // fhirUser resolution
  patientFacing: t.Optional(t.Union([t.Boolean(), t.Null()], { description: 'If true, resolves fhirUser to Patient (from Person links). If false, resolves to Practitioner. Null clears it, restoring the raw-passthrough default for an app that resolves the Person itself or serves both roles. Omit to leave unchanged.' })),
  
  // Consent & scope settings
  consentRequired: t.Optional(t.Boolean({ description: 'Whether the user must explicitly consent to scopes at login' })),
  fullScopeAllowed: t.Optional(t.Boolean({ description: 'If true, all realm and client roles are added to the token. If false, only assigned roles.' })),
  
  // Session timeout settings
  clientSessionIdleTimeout: t.Optional(t.Number({ description: 'Client session idle timeout in seconds (overrides realm default)' })),
  clientSessionMaxLifespan: t.Optional(t.Number({ description: 'Client session max lifespan in seconds (overrides realm default)' })),
  
  // Logout settings
  backchannelLogoutUrl: t.Optional(t.String({ description: 'Backchannel logout URL — server receives logout token on session end' })),
  frontChannelLogoutUrl: t.Optional(t.String({ description: 'Front-channel logout URL — browser redirected here on logout' }))
}, { title: 'UpdateSmartAppRequest' })

export const ClientIdParam = t.Object({
  clientId: t.String({ description: 'OAuth2 client ID' })
}, { title: 'ClientIdParam' })

// TypeScript type inference helpers
export type SmartAppType = Static<typeof SmartApp>
export type CreateSmartAppRequestType = Static<typeof CreateSmartAppRequest>
export type UpdateSmartAppRequestType = Static<typeof UpdateSmartAppRequest>
