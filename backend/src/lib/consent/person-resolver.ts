// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Person Resolver Service
 * 
 * Resolves Person resources from FHIR server to validate and enrich
 * identity information including Patient links and IAL (Identity Assurance Level).
 * 
 * This service:
 * - Fetches Person resources from FHIR server based on fhirUser claim
 * - Extracts linked Patient references with their assurance levels
 * - Validates that token's patient claim matches Person's links
 * - Provides IAL-based access gating for sensitive resources
 * - Auto-detects FHIR version (R3/R4/R5) and handles version-specific differences
 */

import type {
  FhirPerson,
  SmartTokenPayload,
  IdentityAssuranceLevel,
  ResolvedPatientIdentity,
  PersonResolutionResult,
  IalConfig,
  IalCheckResult
} from './types'
import { getFhirUserResourceType } from '@proxy-smart/auth'
import { IAL_LEVELS, isFhirPerson, isIdentityAssuranceLevel } from './types'
import { logger } from '../logger'
import { isRecord } from '../type-guards'
import { getRuntimeIalConfig } from '../runtime-config'
import { getCachedPerson, setCachedPerson } from './person-cache'

export { clearPersonCache, getPersonCacheStats } from './person-cache'

// =============================================================================
// PERSON RESOLUTION
// =============================================================================

/**
 * Extract Person ID from fhirUser claim
 * Expected format: "Person/123" or full URL "https://fhir.example.com/Person/123"
 */
function extractPersonId(fhirUser: string): string | null {
  if (!fhirUser) {
    return null
  }
  
  // Handle full URL format
  const urlMatch = fhirUser.match(/Person\/([a-zA-Z0-9\-.]+)/)
  if (urlMatch) {
    return urlMatch[1]
  }
  
  // Handle relative reference
  if (fhirUser.startsWith('Person/')) {
    return fhirUser.replace('Person/', '')
  }
  
  return null
}

/**
 * Extract Patient ID from reference
 * Expected format: "Patient/123" or full URL
 */
function extractPatientIdFromReference(reference: string): string | null {
  if (!reference) {
    return null
  }
  
  const match = reference.match(/Patient\/([a-zA-Z0-9\-.]+)/)
  return match ? match[1] : null
}

/**
 * Normalize assurance level from FHIR PersonLink
 * FHIR uses 'level1' | 'level2' | 'level3' | 'level4'
 */
function normalizeAssuranceLevel(assurance: string | undefined): IdentityAssuranceLevel {
  if (!assurance) {
    return 'level1' // Default to lowest confidence if not specified
  }
  
  const normalized = assurance.toLowerCase()
  if (isIdentityAssuranceLevel(normalized)) {
    return normalized
  }
  
  // Handle potential alternate formats
  if (normalized.includes('1') || normalized === 'low') return 'level1'
  if (normalized.includes('2') || normalized === 'medium') return 'level2'
  if (normalized.includes('3') || normalized === 'high') return 'level3'
  if (normalized.includes('4') || normalized === 'very-high') return 'level4'
  
  return 'level1'
}

/**
 * Extract linked patients from Person resource
 * Handles FHIR R3, R4, and R5 differences:
 * - R3: Person.link[].target (Reference), Person.link[].assurance (code)
 * - R4: Person.link[].target (Reference), Person.link[].assurance (code)
 * - R5: Person.link[].target (Reference), Person.link[].assurance (code)
 * 
 * The structure is similar across versions, but we handle edge cases.
 */
/** The Person.link fields read here, identical across R3, R4 and R5. */
interface PersonLinkView {
  target?: { reference?: string }
  assurance?: string
}

function personLinks(person: FhirPerson): PersonLinkView[] {
  return Array.isArray(person.link) ? person.link : []
}

function extractLinkedPatients(person: FhirPerson, personId: string): ResolvedPatientIdentity[] {
  const linkedPatients: ResolvedPatientIdentity[] = []
  
  for (const link of personLinks(person)) {
    // Get target reference - structure is same across versions
    const targetRef = link.target?.reference
    if (!targetRef) {
      continue
    }
    
    // Only process Patient links
    const patientId = extractPatientIdFromReference(targetRef)
    if (!patientId) {
      continue
    }
    
    // Get assurance level - exists in R4/R5, may be undefined in R3
    const assuranceLevel = normalizeAssuranceLevel(link.assurance)
    
    linkedPatients.push({
      patientId,
      patientReference: `Patient/${patientId}`,
      assuranceLevel,
      assuranceLevelNumeric: IAL_LEVELS[assuranceLevel],
      personId,
      verified: true // We got this from FHIR server
    })
  }
  
  return linkedPatients
}

