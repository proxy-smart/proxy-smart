// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import {
  type FhirPerson,
  type SmartTokenPayload,
  type IdentityAssuranceLevel,
  type ResolvedPatientIdentity,
  type PersonResolutionResult,
  type IalConfig,
  type IalCheckResult,
  IAL_LEVELS,
  isFhirPerson,
  isIdentityAssuranceLevel,
} from './types'
import { getFhirUserResourceType } from '@proxy-smart/auth'
import { logger } from '../logger'
import { isRecord } from '../type-guards'
import { getRuntimeIalConfig } from '../runtime-config'
import { getCachedPerson, setCachedPerson } from './person-cache'
import { upstreamFetch } from '../upstream-fetch'

export { clearPersonCache, getPersonCacheStats } from './person-cache'

function extractPersonId(fhirUser: string): string | null {
  if (!fhirUser) {
    return null
  }

  const urlMatch = fhirUser.match(/Person\/([a-zA-Z0-9\-.]+)/)
  if (urlMatch) {
    return urlMatch[1]
  }
  
  if (fhirUser.startsWith('Person/')) {
    return fhirUser.replace('Person/', '')
  }
  
  return null
}

function extractPatientIdFromReference(reference: string): string | null {
  if (!reference) {
    return null
  }
  
  const match = reference.match(/Patient\/([a-zA-Z0-9\-.]+)/)
  return match ? match[1] : null
}

function normalizeAssuranceLevel(assurance: string | undefined): IdentityAssuranceLevel {
  if (!assurance) {
    return 'level1'
  }
  
  const normalized = assurance.toLowerCase()
  if (isIdentityAssuranceLevel(normalized)) {
    return normalized
  }
  
  if (normalized.includes('1') || normalized === 'low') return 'level1'
  if (normalized.includes('2') || normalized === 'medium') return 'level2'
  if (normalized.includes('3') || normalized === 'high') return 'level3'
  if (normalized.includes('4') || normalized === 'very-high') return 'level4'
  
  return 'level1'
}

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
    const targetRef = link.target?.reference
    if (!targetRef) {
      continue
    }
    
    const patientId = extractPatientIdFromReference(targetRef)
    if (!patientId) {
      continue
    }
    
    const assuranceLevel = normalizeAssuranceLevel(link.assurance)
    
    linkedPatients.push({
      patientId,
      patientReference: `Patient/${patientId}`,
      assuranceLevel,
      assuranceLevelNumeric: IAL_LEVELS[assuranceLevel],
      personId,
      verified: true
    })
  }
  
  return linkedPatients
}

const LINKED_IDENTITY_TYPES = ['Patient', 'Practitioner', 'RelatedPerson'] as const

export interface ResolvedFhirIdentity {
  resourceType: (typeof LINKED_IDENTITY_TYPES)[number]
  resourceId: string
  reference: string
  assuranceLevel: IdentityAssuranceLevel
}

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

/** Maps a Person fhirUser to the linked identity the client's patientFacing flag expects; undefined omits the claim. */
export async function resolveFhirUserForClient(
  rawFhirUser: string,
  patientFacing: boolean | undefined,
  serverUrl: string,
  serverName: string,
  authHeader: string
): Promise<string | undefined> {
  if (patientFacing === undefined) {
    return rawFhirUser
  }

  const expectedType = patientFacing ? 'Patient' : 'Practitioner'
  const acceptedTypes = patientFacing ? ['Patient'] : ['Practitioner', 'PractitionerRole']

  const rawType = getFhirUserResourceType(rawFhirUser)
  if (rawType && acceptedTypes.includes(rawType)) {
    return rawFhirUser
  }

  // The lookbehind keeps RelatedPerson/ from counting as a Person reference.
  const isPersonRef = /(?<![A-Za-z])Person\//.test(rawFhirUser)

  if (!isPersonRef) {
    return undefined
  }

  const personId = rawFhirUser.match(/(?<![A-Za-z])Person\/([a-zA-Z0-9\-.]+)/)?.[1]
  if (!personId) {
    return undefined
  }

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
    const response = await upstreamFetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/fhir+json',
        // Omitted at launch time, when no token exists yet.
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

export async function resolvePerson(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  authHeader: string
): Promise<PersonResolutionResult> {
  const startTime = performance.now()
  const ialConfig = getIalConfig()

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
  
  const cachedPerson = getCachedPerson(serverName, personId)
  if (cachedPerson !== undefined) {
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
  
  const person = await fetchPerson(serverUrl, personId, authHeader)

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

function validatePatientLink(
  linkedPatients: ResolvedPatientIdentity[],
  smartPatient: string | undefined
): ResolvedPatientIdentity | undefined {
  if (!smartPatient) {
    return undefined
  }
  
  return linkedPatients.find(p => p.patientId === smartPatient)
}

/** Realm attributes merged over env vars. */
export function getIalConfig(): IalConfig {
  return getRuntimeIalConfig()
}

export async function checkIal(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  resourceType: string | null,
  authHeader: string
): Promise<IalCheckResult> {
  const ialConfig = getIalConfig()

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
  
  const isSensitiveResource = resourceType !== null && 
    ialConfig.sensitiveResourceTypes.includes(resourceType)
  const requiredLevel = isSensitiveResource 
    ? ialConfig.sensitiveMinimumLevel 
    : ialConfig.minimumLevel
  const requiredLevelNumeric = IAL_LEVELS[requiredLevel]
  
  const personResolution = await resolvePerson(
    tokenPayload,
    serverName,
    serverUrl,
    authHeader
  )
  
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
  
  const actualLevel = personResolution.validatedPatient?.assuranceLevel ?? null
  const actualLevelNumeric = actualLevel ? IAL_LEVELS[actualLevel] : 0
  
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

/** The identities a Person fhirUser links to, so the launch can ask the user; [] means undecided. */
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
