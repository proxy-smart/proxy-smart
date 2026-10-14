// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Enforcement Module
 * 
 * Provides FHIR Consent-based access control for the SMART on FHIR proxy.
 * Includes IAL (Identity Assurance Level) verification for Person→Patient linking.
 * 
 * Usage:
 * ```typescript
 * import { checkConsentWithIal, getConsentConfig, getIalConfig } from './lib/consent'
 * 
 * // In FHIR proxy middleware - combined consent + IAL check
 * const result = await checkConsentWithIal(tokenPayload, serverName, serverUrl, resourcePath, method, authHeader)
 * if (result.decision === 'deny' && getConsentConfig().mode === 'enforce') {
 *   // Block request - could be consent denial OR IAL verification failure
 * }
 * 
 * // Or check consent only
 * const consentResult = await checkConsent(tokenPayload, serverName, serverUrl, resourcePath, method, authHeader)
 * 
 * // Or check IAL only
 * const ialResult = await checkIal(tokenPayload, serverName, serverUrl, resourceType, authHeader)
 * ```
 */

// Types
export type {
  ConsentMode,
  ConsentDecision,
  ConsentCheckContext,
  ConsentCheckResult,
  ConsentAuditEntry,
  ConsentConfig,
  FhirConsent,
  FhirBundle,
  SmartTokenPayload,
  // IAL types
  IdentityAssuranceLevel,
  ResolvedPatientIdentity,
  PersonResolutionResult,
  IalConfig,
  IalCheckResult,
  ConsentCheckContextWithIal,
  ConsentCheckResultWithIal,
  FhirPerson,
  FhirPersonLink
} from './types'

export { IAL_LEVELS } from './types'

// Service functions - Consent
export {
  checkConsent,
  buildConsentContext,
  getConsentConfig,
  invalidateConsentCache,
  getConsentCacheStats
} from './consent-service'
export { checkConsentWithIal, buildConsentContextWithIal } from './consent-ial'

// Service functions - IAL/Person resolver
export {
  resolvePerson,
  checkIal,
  verifyPatientLinkOnly,
  getIalConfig,
  clearPersonCache,
  getPersonCacheStats
} from './person-resolver'

// Cache (for advanced usage)
export { consentCache, ConsentCache } from './consent-cache'
