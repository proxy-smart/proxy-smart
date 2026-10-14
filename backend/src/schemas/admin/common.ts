// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

/**
 * Common/Shared schemas used across admin modules
 */

/**
 * Common string/array attribute type used across Keycloak entities
 */
export const AttributeValue = t.Union([t.String(), t.Array(t.String())])

/**
 * Reusable attributes map for Keycloak entities
 */
export const AttributesMap = t.Record(t.String(), AttributeValue)

/**
 * Common endpoints structure for FHIR servers
 */
export const FhirEndpoints = t.Object({
  base: t.String({ description: 'Base FHIR endpoint URL' }),
  smartConfig: t.String({ description: 'SMART configuration endpoint URL' }),
  metadata: t.String({ description: 'FHIR capability statement endpoint URL' }),
  authorize: t.Optional(t.String({ description: 'OAuth2 authorization endpoint' })),
  token: t.Optional(t.String({ description: 'OAuth2 token endpoint' })),
  registration: t.Optional(t.String({ description: 'Dynamic client registration endpoint (RFC 7591)' })),
  introspection: t.Optional(t.String({ description: 'Token introspection endpoint' })),
  revocation: t.Optional(t.String({ description: 'Token revocation endpoint (RFC 7009)' })),
})

/**
 * Certificate details structure (reused in mTLS)
 */
export const CertificateDetails = t.Object({
  subject: t.String({ description: 'Certificate subject DN' }),
  issuer: t.String({ description: 'Certificate issuer DN' }),
  validFrom: t.String({ description: 'Certificate validity start date (ISO 8601)' }),
  validTo: t.String({ description: 'Certificate validity end date (ISO 8601)' }),
  fingerprint: t.String({ description: 'Certificate fingerprint (SHA-256)' })
})

/**
 * App type literal values for SMART applications
 */
export const APP_TYPES = ['standalone-app', 'ehr-launch', 'backend-service', 'agent'] as const

export const APP_TYPE_DESCRIPTION =
  'standalone-app / ehr-launch: a user signs in to the app. backend-service: reads as itself (client_credentials, system scopes). '
  + 'agent: acts for a signed-in user by exchanging the token it is handed (RFC 8693), recorded as the actor; '
  + 'private_key_jwt, token exchange on, no login and no service account. Set resourceServer when tokens are issued for its URL, as for an MCP server.'

export const AppTypeLiteral = t.UnionEnum([...APP_TYPES])

/**
 * Client type literal values for OAuth2 clients
 */
export const CLIENT_TYPES = ['public', 'confidential', 'backend-service'] as const

export const ClientTypeLiteral = t.UnionEnum([...CLIENT_TYPES])

/**
 * Server scope literal values for launch contexts
 */
export const ServerScopeLiteral = t.UnionEnum([
  'global',
  'specific',
  'single'
])

// TypeScript type inference helpers
export type AttributeValueType = Static<typeof AttributeValue>
export type AttributesMapType = Static<typeof AttributesMap>
export type FhirEndpointsType = Static<typeof FhirEndpoints>
export type CertificateDetailsType = Static<typeof CertificateDetails>
export type AppType = Static<typeof AppTypeLiteral>
export type ClientType = Static<typeof ClientTypeLiteral>
export type ServerScopeType = Static<typeof ServerScopeLiteral>

/** Optional request enum without the first-member `default` t.UnionEnum adds, so omitted stays omitted. */
export function OptionalEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  options?: Record<string, unknown>,
) {
  const schema = t.UnionEnum(values, options)
  delete schema.default
  return t.Optional(schema)
}

/** anyOf of string literals; the leading-element tuple keeps TypeBox's mapped types (Partial etc.) from collapsing it to never. */
export function LiteralUnion<T extends string>(values: readonly T[], options?: Record<string, unknown>) {
  const [first, ...rest] = values
  if (first === undefined) throw new Error('LiteralUnion needs at least one value')
  return t.Union([t.Literal(first), ...rest.map(value => t.Literal(value))], options)
}
