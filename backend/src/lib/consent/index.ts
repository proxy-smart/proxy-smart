// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

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

export {
  checkConsent,
  buildConsentContext,
  getConsentConfig,
  invalidateConsentCache,
  getConsentCacheStats
} from './consent-service'
export { checkConsentWithIal, buildConsentContextWithIal } from './consent-ial'

export {
  resolvePerson,
  checkIal,
  verifyPatientLinkOnly,
  getIalConfig,
  clearPersonCache,
  getPersonCacheStats
} from './person-resolver'

export { consentCache, ConsentCache } from './consent-cache'
