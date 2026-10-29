// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { JwtPayload } from 'jsonwebtoken'
import type { EnforcementMode } from '@/lib/enforcement-mode'
import { isRecord } from '@/lib/type-guards'

import type {
  Consent as ConsentR3,
  Person as PersonR3,
  Bundle as BundleR3,
  Reference as ReferenceR3,
  Coding as CodingR3,
  CodeableConcept as CodeableConceptR3,
  Period as PeriodR3,
  Identifier as IdentifierR3
} from 'fhir/r3'

import type {
  Consent as ConsentR4,
  Person as PersonR4,
  PersonLink as PersonLinkR4,
  Bundle as BundleR4,
  Reference as ReferenceR4,
  Coding as CodingR4,
  CodeableConcept as CodeableConceptR4,
  Period as PeriodR4,
  Identifier as IdentifierR4,
  ConsentProvision as ConsentProvisionR4
} from 'fhir/r4'

import type {
  Consent as ConsentR5,
  Person as PersonR5,
  PersonLink as PersonLinkR5,
  Bundle as BundleR5,
  Reference as ReferenceR5,
  Coding as CodingR5,
  CodeableConcept as CodeableConceptR5,
  Period as PeriodR5,
  Identifier as IdentifierR5,
  ConsentProvision as ConsentProvisionR5
} from 'fhir/r5'

export type { ConsentR3, PersonR3, BundleR3, ReferenceR3, CodingR3, PeriodR3 }
export type { ConsentR4, PersonR4, PersonLinkR4, BundleR4, ReferenceR4, CodingR4, PeriodR4, ConsentProvisionR4 }
export type { ConsentR5, PersonR5, PersonLinkR5, BundleR5, ReferenceR5, CodingR5, PeriodR5, ConsentProvisionR5 }

export type FhirConsent = ConsentR3 | ConsentR4 | ConsentR5

export type FhirPerson = PersonR3 | PersonR4 | PersonR5

/** R4/R5 only; R3 Person.link has a different shape. */
export type FhirPersonLink = PersonLinkR4 | PersonLinkR5

export type FhirReference = ReferenceR3 | ReferenceR4 | ReferenceR5

export type FhirCoding = CodingR3 | CodingR4 | CodingR5

export type FhirCodeableConcept = CodeableConceptR3 | CodeableConceptR4 | CodeableConceptR5

export type FhirPeriod = PeriodR3 | PeriodR4 | PeriodR5

export type FhirIdentifier = IdentifierR3 | IdentifierR4 | IdentifierR5

export type FhirConsentProvision = ConsentProvisionR4 | ConsentProvisionR5

export type ConsentProvision = FhirConsentProvision

export type FhirVersion = 'R3' | 'STU3' | 'R4' | 'R5'

/** R3 uses `except` instead of `provision`. */
export function isR4OrR5Consent(consent: FhirConsent): consent is ConsentR4 | ConsentR5 {
  return 'provision' in consent || consent.resourceType === 'Consent'
}

export function getConsentProvision(consent: FhirConsent): FhirConsentProvision | undefined {
  if (!('provision' in consent) || !consent.provision) return undefined
  // R5 allows a list here; R4 a single element. Callers read one provision.
  return Array.isArray(consent.provision) ? consent.provision[0] : consent.provision
}

export function getProvisionClasses(provision: FhirConsentProvision): Array<{ code?: string }> {
  // R4 and R5 both carry `class`, but the union does not surface it.
  if (!('class' in provision) || !Array.isArray(provision.class)) return []
  return provision.class
}

export function getProvisionType(provision: FhirConsentProvision): 'permit' | 'deny' {
  // Anything that is not an explicit deny is treated as permit.
  const provisionType = 'type' in provision ? provision.type : undefined
  return provisionType === 'deny' ? 'deny' : 'permit'
}

export interface FhirBundle<T = unknown> {
  resourceType: 'Bundle'
  id?: string
  type?: string
  total?: number
  entry?: FhirBundleEntry<T>[]
}

export interface FhirBundleEntry<T = unknown> {
  fullUrl?: string
  resource?: T
}

export function isFhirConsent(value: unknown): value is FhirConsent {
  return isRecord(value) && value.resourceType === 'Consent'
}

export function isFhirPerson(value: unknown): value is FhirPerson {
  return isRecord(value) && value.resourceType === 'Person'
}

