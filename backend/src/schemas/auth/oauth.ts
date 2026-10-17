// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * OAuth and OpenID Connect schemas
 * Includes authorization flows, token management, and user information
 */

// ==================== OAuth Token Exchange ====================

export const TokenRequest = t.Object({
  grant_type: t.String({ description: 'OAuth2 grant type (authorization_code, refresh_token, client_credentials, password, urn:ietf:params:oauth:grant-type:token-exchange)' }),
  code: t.Optional(t.String({ description: 'Authorization code (for authorization_code grant)' })),
  redirect_uri: t.Optional(t.String({ description: 'Redirect URI used in authorization request' })),
  client_id: t.Optional(t.String({ description: 'OAuth2 client ID' })),
  client_secret: t.Optional(t.String({ description: 'OAuth2 client secret' })),
  code_verifier: t.Optional(t.String({ description: 'PKCE code verifier' })),
  device_code: t.Optional(t.String({ description: 'Device verification code (for the RFC 8628 device_code grant poll)' })),
  refresh_token: t.Optional(t.String({ description: 'Refresh token (for refresh_token grant)' })),
  scope: t.Optional(t.String({ description: 'Requested scopes (space-separated)' })),
  audience: t.Optional(t.String({ description: 'Target audience for the token' })),
  resource: t.Optional(t.String({ description: 'Target resource URI (RFC 8707 Resource Indicators)' })),
  username: t.Optional(t.String({ description: 'Username (for password grant)' })),
  password: t.Optional(t.String({ description: 'Password (for password grant)' })),
  client_assertion_type: t.Optional(t.String({ description: 'Client assertion type for JWT authentication' })),
  client_assertion: t.Optional(t.String({ description: 'Client assertion JWT for authentication' })),
  // Token exchange parameters (RFC 8693)
  subject_token: t.Optional(t.String({ description: 'Security token to be exchanged (for token-exchange grant)' })),
  subject_token_type: t.Optional(t.String({ description: 'Type of subject_token (urn:ietf:params:oauth:token-type:access_token)' })),
  requested_token_type: t.Optional(t.String({ description: 'Type of requested token (urn:ietf:params:oauth:token-type:access_token)' }))
}, { title: 'TokenRequest' })
export type TokenRequestType = Static<typeof TokenRequest>

// ==================== OAuth Device Authorization (RFC 8628) ====================

// Device-authorization request. The proxy forwards these form fields to the
// IdP's device-authorization endpoint. Kept permissive (mostly optional) since
// public clients may omit client_secret and confidential clients include it.
export const DeviceAuthorizationRequest = t.Object({
  client_id: t.Optional(t.String({ description: 'OAuth2 client ID' })),
  client_secret: t.Optional(t.String({ description: 'OAuth2 client secret (confidential clients only)' })),
  scope: t.Optional(t.String({ description: 'Requested scopes (space-separated)' })),
  audience: t.Optional(t.String({ description: 'Target audience for the eventual token' })),
  resource: t.Optional(t.String({ description: 'Target resource URI (RFC 8707 Resource Indicators)' })),
}, { title: 'DeviceAuthorizationRequest', additionalProperties: true })
export type DeviceAuthorizationRequestType = Static<typeof DeviceAuthorizationRequest>

// Device-authorization response (RFC 8628 §3.2). error/error_description cover
// the failure path so the same schema serves both outcomes.
export const DeviceAuthorizationResponse = t.Object({
  device_code: t.Optional(t.String({ description: 'Device verification code used to poll the token endpoint' })),
  user_code: t.Optional(t.String({ description: 'End-user code to enter at the verification URI' })),
  verification_uri: t.Optional(t.String({ description: 'URL the user visits to approve the device (IdP browser page)' })),
  verification_uri_complete: t.Optional(t.String({ description: 'verification_uri pre-filled with the user_code' })),
  expires_in: t.Optional(t.Number({ description: 'Lifetime in seconds of device_code and user_code' })),
  interval: t.Optional(t.Number({ description: 'Minimum seconds the client should wait between token polls' })),
  error: t.Optional(t.String({ description: 'Error code if the request failed' })),
  error_description: t.Optional(t.String({ description: 'Human-readable error description' })),
}, { title: 'DeviceAuthorizationResponse' })
export type DeviceAuthorizationResponseType = Static<typeof DeviceAuthorizationResponse>