// =============================================================================
// FHIR USER RESOLUTION (Per-Client Identity Selection)
// =============================================================================

const LINKED_IDENTITY_TYPES = ['Patient', 'Practitioner', 'RelatedPerson'] as const

/** Represents a linked FHIR identity from a Person resource */
export interface ResolvedFhirIdentity {
  resourceType: (typeof LINKED_IDENTITY_TYPES)[number]
  /** Resource ID */
  resourceId: string
  /** Full relative reference (e.g., "Practitioner/abc") */
  reference: string
  /** Assurance level of the link */
  assuranceLevel: IdentityAssuranceLevel
}

/**
 * Extract all linked identities from a Person resource (Patient, Practitioner, RelatedPerson).
 * Used for per-client fhirUser resolution (patientFacing flag).
 */
export function extractLinkedIdentities(person: FhirPerson): ResolvedFhirIdentity[] {
  const identities: ResolvedFhirIdentity[] = []

  for (const link of personLinks(person)) {
    const targetRef = link.target?.reference
    if (!targetRef) continue

    const match = targetRef.match(/(Patient|Practitioner|RelatedPerson)\/([a-zA-Z0-9\-.]+)/)
    const resourceType = LINKED_IDENTITY_TYPES.find((type) => type === match?.[1])
    if (!match || !resourceType) continue

    const resourceId = match[2]
    const assuranceLevel = normalizeAssuranceLevel(link.assurance)

    identities.push({
      resourceType,
      resourceId,
      reference: `${resourceType}/${resourceId}`,
      assuranceLevel,
    })
  }

  return identities
}

/**
 * Resolve fhirUser for a specific client based on its patientFacing configuration.
 *
 * Resolution rules:
 * - If patientFacing is undefined → return raw fhirUser unchanged (backward compat)
 * - If raw fhirUser already matches the expected type → return as-is
 * - If raw fhirUser is Person/* → fetch Person, find matching link
 * - If no matching link found → return undefined (omit claim)
 */
export async function resolveFhirUserForClient(
  rawFhirUser: string,
  patientFacing: boolean | undefined,
  serverUrl: string,
  serverName: string,
  authHeader: string
): Promise<string | undefined> {
  // No resolution configured → backward compat
  if (patientFacing === undefined) {
    return rawFhirUser
  }

  const expectedType = patientFacing ? 'Patient' : 'Practitioner'
  const acceptedTypes = patientFacing ? ['Patient'] : ['Practitioner', 'PractitionerRole']

  const rawType = getFhirUserResourceType(rawFhirUser)
  if (rawType && acceptedTypes.includes(rawType)) {
    return rawFhirUser
  }

  // Check for standalone Person reference (not RelatedPerson)
  // Match "Person/" at start, or preceded by "/" (URL path), but NOT preceded by "Related"
  const isPersonRef = /(?<![A-Za-z])Person\//.test(rawFhirUser)

  if (!isPersonRef) {
    // Not a Person reference and doesn't match expected type → omit
    return undefined
  }

  // Resolve Person → find matching identity link
  const personId = rawFhirUser.match(/(?<![A-Za-z])Person\/([a-zA-Z0-9\-.]+)/)?.[1]
  if (!personId) {
    return undefined
  }

  // Check cache first
  const cachedPerson = getCachedPerson(serverName, personId)
  let person: FhirPerson | null

  if (cachedPerson !== undefined) {
    person = cachedPerson
  } else {
    person = await fetchPerson(serverUrl, personId, authHeader)
    const ialConfig = getIalConfig()
    setCachedPerson(serverName, personId, person, ialConfig.cacheTtl)
  }

  if (!person) {
    return undefined
  }

  const identities = extractLinkedIdentities(person)
  const match = identities.find(i => i.resourceType === expectedType)

  if (!match) {
    logger.consent.debug('No matching identity link for client type', {
      personId,
      expectedType,
      availableTypes: identities.map(i => i.resourceType),
    })
    return undefined
  }

  return match.reference
}

/**
 * Fetch Person resource from FHIR server
 */
