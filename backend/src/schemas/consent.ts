// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { t, type Static } from 'elysia'

export const ConsentDecision = t.Union([
  t.Literal('permit'),
  t.Literal('deny')
], { description: 'Consent decision result' })

export type ConsentDecisionType = Static<typeof ConsentDecision>

export const ConsentMode = t.Union([
  t.Literal('enforce'),
  t.Literal('audit-only'),
  t.Literal('disabled')
], { description: 'Consent enforcement mode' })

export type ConsentModeType = Static<typeof ConsentMode>

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

export const ConsentCheckResult = t.Object({
  decision: ConsentDecision,
  consentId: t.Union([t.String(), t.Null()], { description: 'Consent resource that authorized/denied access' }),
  reason: t.String({ description: 'Reason for the decision' }),
  cached: t.Boolean({ description: 'Whether decision was from cache' }),
  checkDurationMs: t.Number({ description: 'Time taken for consent check in milliseconds' }),
  context: ConsentCheckContext
}, { title: 'ConsentCheckResult' })

export type ConsentCheckResultType = Static<typeof ConsentCheckResult>

export const ConsentConfig = t.Object({
  enabled: t.Boolean({ description: 'Whether consent enforcement is enabled' }),
  mode: ConsentMode,
  cacheTtl: t.Number({ description: 'Cache TTL in milliseconds' }),
  exemptClients: t.Array(t.String(), { description: 'Client IDs exempt from consent checks' }),
  requiredForResourceTypes: t.Array(t.String(), { description: 'Resource types that require consent' }),
  exemptResourceTypes: t.Array(t.String(), { description: 'Resource types exempt from consent checks' }),
  appUrl: t.Union([t.String(), t.Null()], { description: 'URL to the consent management app (shown in 403 responses when consent is denied)' }),
  appClientId: t.Optional(t.Union([t.String(), t.Null()], {
    description: 'Client ID of the SMART app serving as the consent app. Its URL wins over appUrl, which stays the fallback. Omitted on update keeps the saved value.'
  }))
}, { title: 'ConsentConfig' })

export type ConsentConfigType = Static<typeof ConsentConfig>

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
  cacheTtl: t.Number({ description: 'Cache TTL for Person lookups in milliseconds' }),
  onboardingUrl: t.Optional(t.Union([t.String({ format: 'uri' }), t.Null()], {
    description: 'Page where a user links their account to a patient record, offered as error_uri when a launch is refused because the account has none. Null shows the refusal without a link; omitted on update keeps the saved value. Defaults to PATIENT_ONBOARDING_URL.'
  })),
  onboardingAppClientId: t.Optional(t.Union([t.String(), t.Null()], {
    description: 'Client ID of the SMART app serving as the onboarding page. Its URL wins over onboardingUrl, which stays the fallback. Omitted on update keeps the saved value.'
  }))
}, { title: 'IalConfig' })

export type IalConfigSchemaType = Static<typeof IalConfigSchema>

export const ConsentCacheStats = t.Object({
  size: t.Number({ description: 'Number of entries in cache' }),
  entries: t.Array(t.Object({
    key: t.String({ description: 'Cache key' }),
    consentCount: t.Number({ description: 'Number of consents cached' }),
    expiresIn: t.Number({ description: 'Seconds until expiration' })
  }))
}, { title: 'ConsentCacheStats' })

export type ConsentCacheStatsType = Static<typeof ConsentCacheStats>

export const ConsentDeniedResponse = t.Object({
  error: t.Literal('consent_denied'),
  message: t.String({ description: 'Human-readable error message' }),
  consentId: t.Union([t.String(), t.Null()], { description: 'Consent that denied access' }),
  patientId: t.Union([t.String(), t.Null()], { description: 'Patient ID' }),
  clientId: t.String({ description: 'Client ID' }),
  resourceType: t.Union([t.String(), t.Null()], { description: 'Resource type attempted' })
}, { title: 'ConsentDeniedResponse' })