// RFC 7662 Token Introspection — accept any form fields since clients may send
// auth params (client_assertion, client_assertion_type) that vary by implementation.
// Keycloak handles the real validation.
export const IntrospectRequest = t.Record(t.String(), t.String(), {
  title: 'IntrospectRequest',
  description: 'RFC 7662 token introspection request (token, token_type_hint, client_id, client_secret, etc.)'
})
export type IntrospectRequestType = Static<typeof IntrospectRequest>

// RFC 7009 Token Revocation. Everything is optional so the route can answer missing fields with
// an OAuth error rather than a schema 422.
export const RevocationRequest = t.Object({
  token: t.Optional(t.String({ description: 'The access or refresh token to revoke' })),
  token_type_hint: t.Optional(t.String({ description: 'access_token or refresh_token' })),
  client_id: t.Optional(t.String({ description: 'OAuth2 client ID; alone it suffices for a public client' })),
  client_secret: t.Optional(t.String({ description: 'OAuth2 client secret (client_secret_post)' })),
  client_assertion_type: t.Optional(t.String({ description: 'Client assertion type for private_key_jwt' })),
  client_assertion: t.Optional(t.String({ description: 'Client assertion JWT, aud = the proxy token endpoint' })),
}, { title: 'RevocationRequest' })
export type RevocationRequestType = Static<typeof RevocationRequest>

// Introspection response can contain many implementation-specific fields
export const IntrospectResponse = t.Record(t.String(), t.Any(), {
  title: 'IntrospectResponse',
  description: 'RFC 7662 token introspection response (active, sub, aud, exp, scope, etc.)'
})
export type IntrospectResponseType = Static<typeof IntrospectResponse>

// ==================== OAuth Query Parameters ====================

/*
 * An ALLOWLIST, not documentation: the interceptor forwards every param it receives, so
 * anything undeclared here is dropped by validation before reaching it.
 */
export const AuthorizationQuery = t.Object({
  response_type: t.Optional(t.String({ description: 'OAuth response type' })),
  client_id: t.Optional(t.String({ description: 'OAuth client ID' })),
  redirect_uri: t.Optional(t.String({ description: 'OAuth redirect URI' })),
  scope: t.Optional(t.String({ description: 'OAuth scope' })),
  state: t.Optional(t.String({ description: 'OAuth state parameter' })),
  code_challenge: t.Optional(t.String({ description: 'PKCE code challenge' })),
  code_challenge_method: t.Optional(t.String({ description: 'PKCE code challenge method' })),
  aud: t.Optional(t.String({ description: 'SMART App Launch: FHIR server URL the app wishes to access. Prevents token leakage to counterfeit resource servers (required by SMART App Launch 2.2.0)' })),
  resource: t.Optional(t.String({ description: 'RFC 8707 Resource Indicator — synonym for aud (servers MAY support)' })),
  launch: t.Optional(t.String({ description: 'EHR Launch: opaque launch context identifier received from the EHR (SMART App Launch 2.2.0)' })),
  authorization_details: t.Optional(t.String({ description: 'Authorization details JSON string for multiple FHIR servers' })),
  kc_idp_hint: t.Optional(t.String({ description: 'Keycloak Identity Provider hint to skip provider selection' })),
  prompt: t.Optional(t.String({ description: 'OIDC Core 3.1.2.1 — none, login, consent, select_account. `login` MUST re-authenticate instead of reusing the SSO session' })),
  nonce: t.Optional(t.String({ description: 'OIDC Core 3.1.2.1 — bound into the id_token to detect replay' })),
  login_hint: t.Optional(t.String({ description: 'OIDC Core 3.1.2.1 — identifier to prefill on the login form' })),
  max_age: t.Optional(t.String({ description: 'OIDC Core 3.1.2.1 — seconds before the IdP must re-authenticate' })),
}, { title: 'AuthorizationQuery' })
export type AuthorizationQueryType = Static<typeof AuthorizationQuery>

