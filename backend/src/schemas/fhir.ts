// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * FHIR and SMART on FHIR response schemas
 */

// ==================== FHIR Server Metadata ====================

export const FhirServerMetadata = t.Object({
  fhirVersion: t.String({ description: 'FHIR version supported by server' }),
  serverVersion: t.Optional(t.String({ description: 'Server software version' })),
  serverName: t.Optional(t.String({ description: 'Server software name' })),
  supported: t.Boolean({ description: 'Whether this version is supported' })
}, { title: 'FhirServerMetadata' })

export type FhirServerMetadataType = Static<typeof FhirServerMetadata>

// ==================== Cache Refresh Response ====================

export const CacheRefreshResponse = t.Object({
  success: t.Boolean({ description: 'Whether refresh was successful' }),
  message: t.String({ description: 'Success message' }),
  serverInfo: FhirServerMetadata
}, { title: 'CacheRefreshResponse' })

export type CacheRefreshResponseType = Static<typeof CacheRefreshResponse>

// ==================== SMART Configuration Response ====================

export const SmartConfigurationResponse = t.Object({
  issuer: t.String({ description: 'OpenID Connect issuer URL' }),
  jwks_uri: t.Optional(t.String({ description: 'JSON Web Key Set URL for token validation (required when sso-openid-connect capability is supported)' })),
  authorization_endpoint: t.String({ description: 'OAuth2 authorization endpoint' }),
  token_endpoint: t.String({ description: 'OAuth2 token endpoint' }),
  introspection_endpoint: t.String({ description: 'OAuth2 token introspection endpoint' }),
  registration_endpoint: t.Optional(t.String({ description: 'RFC 7591 Dynamic Client Registration endpoint' })),
  revocation_endpoint: t.Optional(t.String({ description: 'RFC 7009 token revocation endpoint' })),
  management_endpoint: t.Optional(t.String({ description: 'Where the end user sees which apps have access and revokes it (SMART 2.2.0)' })),
  end_session_endpoint: t.Optional(t.String({ description: 'RP-Initiated Logout endpoint (OpenID Connect RP-Initiated Logout 1.0)' })),
  code_challenge_methods_supported: t.Array(t.String(), { description: 'Supported PKCE code challenge methods (SHALL include S256, SHALL NOT include plain per SMART 2.2.0)' }),
  grant_types_supported: t.Array(t.String(), { description: 'Supported OAuth2 grant types' }),
  response_types_supported: t.Array(t.String(), { description: 'Supported OAuth2 response types' }),
  scopes_supported: t.Array(t.String(), { description: 'Supported OAuth2 scopes' }),
  capabilities: t.Array(t.String(), { description: 'SMART on FHIR capabilities' }),
  associated_endpoints: t.Optional(t.Array(t.Object({
    url: t.String({ description: 'Endpoint URL sharing this server\'s authorization' }),
    capabilities: t.Array(t.String(), { description: 'SMART capabilities served at that URL' }),
  }), { description: 'Endpoints that share the same authorization mechanism (experimental)' })),
  token_endpoint_auth_methods_supported: t.Array(t.String(), { description: 'Supported token endpoint authentication methods' }),
  token_endpoint_auth_signing_alg_values_supported: t.Array(t.String(), { description: 'Supported JWT signing algorithms for token endpoint auth' }),
  // User-Access Brands (SMART 2.2.0 Section 8) — RECOMMENDED
  user_access_brand_bundle: t.Optional(t.String({ description: 'URL of a Brand Bundle (FHIR Bundle of Organization + Endpoint resources)' })),
  user_access_brand_identifier: t.Optional(t.Object({
    system: t.Optional(t.String({ description: 'Identifier system (RECOMMENDED: urn:ietf:rfc:3986)' })),
    value: t.String({ description: 'Identifier value (RECOMMENDED: HTTPS URL of brand primary web presence)' })
  }, { description: 'FHIR Identifier for this server\'s primary Brand within the Bundle' })),
  // App Store discovery (vendor extension)
  app_store_url: t.Optional(t.String({ description: 'URL of the SMART App Store for this deployment (vendor extension)' })),
}, { title: 'SmartConfigurationResponse' })

export type SmartConfigurationResponseType = Static<typeof SmartConfigurationResponse>

// ==================== FHIR Proxy Response ====================

export const FhirProxyResponse = t.Object({}, { 
  additionalProperties: true,
  title: 'FhirProxyResponse',
  description: 'FHIR resource response (proxied from upstream server)'
})

export type FhirProxyResponseType = Static<typeof FhirProxyResponse>

// ==================== SMART Config Refresh Response ====================

export const SmartConfigRefreshResponse = t.Object({
  message: t.String({ description: 'Refresh status message' }),
  timestamp: t.String({ description: 'Timestamp of refresh' }),
  config: t.Object({}, { additionalProperties: true, description: 'Refreshed SMART configuration' })
}, { title: 'SmartConfigRefreshResponse' })

export type SmartConfigRefreshResponseType = Static<typeof SmartConfigRefreshResponse>

// ==================== User-Access Brands (SMART 2.2.0 Section 8) ====================

export const UserAccessBrandBundle = t.Object({
  resourceType: t.Literal('Bundle'),
  id: t.String({ description: 'Bundle identifier' }),
  type: t.Literal('collection'),
  timestamp: t.String({ description: 'Last-modified timestamp (ISO 8601)' }),
  entry: t.Array(t.Object({
    fullUrl: t.Optional(t.String({ description: 'Full URL of the resource' })),
    resource: t.Object({}, { additionalProperties: true, description: 'Organization or Endpoint FHIR resource' })
  }), { description: 'Organization and Endpoint resources' })
}, { title: 'UserAccessBrandBundle', additionalProperties: true })

export type UserAccessBrandBundleType = Static<typeof UserAccessBrandBundle>