/** Resources of an upstream searchset that pass `guard`; anything not a Bundle yields none. */
export function bundleResources<T>(bundle: unknown, guard: (value: unknown) => value is T): T[] {
  if (!isRecord(bundle) || !Array.isArray(bundle.entry)) return []
  return bundle.entry.flatMap((entry: unknown) => (isRecord(entry) && guard(entry.resource) ? [entry.resource] : []))
}

export type ConsentMode = EnforcementMode

export type ConsentDecision = 'permit' | 'deny'

export interface SmartTokenPayload extends JwtPayload {
  /** Client ID (authorized party) */
  azp?: string
  /** Granted scopes (space-separated) */
  scope?: string
  patient?: string
  encounter?: string
  /** FHIR User reference (e.g., Person/123, Practitioner/456) */
  fhirUser?: string
}

export interface ConsentCheckContext {
  patientId: string | null
  clientId: string
  resourceType: string | null
  resourceId: string | null
  method: string
  resourcePath: string
  serverName: string
  scopes: string[]
  fhirUser: string | null
}

export interface ConsentCheckResult {
  decision: ConsentDecision
  consentId: string | null
  reason: string
  cached: boolean
  checkDurationMs: number
  context: ConsentCheckContext
}

export interface ConsentAuditEntry {
  timestamp: string
  decision: ConsentDecision
  consentId: string | null
  patientId: string | null
  clientId: string
  userId: string | null
  username: string | null
  resourceType: string | null
  resourcePath: string
  serverName: string
  method: string
  scopes: string[]
  reason: string
  mode: ConsentMode
  enforced: boolean
}

export interface ConsentCacheKey {
  patientId: string
  clientId: string
  serverName: string
}

export interface ConsentCacheEntry {
  consents: FhirConsent[]
  fetchedAt: number
  expiresAt: number
}

export interface ConsentConfig {
  enabled: boolean
  mode: ConsentMode
  /** Milliseconds */
  cacheTtl: number
  exemptClients: string[]
  /** Resource types that require consent (empty = all) */
  requiredForResourceTypes: string[]
  exemptResourceTypes: string[]
  /** URL to the consent management app (shown in 403 responses) */
  appUrl: string | null
}

/** NIST SP 800-63-3 IAL, as carried in FHIR Person.link.assurance. */
export type IdentityAssuranceLevel = 'level1' | 'level2' | 'level3' | 'level4'

export const IAL_LEVELS: Record<IdentityAssuranceLevel, number> = {
  level1: 1, // Little or no confidence (self-asserted)
  level2: 2, // Some confidence (remote identity proofing)
  level3: 3, // High confidence (in-person or supervised remote proofing)
  level4: 4  // Very high confidence (in-person with biometrics)
}

export function isIdentityAssuranceLevel(value: string): value is IdentityAssuranceLevel {
  return Object.prototype.hasOwnProperty.call(IAL_LEVELS, value)
}

export interface ResolvedPatientIdentity {
  patientId: string
  /** Full FHIR reference (Patient/123) */
  patientReference: string
  assuranceLevel: IdentityAssuranceLevel
  assuranceLevelNumeric: number
  personId: string
  verified: boolean
}

export interface PersonResolutionResult {
  success: boolean
  error?: string
  person?: FhirPerson
  linkedPatients: ResolvedPatientIdentity[]
  validatedPatient?: ResolvedPatientIdentity
  patientLinkVerified: boolean
  cached: boolean
  resolutionDurationMs: number
}

export interface IalConfig {
  enabled: boolean
  minimumLevel: IdentityAssuranceLevel
  sensitiveResourceTypes: string[]
  sensitiveMinimumLevel: IdentityAssuranceLevel
  /** Whether to verify patient claim matches Person links */
  verifyPatientLink: boolean
  allowOnPersonLookupFailure: boolean
  /** Milliseconds */
  cacheTtl: number
}

export interface IalCheckResult {
  allowed: boolean
  reason: string
  actualLevel: IdentityAssuranceLevel | null
  requiredLevel: IdentityAssuranceLevel
  isSensitiveResource: boolean
  personResolution: PersonResolutionResult | null
}

export interface ConsentCheckContextWithIal extends ConsentCheckContext {
  ialEnabled: boolean
  ialMinimumLevel: IdentityAssuranceLevel
  isSensitiveResource: boolean
  assuranceLevel: IdentityAssuranceLevel | null
  assuranceLevelNumeric: number | null
  patientLinkVerified: boolean
  personId: string | null
}

export interface ConsentCheckResultWithIal extends ConsentCheckResult {
  ialCheck: IalCheckResult | null
  context: ConsentCheckContextWithIal
}