/** Query schema for the SMART callback endpoint (receives redirect from Keycloak) */
export const SmartCallbackQuery = t.Object({
  code: t.Optional(t.String({ description: 'Authorization code from Keycloak' })),
  state: t.Optional(t.String({ description: 'State parameter (session key for SMART flows)' })),
  error: t.Optional(t.String({ description: 'OAuth error code from Keycloak' })),
  error_description: t.Optional(t.String({ description: 'Human-readable error description' })),
  session_state: t.Optional(t.String({ description: 'Keycloak session state' })),
}, { title: 'SmartCallbackQuery' })
export type SmartCallbackQueryType = Static<typeof SmartCallbackQuery>

const pickerSessionField = t.Optional(t.String({ description: 'Launch session key the picker was opened with' }))
const pickerCodeField = t.Optional(t.String({ description: 'Authorization code the launch forwards once context is chosen' }))

export const PickerStepQuery = t.Object({
  session: pickerSessionField,
  code: pickerCodeField,
}, { title: 'PickerStepQuery' })

export const IdentitySelectBody = t.Object({
  session: pickerSessionField,
  code: pickerCodeField,
  identity: t.Optional(t.String({ description: 'One of the identity references the picker offered' })),
}, { title: 'IdentitySelectBody' })

export const PatientSelectBody = t.Object({
  session: pickerSessionField,
  code: pickerCodeField,
  patient: t.Optional(t.String({ description: 'Chosen Patient id' })),
}, { title: 'PatientSelectBody' })

export const EncounterSelectBody = t.Object({
  session: pickerSessionField,
  code: pickerCodeField,
  encounter: t.Optional(t.String({ description: 'Chosen Encounter id; omit to proceed without one when none was offered' })),
}, { title: 'EncounterSelectBody' })

export const LoginQuery = t.Object({
  client_id: t.Optional(t.String({ description: 'OAuth client ID (defaults to admin-ui)' })),
  redirect_uri: t.Optional(t.String({ description: 'OAuth redirect URI (defaults to base URL)' })),
  scope: t.Optional(t.String({ description: 'OAuth scope (defaults to openid profile email)' })),
  state: t.Optional(t.String({ description: 'OAuth state parameter (auto-generated if not provided)' })),
  code_challenge: t.Optional(t.String({ description: 'PKCE code challenge' })),
  code_challenge_method: t.Optional(t.String({ description: 'PKCE code challenge method' })),
  authorization_details: t.Optional(t.String({ description: 'Authorization details JSON string for multiple FHIR servers' }))
}, { title: 'LoginQuery' })
export type LoginQueryType = Static<typeof LoginQuery>

export const LogoutQuery = t.Object({
  post_logout_redirect_uri: t.Optional(t.String({ description: 'Post-logout redirect URI (defaults to base URL)' })),
  id_token_hint: t.Optional(t.String({ description: 'ID token hint for logout' })),
  client_id: t.Optional(t.String({ description: 'OAuth client ID' })),
  state: t.Optional(t.String({ description: 'Launch session key, used to end the session and return to the app' }))
}, { title: 'LogoutQuery' })
export type LogoutQueryType = Static<typeof LogoutQuery>

// ==================== Identity Provider Schemas ====================

export const PublicIdentityProvider = t.Object({
  alias: t.String({ description: 'Provider alias, passed to Keycloak as kc_idp_hint' }),
  providerId: t.String({ description: 'Provider type, such as oidc, saml or google' }),
  displayName: t.String({ description: 'Button label: the display name, else the alias' }),
  enabled: t.Boolean({ description: 'Always true: disabled providers are not listed' })
}, { title: 'PublicIdentityProvider' })
export type PublicIdentityProviderType = Static<typeof PublicIdentityProvider>

export const PublicIdentityProvidersResponse = t.Array(PublicIdentityProvider)
export type PublicIdentityProvidersResponseType = Static<typeof PublicIdentityProvidersResponse>

// ==================== FHIR Context Schemas ====================