export type ConsentDeniedResponseType = Static<typeof ConsentDeniedResponse>

export const ConsentConfigUpdateResponse = t.Object({
  message: t.String(),
  config: ConsentConfig,
  timestamp: t.String()
})

export const IalConfigUpdateResponse = t.Object({
  message: t.String(),
  config: IalConfigSchema,
  timestamp: t.String()
})

export const ConsentCacheInvalidateRequest = t.Object({
  patientId: t.Optional(t.String({ description: 'Patient ID to invalidate (optional)' })),
  serverName: t.Optional(t.String({ description: 'Server name to invalidate (optional)' })),
  all: t.Optional(t.Boolean({ description: 'Clear entire cache (default: false)' }))
})

export const ConsentCacheInvalidateResponse = t.Object({
  message: t.String(),
  entriesInvalidated: t.Number(),
  timestamp: t.String()
})

/** Rewrite stored Consents whose root rule carries a type into the R4 shape */
export const ConsentR4MigrationRequest = t.Object({
  apply: t.Optional(t.Boolean({ description: 'Write the rewritten Consents (default: false, a dry run that only reports them)' })),
  serverName: t.Optional(t.String({ description: 'FHIR server to migrate (default: the first configured server)' })),
})

export const ConsentR4MigrationResponse = t.Object({
  server: t.String(),
  consentsRead: t.Number(),
  pending: t.Array(t.Object({ id: t.String(), status: t.String(), rootType: t.String() })),
  written: t.Number(),
  failed: t.Array(t.Object({ id: t.String(), status: t.Number(), detail: t.String() })),
  applied: t.Boolean(),
})

const AccessControlMode = t.Union(ConsentMode.anyOf, { description: 'Access control enforcement mode' })

export const SmartAccessControlConfig = t.Object({
  scopeEnforcement: AccessControlMode,
  roleBasedFiltering: AccessControlMode,
  fhirAudienceEnforcement: t.Optional(t.Union(ConsentMode.anyOf, { description: 'Whether the access token of a FHIR request must name the FHIR base of the server it reaches (or that server resource client) in aud. Defaults to the access posture in backend/src/lib/access-posture.json.' })),
  externalAudiences: t.Array(t.String(), { description: 'Allowed external resource server audiences (aud/resource). Entries starting with \'.\'  match all subdomains (e.g. \'.maxhealth.tech\' matches dicom.maxhealth.tech). Exact URLs also supported.' }),
}, { title: 'SmartAccessControlConfig' })

export type SmartAccessControlConfigType = Static<typeof SmartAccessControlConfig>

export const SmartAccessControlConfigUpdateResponse = t.Object({
  message: t.String(),
  config: SmartAccessControlConfig,
  timestamp: t.String()
})

export const PatientAccessEntry = t.Object({
  id: t.String(),
  timestamp: t.String({ description: 'When the decision was made (ISO 8601)' }),
  decision: ConsentDecision,
  clientId: t.String({ description: 'Client that made the request' }),
  username: t.Union([t.String(), t.Null()], { description: 'User who made the request, when known' }),
  resourceType: t.Union([t.String(), t.Null()], { description: 'FHIR resource type requested' }),
  method: t.String({ description: 'HTTP method' }),
  reason: t.String({ description: 'Why consent permitted or denied the request' }),
}, { title: 'PatientAccessEntry' })

export type PatientAccessEntryType = Static<typeof PatientAccessEntry>

export const PatientAccessLogResponse = t.Object({
  events: t.Array(PatientAccessEntry),
  total: t.Number(),
  timestamp: t.String(),
}, { title: 'PatientAccessLogResponse' })

export const AccessRequestNotificationResponse = t.Object({
  sent: t.Boolean({ description: 'Whether the email was sent' }),
  reason: t.Optional(t.String({ description: 'Why no email was sent' })),
}, { title: 'AccessRequestNotificationResponse' })
