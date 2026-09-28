// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Enforcement Types
 * 
 * TypeScript types for FHIR Consent resources and enforcement decisions.
 * Uses @types/fhir for standard FHIR type definitions across R3, R4, and R5.
 * The proxy auto-detects FHIR version from server metadata.
 */

import type { JwtPayload } from 'jsonwebtoken'
import type { EnforcementMode } from '@/lib/enforcement-mode'

// =============================================================================
// FHIR VERSION-SPECIFIC IMPORTS
// =============================================================================

// R3 (STU3) types
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

// R4 types
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

// R5 types
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

// =============================================================================
// EXPORT VERSION-SPECIFIC TYPES
// =============================================================================

export type { ConsentR3, PersonR3, BundleR3, ReferenceR3, CodingR3, PeriodR3 }
export type { ConsentR4, PersonR4, PersonLinkR4, BundleR4, ReferenceR4, CodingR4, PeriodR4, ConsentProvisionR4 }
export type { ConsentR5, PersonR5, PersonLinkR5, BundleR5, ReferenceR5, CodingR5, PeriodR5, ConsentProvisionR5 }

// =============================================================================
// VERSION-AGNOSTIC UNION TYPES (works with any FHIR version)
// =============================================================================

/** FHIR Consent resource (any version) */
export type FhirConsent = ConsentR3 | ConsentR4 | ConsentR5

/** FHIR Person resource (any version) */
export type FhirPerson = PersonR3 | PersonR4 | PersonR5

/** FHIR Person.link element (R4/R5 - R3 uses different structure) */
export type FhirPersonLink = PersonLinkR4 | PersonLinkR5

/** FHIR Reference (any version) */
export type FhirReference = ReferenceR3 | ReferenceR4 | ReferenceR5

/** FHIR Coding (any version) */
export type FhirCoding = CodingR3 | CodingR4 | CodingR5

/** FHIR CodeableConcept (any version) */
export type FhirCodeableConcept = CodeableConceptR3 | CodeableConceptR4 | CodeableConceptR5

/** FHIR Period (any version) */
export type FhirPeriod = PeriodR3 | PeriodR4 | PeriodR5

/** FHIR Identifier (any version) */
export type FhirIdentifier = IdentifierR3 | IdentifierR4 | IdentifierR5

/** FHIR Consent.provision (R4/R5) */
export type FhirConsentProvision = ConsentProvisionR4 | ConsentProvisionR5

// Consent.provision type alias for backward compatibility
export type ConsentProvision = FhirConsentProvision

/**
 * Supported FHIR versions
 */
export type FhirVersion = 'R3' | 'STU3' | 'R4' | 'R5'

// =============================================================================
// TYPE GUARDS FOR FHIR VERSION DETECTION
// =============================================================================

/**
 * Check if consent is R4 or R5 (has 'provision' property)
 * R3 uses 'except' instead of 'provision'
 */
export function isR4OrR5Consent(consent: FhirConsent): consent is ConsentR4 | ConsentR5 {
  return 'provision' in consent || consent.resourceType === 'Consent'
}

/**
 * Get consent provision from any FHIR version
 * Returns R4/R5 provision or undefined for R3
 */
export function getConsentProvision(consent: FhirConsent): FhirConsentProvision | undefined {
  if (!('provision' in consent) || !consent.provision) return undefined
  // R5 allows a list here; R4 a single element. Callers read one provision.
  return Array.isArray(consent.provision) ? consent.provision[0] : consent.provision
}

/**
 * Get provision class/resourceType restrictions
 * Works across R4 and R5 provision types
 */
export function getProvisionClasses(provision: FhirConsentProvision): Array<{ code?: string }> {
  // R4 and R5 both carry `class`, but the union does not surface it.
  if (!('class' in provision) || !Array.isArray(provision.class)) return []
  return provision.class
}

/**
 * Get provision type (permit/deny)
 * Works across R4 and R5 provision types
 */
export function getProvisionType(provision: FhirConsentProvision): 'permit' | 'deny' {
  // Anything that is not an explicit deny is treated as permit.
  const provisionType = 'type' in provision ? provision.type : undefined
  return provisionType === 'deny' ? 'deny' : 'permit'
}

/**
 * Generic FHIR Bundle with typed entries (any version)
 */
export interface FhirBundle<T = unknown> {
  resourceType: 'Bundle'
  id?: string
  type?: string
  total?: number
  entry?: FhirBundleEntry<T>[]
}

/**
 * FHIR Bundle entry with typed resource
 */
export interface FhirBundleEntry<T = unknown> {
  fullUrl?: string
  resource?: T
}

// =============================================================================
// CONSENT ENFORCEMENT TYPES
// =============================================================================

/**
 * Consent enforcement mode
 * - 'enforce': Block requests without valid consent
 * - 'audit-only': Log consent decisions but allow all requests
 * - 'disabled': No consent checking
 */
export type ConsentMode = EnforcementMode

/**
 * Consent decision result
 */
export type ConsentDecision = 'permit' | 'deny'

/**
 * Token payload with SMART claims
 */
export interface SmartTokenPayload extends JwtPayload {
  /** Client ID (authorized party) */
  azp?: string
  /** Granted scopes (space-separated) */
  scope?: string
  /** Patient ID from SMART launch context */
  patient?: string
  /** Encounter ID from SMART launch context */
  encounter?: string
  /** FHIR User reference (e.g., Person/123, Practitioner/456) */
  fhirUser?: string
}

/**
 * Consent check request context
 */