export const FhirContextItem = t.Object({
  reference: t.Optional(t.String({ description: 'FHIR resource reference. At least one of reference, canonical and identifier is required' })),
  canonical: t.Optional(t.String({ description: 'Canonical URL' })),
  identifier: t.Optional(t.Object({
    system: t.Optional(t.String({ description: 'Namespace of the identifier value' })),
    value: t.Optional(t.String({ description: 'The identifier value' })),
  }, { description: 'FHIR Identifier (SMART 2.2 logical reference)', additionalProperties: true })),
  type: t.Optional(t.String({ description: 'FHIR resource type' })),
  role: t.Optional(t.String({ description: 'Role of the item: omitted or "launch" for launch context, else an absolute URI; never empty' }))
}, { title: 'FhirContextItem' })
export type FhirContextItemType = Static<typeof FhirContextItem>

const AuthorizationDetail = t.Object({
  type: t.String({ description: 'Authorization details type (smart_on_fhir)' }),
  locations: t.Array(t.String({ description: 'Array of FHIR base URLs where token can be used' })),
  fhirVersions: t.Array(t.String({ description: 'Array of FHIR version codes (e.g., 4.0.1, 1.0.2)' })),
  scope: t.Optional(t.String({ description: 'Space-separated SMART scopes for these locations' })),
  patient: t.Optional(t.String({ description: 'Patient context for these locations' })),
  encounter: t.Optional(t.String({ description: 'Encounter context for these locations' })),
  fhirContext: t.Optional(t.Array(FhirContextItem, { description: 'FHIR context for these locations' }))
}, { title: 'AuthorizationDetail' })
export type AuthorizationDetailType = Static<typeof AuthorizationDetail>

// ==================== Token Response Schemas ====================

export const TokenResponse = t.Object({
  access_token: t.Optional(t.String({ description: 'JWT access token' })),
  token_type: t.Optional(t.String({ description: 'Token type (Bearer)' })),
  expires_in: t.Optional(t.Number({ description: 'Token expiration time in seconds' })),
  refresh_token: t.Optional(t.String({ description: 'Refresh token' })),
  refresh_expires_in: t.Optional(t.Number({ description: 'Refresh token expiration time in seconds' })),
  id_token: t.Optional(t.String({ description: 'OpenID Connect ID token' })),
  scope: t.Optional(t.String({ description: 'Granted scopes' })),
  session_state: t.Optional(t.String({ description: 'Keycloak session state' })),
  'not-before-policy': t.Optional(t.Number({ description: 'Not before policy timestamp' })),
  // SMART on FHIR launch context parameters (per SMART App Launch 2.2.0)
  patient: t.Optional(t.String({ description: 'Patient in context (e.g., Patient/123)' })),
  encounter: t.Optional(t.String({ description: 'Encounter in context (e.g., Encounter/456)' })),
  fhirUser: t.Optional(t.String({ description: 'FHIR user resource (e.g., Practitioner/789)' })),
  fhirContext: t.Optional(t.Array(FhirContextItem, { description: 'Additional FHIR resources in context' })),
  intent: t.Optional(t.String({ description: 'Launch intent (e.g., reconcile-medications)' })),
  smart_style_url: t.Optional(t.String({ description: 'URL to CSS stylesheet for styling' })),
  tenant: t.Optional(t.String({ description: 'Tenant identifier' })),
  need_patient_banner: t.Optional(t.Boolean({ description: 'Whether patient banner is required' })),
  appContext: t.Optional(t.String({ description: 'Application context from the launch (CDS Hooks Link appContext, SMART task-ehr-launch)' })),
  // Authorization details for multiple FHIR servers (RFC 9396)
  authorization_details: t.Optional(t.Array(AuthorizationDetail, { description: 'Authorization details for multiple FHIR servers' })),
  error: t.Optional(t.String({ description: 'Error code if request failed' })),
  error_description: t.Optional(t.String({ description: 'Error description if request failed' }))
}, { title: 'TokenResponse' })
export type TokenResponseType = Static<typeof TokenResponse>

// ==================== EHR Launch Schemas (SMART App Launch 2.2.0) ====================