async function fetchPerson(
  serverUrl: string,
  personId: string,
  authHeader?: string
): Promise<FhirPerson | null> {
  const url = `${serverUrl}/Person/${personId}`
  
  logger.consent.debug('Fetching Person from FHIR server', {
    url: url.replace(serverUrl, '[server]'),
    personId
  })
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/fhir+json',
        // Omitted at launch time, when no token exists yet. The upstream is reached server-side
        // and directly, exactly as the picker's own patient search already does.
        ...(authHeader ? { Authorization: authHeader } : {}),
      }
    })
    
    if (response.status === 404) {
      logger.consent.debug('Person not found', { personId })
      return null
    }
    
    if (!response.ok) {
      logger.consent.warn('Failed to fetch Person', {
        status: response.status,
        statusText: response.statusText,
        personId
      })
      return null
    }
    
    const person: unknown = await response.json()

    if (!isFhirPerson(person)) {
      logger.consent.warn('Unexpected resource type', {
        expected: 'Person',
        actual: isRecord(person) ? person.resourceType : undefined
      })
      return null
    }
    
    logger.consent.debug('Fetched Person', {
      personId,
      linkCount: person.link?.length ?? 0
    })
    
    return person
  } catch (error) {
    logger.consent.error('Error fetching Person', {
      error: error instanceof Error ? error.message : 'Unknown error',
      personId
    })
    return null
  }
}

/**
 * Resolve Person from fhirUser claim
 */
export async function resolvePerson(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  authHeader: string
): Promise<PersonResolutionResult> {
  const startTime = performance.now()
  const ialConfig = getIalConfig()
  
  // Check if fhirUser points to a Person
  const personId = extractPersonId(tokenPayload.fhirUser || '')
  
  if (!personId) {
    return {
      success: false,
      error: 'No Person reference in fhirUser claim',
      linkedPatients: [],
      patientLinkVerified: false,
      cached: false,
      resolutionDurationMs: performance.now() - startTime
    }
  }
  
  // Check cache first
  const cachedPerson = getCachedPerson(serverName, personId)
  if (cachedPerson !== undefined) {
    // Cache hit (could be null = "not found" was cached)
    if (cachedPerson === null) {
      return {
        success: false,
        error: 'Person not found (cached)',
        linkedPatients: [],
        patientLinkVerified: false,
        cached: true,
        resolutionDurationMs: performance.now() - startTime
      }
    }
    
    const linkedPatients = extractLinkedPatients(cachedPerson, personId)
    const validatedPatient = validatePatientLink(linkedPatients, tokenPayload.patient)
    
    return {
      success: true,
      person: cachedPerson,
      linkedPatients,
      validatedPatient,
      patientLinkVerified: validatedPatient !== undefined,
      cached: true,
      resolutionDurationMs: performance.now() - startTime
    }
  }
  
  // Fetch from FHIR server
  const person = await fetchPerson(serverUrl, personId, authHeader)
  
  // Cache the result (including "not found")
  setCachedPerson(serverName, personId, person, ialConfig.cacheTtl)
  
  if (!person) {
    return {
      success: false,
      error: 'Person not found',
      linkedPatients: [],
      patientLinkVerified: false,
      cached: false,
      resolutionDurationMs: performance.now() - startTime
    }
  }
  
  const linkedPatients = extractLinkedPatients(person, personId)
  const validatedPatient = validatePatientLink(linkedPatients, tokenPayload.patient)
  
  return {
    success: true,
    person,
    linkedPatients,
    validatedPatient,
    patientLinkVerified: validatedPatient !== undefined,
    cached: false,
    resolutionDurationMs: performance.now() - startTime
  }
}

/**
 * Validate that patient claim matches one of the Person's linked patients
 */
function validatePatientLink(
  linkedPatients: ResolvedPatientIdentity[],
  smartPatient: string | undefined
): ResolvedPatientIdentity | undefined {
  if (!smartPatient) {
    return undefined
  }
  
  // Find matching patient link
  return linkedPatients.find(p => p.patientId === smartPatient)
}

// =============================================================================
// IAL CONFIGURATION
// =============================================================================

/**
 * Get IAL configuration (runtime: realm attributes merged over env vars)
 */
export function getIalConfig(): IalConfig {
  return getRuntimeIalConfig()
}

// =============================================================================
// IAL CHECK
// =============================================================================

/**
 * Check if IAL requirements are met for the request
 */
