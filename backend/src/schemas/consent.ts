// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Schemas
 * 
 * TypeBox schemas for consent-related API responses.
 */

import { t, type Static } from 'elysia'

/**
 * Consent decision type
 */
export const ConsentDecision = t.Union([
  t.Literal('permit'),
  t.Literal('deny')
], { description: 'Consent decision result' })

export type ConsentDecisionType = Static<typeof ConsentDecision>

/**
 * Consent mode type
 */
export const ConsentMode = t.Union([
  t.Literal('enforce'),
  t.Literal('audit-only'),
  t.Literal('disabled')
], { description: 'Consent enforcement mode' })

export type ConsentModeType = Static<typeof ConsentMode>

/**
 * Consent check context
 */
export const ConsentCheckContext = t.Object({
  patientId: t.Union([t.String(), t.Null()], { description: 'Patient ID from token or request' }),
  clientId: t.String({ description: 'Client ID (from token azp claim)' }),
  resourceType: t.Union([t.String(), t.Null()], { description: 'FHIR resource type being accessed' }),
  resourceId: t.Union([t.String(), t.Null()], { description: 'Resource ID if specific resource' }),
  method: t.String({ description: 'HTTP method' }),
  resourcePath: t.String({ description: 'Full resource path' }),
  serverName: t.String({ description: 'FHIR server identifier' }),
  scopes: t.Array(t.String(), { description: 'Granted OAuth scopes' }),
  fhirUser: t.Union([t.String(), t.Null()], { description: 'FHIR User reference' })
}, { title: 'ConsentCheckContext' })

export type ConsentCheckContextType = Static<typeof ConsentCheckContext>

/**
 * Consent check result
 */
export const ConsentCheckResult = t.Object({
  decision: ConsentDecision,
  consentId: t.Union([t.String(), t.Null()], { description: 'Consent resource that authorized/denied access' }),
  reason: t.String({ description: 'Reason for the decision' }),
  cached: t.Boolean({ description: 'Whether decision was from cache' }),
  checkDurationMs: t.Number({ description: 'Time taken for consent check in milliseconds' }),
  context: ConsentCheckContext
}, { title: 'ConsentCheckResult' })

export type ConsentCheckResultType = Static<typeof ConsentCheckResult>

/**
 * Consent configuration
 */
export const ConsentConfig = t.Object({
  enabled: t.Boolean({ description: 'Whether consent enforcement is enabled' }),
  mode: ConsentMode,
  cacheTtl: t.Number({ description: 'Cache TTL in milliseconds' }),
  exemptClients: t.Array(t.String(), { description: 'Client IDs exempt from consent checks' }),
  requiredForResourceTypes: t.Array(t.String(), { description: 'Resource types that require consent' }),
  exemptResourceTypes: t.Array(t.String(), { description: 'Resource types exempt from consent checks' }),
  appUrl: t.Union([t.String(), t.Null()], { description: 'URL to the consent management app (shown in 403 responses when consent is denied)' })
}, { title: 'ConsentConfig' })

export type ConsentConfigType = Static<typeof ConsentConfig>

/**
 * IAL (Identity Assurance Level) configuration
 */
export const IalLevel = t.Union([
  t.Literal('level1'),
  t.Literal('level2'),
  t.Literal('level3'),
  t.Literal('level4')
], { description: 'Identity Assurance Level per NIST SP 800-63-3' })

export const IalConfigSchema = t.Object({
  enabled: t.Boolean({ description: 'Whether IAL verification is enabled' }),
  minimumLevel: IalLevel,
  sensitiveResourceTypes: t.Array(t.String(), { description: 'Resource types requiring elevated IAL' }),
  sensitiveMinimumLevel: IalLevel,
  verifyPatientLink: t.Boolean({ description: 'Verify patient claim matches Person links' }),
  allowOnPersonLookupFailure: t.Boolean({ description: 'Allow access if Person lookup fails' }),
  cacheTtl: t.Number({ description: 'Cache TTL for Person lookups in milliseconds' })
}, { title: 'IalConfig' })

export type IalConfigSchemaType = Static<typeof IalConfigSchema>

/**
 * Consent cache statistics
 */
export const ConsentCacheStats = t.Object({
  size: t.Number({ description: 'Number of entries in cache' }),
  entries: t.Array(t.Object({
    key: t.String({ description: 'Cache key' }),
    consentCount: t.Number({ description: 'Number of consents cached' }),
    expiresIn: t.Number({ description: 'Seconds until expiration' })
  }))
}, { title: 'ConsentCacheStats' })

export type ConsentCacheStatsType = Static<typeof ConsentCacheStats>

/**
 * Consent denied error response
 */
export const ConsentDeniedResponse = t.Object({
  error: t.Literal('consent_denied'),
  message: t.String({ description: 'Human-readable error message' }),
  consentId: t.Union([t.String(), t.Null()], { description: 'Consent that denied access' }),
  patientId: t.Union([t.String(), t.Null()], { description: 'Patient ID' }),
  clientId: t.String({ description: 'Client ID' }),
  resourceType: t.Union([t.String(), t.Null()], { description: 'Resource type attempted' })
}, { title: 'ConsentDeniedResponse' })

export type ConsentDeniedResponseType = Static<typeof ConsentDeniedResponse>

// ── Admin response/request wrappers ─────────────────────────────────────────

/** Consent config update response */
export const ConsentConfigUpdateResponse = t.Object({
  message: t.String(),
  config: ConsentConfig,
  timestamp: t.String()
})

/** IAL config update response */
export const IalConfigUpdateResponse = t.Object({
  message: t.String(),
  config: IalConfigSchema,
  timestamp: t.String()
})

/** Consent cache invalidation request */
export const ConsentCacheInvalidateRequest = t.Object({
  patientId: t.Optional(t.String({ description: 'Patient ID to invalidate (optional)' })),
  serverName: t.Optional(t.String({ description: 'Server name to invalidate (optional)' })),
  all: t.Optional(t.Boolean({ description: 'Clear entire cache (default: false)' }))
})

/** Consent cache invalidation response */
export const ConsentCacheInvalidateResponse = t.Object({
  message: t.String(),
  entriesInvalidated: t.Number(),
  timestamp: t.String()
})

// ── SMART Access Control schemas ────────────────────────────────────────────

const AccessControlMode = t.Union(ConsentMode.anyOf, { description: 'Access control enforcement mode' })

/** SMART access control configuration (scope enforcement + role-based filtering) */
export const SmartAccessControlConfig = t.Object({
  scopeEnforcement: AccessControlMode,
  roleBasedFiltering: AccessControlMode,
  patientScopedResources: t.Array(t.String(), { description: 'Resource types subject to patient-scoped filtering' }),
  externalAudiences: t.Array(t.String(), { description: 'Allowed external resource server audiences (aud/resource). Entries starting with \'.\'  match all subdomains (e.g. \'.maxhealth.tech\' matches dicom.maxhealth.tech). Exact URLs also supported.' }),
}, { title: 'SmartAccessControlConfig' })

export type SmartAccessControlConfigType = Static<typeof SmartAccessControlConfig>

/** SMART access control config update response */
export const SmartAccessControlConfigUpdateResponse = t.Object({
  message: t.String(),
  config: SmartAccessControlConfig,
  timestamp: t.String()
})