export const EhrLaunchRequest = t.Object({
  patient: t.Optional(t.String({ description: 'Patient ID in context (e.g., "123" or "Patient/123")' })),
  encounter: t.Optional(t.String({ description: 'Encounter ID in context (e.g., "456" or "Encounter/456")' })),
  fhirUser: t.Optional(t.String({ description: 'FHIR user reference (e.g., "Practitioner/789")' })),
  intent: t.Optional(t.String({ description: 'Intent string (e.g., "order-review", "reconcile-medications")' })),
  smartStyleUrl: t.Optional(t.String({ description: 'URL to CSS stylesheet for styling' })),
  tenant: t.Optional(t.String({ description: 'Tenant identifier' })),
  needPatientBanner: t.Optional(t.Boolean({ description: 'Whether patient banner is required' })),
  fhirContext: t.Optional(t.Array(FhirContextItem, {
    description: 'Additional FHIR resources in context. Each item needs reference, canonical or identifier; role, when given, is "launch" or an absolute URI; Patient and Encounter only with a role other than "launch"',
  })),
  appContext: t.Optional(t.String({ description: 'Application context returned as is in the token response (CDS Hooks Link appContext)' })),
  clientId: t.Optional(t.String({ description: 'Required: the client_id the launch code is for. Authorize refuses the code for any other client' })),
  iss: t.Optional(t.String({ description: 'FHIR base URL the EHR hands the app as iss. Binds the code: the app aud must name the same server, and an encounter is checked to belong to the patient there' })),
}, { title: 'EhrLaunchRequest' })
export type EhrLaunchRequestType = Static<typeof EhrLaunchRequest>

export const EhrLaunchResponse = t.Object({
  launch: t.String({ description: 'Opaque launch code to pass to /authorize (SMART App Launch 2.2.0)' }),
  expires_in: t.Number({ description: 'Seconds until the launch code expires' }),
}, { title: 'EhrLaunchResponse' })
export type EhrLaunchResponseType = Static<typeof EhrLaunchResponse>

// ==================== User Info Schemas ====================

export const UserInfoHeader = t.Object({
  authorization: t.String({ description: 'Bearer token' })
}, { title: 'UserInfoHeader' })
export type UserInfoHeaderType = Static<typeof UserInfoHeader>

const UserName = t.Object({
  text: t.String({ description: 'Display name' })
}, { title: 'UserName' })

export const UserInfoResponse = t.Object({
  id: t.String({ description: 'User ID' }),
  fhirUser: t.Optional(t.String({ description: 'FHIR user resource reference (e.g., Practitioner/123)' })),
  name: t.Array(UserName),
  username: t.String({ description: 'Username' }),
  email: t.Optional(t.String({ description: 'Email address' })),
  firstName: t.Optional(t.String({ description: 'First name' })),
  lastName: t.Optional(t.String({ description: 'Last name' })),
  roles: t.Array(t.String({ description: 'User roles' }))
}, { title: 'UserInfoResponse' })
export type UserInfoResponseType = Static<typeof UserInfoResponse>

export const UserInfoErrorResponse = t.Object({
  error: t.String({ description: 'Error message' })
}, { title: 'UserInfoErrorResponse' })
export type UserInfoErrorResponseType = Static<typeof UserInfoErrorResponse>

// ==================== JWKS (JSON Web Key Set) ====================

export const JsonWebKey = t.Object({
  kty: t.String({ description: 'Key type (e.g., RSA, EC)' }),
  use: t.Optional(t.String({ description: 'Public key use (sig, enc)' })),
  alg: t.Optional(t.String({ description: 'Algorithm (e.g., RS256, RS384, RS512)' })),
  kid: t.Optional(t.String({ description: 'Key ID' })),
  n: t.Optional(t.String({ description: 'RSA modulus' })),
  e: t.Optional(t.String({ description: 'RSA exponent' })),
  x: t.Optional(t.String({ description: 'EC x coordinate' })),
  y: t.Optional(t.String({ description: 'EC y coordinate' })),
  crv: t.Optional(t.String({ description: 'EC curve name' })),
  x5c: t.Optional(t.Array(t.String(), { description: 'X.509 certificate chain' })),
  x5t: t.Optional(t.String({ description: 'X.509 certificate SHA-1 thumbprint' })),
  'x5t#S256': t.Optional(t.String({ description: 'X.509 certificate SHA-256 thumbprint' }))
}, { title: 'JsonWebKey' })
export type JsonWebKeyType = Static<typeof JsonWebKey>

export const JWKSResponse = t.Object({
  keys: t.Array(JsonWebKey, { description: 'Array of JSON Web Keys' })
}, { title: 'JWKSResponse' })
export type JWKSResponseType = Static<typeof JWKSResponse>