export async function checkIal(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  resourceType: string | null,
  authHeader: string
): Promise<IalCheckResult> {
  const ialConfig = getIalConfig()
  
  // If IAL checking is disabled, always allow
  if (!ialConfig.enabled) {
    return {
      allowed: true,
      reason: 'IAL checking disabled',
      actualLevel: null,
      requiredLevel: 'level1',
      isSensitiveResource: false,
      personResolution: null
    }
  }
  
  // Determine required level based on resource type
  const isSensitiveResource = resourceType !== null && 
    ialConfig.sensitiveResourceTypes.includes(resourceType)
  const requiredLevel = isSensitiveResource 
    ? ialConfig.sensitiveMinimumLevel 
    : ialConfig.minimumLevel
  const requiredLevelNumeric = IAL_LEVELS[requiredLevel]
  
  // Resolve Person to get IAL
  const personResolution = await resolvePerson(
    tokenPayload,
    serverName,
    serverUrl,
    authHeader
  )
  
  // Handle resolution failure
  if (!personResolution.success) {
    if (ialConfig.allowOnPersonLookupFailure) {
      logger.consent.warn('Person resolution failed, allowing due to config', {
        error: personResolution.error,
        resourceType,
        requiredLevel
      })
      return {
        allowed: true,
        reason: `Person resolution failed (${personResolution.error}), allowing due to config`,
        actualLevel: null,
        requiredLevel,
        isSensitiveResource,
        personResolution
      }
    }
    
    return {
      allowed: false,
      reason: `Person resolution failed: ${personResolution.error}`,
      actualLevel: null,
      requiredLevel,
      isSensitiveResource,
      personResolution
    }
  }
  
  // Check patient link verification if required
  if (ialConfig.verifyPatientLink && tokenPayload.patient) {
    if (!personResolution.patientLinkVerified) {
      return {
        allowed: false,
        reason: `Patient ${tokenPayload.patient} not linked to Person ${personResolution.person?.id}`,
        actualLevel: personResolution.validatedPatient?.assuranceLevel ?? null,
        requiredLevel,
        isSensitiveResource,
        personResolution
      }
    }
  }
  
  // Get the IAL from the validated patient link
  const actualLevel = personResolution.validatedPatient?.assuranceLevel ?? null
  const actualLevelNumeric = actualLevel ? IAL_LEVELS[actualLevel] : 0
  
  // Check if IAL meets requirements
  if (actualLevelNumeric < requiredLevelNumeric) {
    return {
      allowed: false,
      reason: `IAL ${actualLevel ?? 'unknown'} does not meet required ${requiredLevel} for ${isSensitiveResource ? 'sensitive ' : ''}resource ${resourceType}`,
      actualLevel,
      requiredLevel,
      isSensitiveResource,
      personResolution
    }
  }
  
  return {
    allowed: true,
    reason: `IAL ${actualLevel} meets required ${requiredLevel}`,
    actualLevel,
    requiredLevel,
    isSensitiveResource,
    personResolution
  }
}

/**
 * Quick check if Person has a link to the given patient
 * Used when we don't need full IAL checking
 */
export async function verifyPatientLinkOnly(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  authHeader: string
): Promise<{ verified: boolean; reason: string }> {
  const patientId = tokenPayload.patient
  
  if (!patientId) {
    return { verified: true, reason: 'No patient context to verify' }
  }
  
  if (!tokenPayload.fhirUser?.includes('Person/')) {
    return { verified: true, reason: 'fhirUser is not a Person reference' }
  }
  
  const resolution = await resolvePerson(tokenPayload, serverName, serverUrl, authHeader)
  
  if (!resolution.success) {
    // Fail open if person lookup fails (configurable)
    const ialConfig = getIalConfig()
    if (ialConfig.allowOnPersonLookupFailure) {
      return { verified: true, reason: `Person lookup failed, allowing: ${resolution.error}` }
    }
    return { verified: false, reason: `Person lookup failed: ${resolution.error}` }
  }
  
  if (!resolution.patientLinkVerified) {
    return { 
      verified: false, 
      reason: `Patient ${patientId} not linked to Person ${resolution.person?.id}` 
    }
  }
  
  return { 
    verified: true, 
    reason: `Patient ${patientId} verified via Person link (IAL: ${resolution.validatedPatient?.assuranceLevel})` 
  }
}

/**
 * The identities a `Person` fhirUser links to, for the launch to choose between.
 *
 * Reuses the same cache and the same reader the token endpoint uses — this is the SAME question
 * asked earlier, while there is still a browser to ask a human. Answering it at the token endpoint
 * is what forced a guess from `patient_facing`.
 *
 * Returns [] for anything that is not a Person, or a Person that could not be read. The caller
 * treats that as "could not decide" and falls through to the behaviour that existed before.
 */
export async function identitiesForPerson(
  fhirUser: string,
  serverUrl: string,
  serverName: string,
  authHeader?: string
): Promise<ResolvedFhirIdentity[]> {
  const personId = extractPersonId(fhirUser)
  if (!personId) return []

  const cached = getCachedPerson(serverName, personId)
  let person: FhirPerson | null
  if (cached !== undefined) {
    person = cached
  } else {
    person = await fetchPerson(serverUrl, personId, authHeader)
    setCachedPerson(serverName, personId, person, getIalConfig().cacheTtl)
  }

  return person ? extractLinkedIdentities(person) : []
}