export interface ConsentCheckContext {
  /** Patient ID (from token or request) */
  patientId: string | null
  /** Client ID (from token azp claim) */
  clientId: string
  /** Resource type being accessed (e.g., 'Patient', 'Observation') */
  resourceType: string | null
  /** Resource ID being accessed (if specific resource) */
  resourceId: string | null
  /** HTTP method (GET, POST, etc.) */
  method: string
  /** Full resource path */
  resourcePath: string
  /** FHIR server identifier */
  serverName: string
  /** Granted scopes */
  scopes: string[]
  /** FHIR User reference (if present) */
  fhirUser: string | null
}

/**
 * Consent check result
 */
export interface ConsentCheckResult {
  /** Whether access is permitted */
  decision: ConsentDecision
  /** Consent resource that authorized/denied access (if found) */
  consentId: string | null
  /** Reason for the decision */
  reason: string
  /** Whether decision was from cache */
  cached: boolean
  /** Time taken for consent check (ms) */
  checkDurationMs: number
  /** The context that was evaluated */
  context: ConsentCheckContext
}

/**
 * Consent audit log entry
 */
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

/**
 * Consent cache key components
 */
export interface ConsentCacheKey {
  patientId: string
  clientId: string
  serverName: string
}

/**
 * Consent cache entry
 */
export interface ConsentCacheEntry {
  consents: FhirConsent[]
  fetchedAt: number
  expiresAt: number
}

/**
 * Consent service configuration
 */
export interface ConsentConfig {
  /** Whether consent enforcement is enabled */
  enabled: boolean
  /** Enforcement mode */
  mode: ConsentMode
  /** Cache TTL in milliseconds */
  cacheTtl: number
  /** Client IDs exempt from consent checks */
  exemptClients: string[]
  /** Resource types that require consent (empty = all) */
  requiredForResourceTypes: string[]
  /** Resource types exempt from consent checks */
  exemptResourceTypes: string[]
  /** URL to the consent management app (shown in 403 responses) */
  appUrl: string | null
}

// =============================================================================
// PERSON-PATIENT LINKING & IAL TYPES
// =============================================================================

/**
 * Identity Assurance Level (IAL) as per NIST SP 800-63-3
 * Maps to FHIR Person.link.assurance values
 */
export type IdentityAssuranceLevel = 'level1' | 'level2' | 'level3' | 'level4'

/**
 * Numeric IAL values for comparison
 */
export const IAL_LEVELS: Record<IdentityAssuranceLevel, number> = {
  level1: 1, // Little or no confidence (self-asserted)
  level2: 2, // Some confidence (remote identity proofing)
  level3: 3, // High confidence (in-person or supervised remote proofing)
  level4: 4  // Very high confidence (in-person with biometrics)
}

/**
 * Resolved patient identity from Person resource
 */
export interface ResolvedPatientIdentity {
  /** The Patient resource ID */
  patientId: string
  /** Full FHIR reference (Patient/123) */
  patientReference: string
  /** IAL of the Person→Patient link */
  assuranceLevel: IdentityAssuranceLevel
  /** Numeric IAL for comparison */
  assuranceLevelNumeric: number
  /** Person resource ID that linked to this patient */
  personId: string
  /** Whether this was the primary/verified link */
  verified: boolean
}

/**
 * Person resolution result
 */
export interface PersonResolutionResult {
  /** Whether resolution was successful */
  success: boolean
  /** Error message if failed */
  error?: string
  /** The Person resource (if found) */
  person?: FhirPerson
  /** All linked patient identities with IAL */
  linkedPatients: ResolvedPatientIdentity[]
  /** The specific patient that was validated (if patient claim was provided) */
  validatedPatient?: ResolvedPatientIdentity
  /** Whether patient claim was verified against Person links */
  patientLinkVerified: boolean
  /** Cache status */
  cached: boolean
  /** Resolution time */
  resolutionDurationMs: number
}

/**
 * IAL requirement configuration
 */
export interface IalConfig {
  /** Whether IAL verification is enabled */
  enabled: boolean
  /** Minimum IAL required for general access */
  minimumLevel: IdentityAssuranceLevel
  /** Higher IAL requirements for sensitive resources */
  sensitiveResourceTypes: string[]
  /** Minimum IAL for sensitive resources */
  sensitiveMinimumLevel: IdentityAssuranceLevel
  /** Whether to verify patient claim matches Person links */
  verifyPatientLink: boolean
  /** Whether to allow access if Person lookup fails */
  allowOnPersonLookupFailure: boolean
  /** Cache TTL for Person lookups (ms) */
  cacheTtl: number
}

/**
 * IAL check result
 */
export interface IalCheckResult {
  /** Whether IAL requirements are met */
  allowed: boolean
  /** Reason for the decision */
  reason: string
  /** The assurance level found */
  actualLevel: IdentityAssuranceLevel | null
  /** The required level for this operation */
  requiredLevel: IdentityAssuranceLevel
  /** Whether this was for a sensitive resource */
  isSensitiveResource: boolean
  /** Person resolution details */
  personResolution: PersonResolutionResult | null
}

/**
 * Extended consent check context with IAL info
 */
export interface ConsentCheckContextWithIal extends ConsentCheckContext {
  /** Whether IAL checking is enabled */
  ialEnabled: boolean
  /** Minimum IAL required for general access */
  ialMinimumLevel: IdentityAssuranceLevel
  /** Whether this is a sensitive resource type */
  isSensitiveResource: boolean
  /** Resolved identity assurance level */
  assuranceLevel: IdentityAssuranceLevel | null
  /** Numeric IAL for comparison */
  assuranceLevelNumeric: number | null
  /** Whether patient link was verified via Person */
  patientLinkVerified: boolean
  /** Person ID if resolved */
  personId: string | null
}

/**
 * Extended consent check result with IAL info
 */
export interface ConsentCheckResultWithIal extends ConsentCheckResult {
  /** IAL check result */
  ialCheck: IalCheckResult | null
  /** Extended context with IAL */
  context: ConsentCheckContextWithIal
}
