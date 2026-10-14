// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Consent Service
 *
 * Core consent enforcement logic:
 * - Query FHIR Consent resources from upstream server
 * - Evaluate consent provisions against request context
 * - Make allow/deny decisions
 * - Audit logging
 * - Integrates with IAL (Identity Assurance Level) for Person→Patient verification
 *
 * TWO UNRELATED THINGS ARE CALLED CONSENT. This file only ever means the FHIR
 * `Consent` resource: the patient's standing decision about who may reach their
 * data. The OAuth consent screen (Keycloak's `consentRequired` on a client, where
 * a user approves the scopes an app asked for) is a different act at a different
 * layer and grants no access to anyone's record. Say "OAuth consent" for that one.
 *
 * The rule this enforces: a patient's data may be reached by SOMEONE ELSE only if
 * the patient consented to that someone. Reaching one's own record is not a
 * disclosure and needs no Consent — see {@link isSelfAccess}.
 */

import { parseTokenScopes } from '@proxy-smart/auth'
import type {
  FhirConsent,
  ConsentCheckContext,
  ConsentCheckResult,
  ConsentAuditEntry,
  ConsentConfig,
  ConsentDecision,
  SmartTokenPayload,
  ConsentProvision,
  FhirPeriod
} from './types'
import { bundleResources, getConsentProvision, getProvisionClasses, getProvisionType, isFhirConsent } from './types'
import { consentCache } from './consent-cache'
import { resolveFhirUserForClient } from './person-resolver'
import { logger } from '../logger'
import { getRuntimeConsentConfig } from '../runtime-config'
import { consentMetricsLogger, type ConsentDecisionEvent } from '../consent-metrics-logger'
import { normalizeFhirUser, resolveTokenPatientId } from '../patient-context'
import { isRecord, optionalString } from '../type-guards'
import { PATIENT_COMPARTMENT } from '../patient-compartment/definition'

/**
 * Whose consent governs this request. The token decides, not the URL.
 *
 * Reading the id from the path meant a token for patient A asking for
 * `Patient/B` was evaluated against B's consent, which a broad Consent on B
 * permitted. The URL stays as a last resort only: dropping it would turn those
 * requests into "No patient context" and skip the check entirely.
 */
async function extractPatientId(
  tokenPayload: SmartTokenPayload,
  resourcePath: string
): Promise<string | null> {
  const fromToken = await resolveTokenPatientId(tokenPayload)
  if (fromToken) {
    return fromToken
  }

  const patientMatch = resourcePath.match(/^Patient\/([^/]+)/)
  if (patientMatch) {
    return patientMatch[1]
  }

  return null
}

/**
 * Extract resource type from path
 */
function extractResourceType(resourcePath: string): string | null {
  if (!resourcePath || resourcePath === '/') {
    return null
  }
  
  // Handle paths like "Patient/123" or "Observation?patient=..."
  const parts = resourcePath.split(/[/?]/)
  const resourceType = parts[0]
  
  // Validate it looks like a FHIR resource type (PascalCase)
  if (resourceType && /^[A-Z][a-zA-Z]+$/.test(resourceType)) {
    return resourceType
  }
  
  return null
}

/**
 * Extract resource ID from path
 */
function extractResourceId(resourcePath: string): string | null {
  // Match patterns like "Patient/123" or "Patient/123/_history/1"
  const match = resourcePath.match(/^[A-Z][a-zA-Z]+\/([^/?]+)/)
  return match ? match[1] : null
}

/**
 * Build consent check context from request and token
 */
export async function buildConsentContext(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  resourcePath: string,
  method: string
): Promise<ConsentCheckContext> {
  return {
    patientId: await extractPatientId(tokenPayload, resourcePath),
    clientId: tokenPayload.azp || tokenPayload.sub || 'unknown',
    resourceType: extractResourceType(resourcePath),
    resourceId: extractResourceId(resourcePath),
    method: method.toUpperCase(),
    resourcePath,
    serverName,
    scopes: [...parseTokenScopes(tokenPayload)],
    fhirUser: tokenPayload.fhirUser || null
  }
}

/**
 * Check if a period is currently active
 */
function isPeriodActive(period: FhirPeriod | undefined): boolean {
  if (!period) {
    return true // No period specified = always active
  }

  const now = new Date()
  
  if (period.start) {
    const start = new Date(period.start)
    if (now < start) {
      return false // Not yet started
    }
  }
  
  if (period.end) {
    const end = new Date(period.end)
    if (now > end) {
      return false // Already ended
    }
  }
  
  return true
}

/**
 * Does this Consent name the party making the request?
 *
 * `provision.actor` is the GRANTEE — "the recipient this consent names". The
 * consent portal writes a `Practitioner/<id>` there (role PRCP) when a patient
 * approves an access request, so the party to match is the requesting USER, not
 * the app they happen to be using. Matching only `clientId` meant every consent
 * a patient ever granted was ignored: `Practitioner/dr-123` never contains
 * `aihr-portal`, so no actor matched and the decision fell through to deny.
 *
 * clientId still matches, for grants written against an app rather than a person
 * (a `Device/<client>` actor, or an identifier carrying the client id).
 *
 * An actor-less provision names no recipient, so it grants nothing. It used to
 * mean "applies to every client", which inverted the model: the unscoped consent
 * permitted everyone while the scoped one permitted no one.
 */
function consentAppliesToRequester(
  consent: FhirConsent,
  requester: { clientId: string; fhirUser: string | null },
): boolean {
  const provision = getConsentProvision(consent)
  if (!provision?.actor?.length) {
    return false
  }

  const user = requester.fhirUser ? normalizeFhirUser(requester.fhirUser) : null

  for (const actor of provision.actor) {
    const ref = actor.reference?.reference || ''
    const identifier = actor.reference?.identifier?.value || ''

    if (user && ref && normalizeFhirUser(ref) === user) {
      return true
    }
    if (ref.includes(requester.clientId) || identifier === requester.clientId) {
      return true
    }
  }

  return false
}

/**
 * Check if consent provision covers the requested resource type
 */
function provisionCoversResourceType(provision: ConsentProvision, resourceType: string | null): boolean {
  if (!resourceType) {
    return true // Can't determine resource type, be permissive
  }

  // If no class restrictions, covers all resources
  const classes = getProvisionClasses(provision)
  if (!classes.length) {
    return true
  }

  // Check if resource type is in the class list
  // FHIR uses system "http://hl7.org/fhir/resource-types"
  for (const cls of classes) {
    if (cls.code === resourceType) {
      return true
    }
  }

  return false
}

/**
 * Evaluate a single consent against the request context
 */
function evaluateConsent(consent: FhirConsent, context: ConsentCheckContext): ConsentDecision | null {
  // Must be active status
  if (consent.status !== 'active') {
    return null
  }

  // Must name the party asking
  if (!consentAppliesToRequester(consent, { clientId: context.clientId, fhirUser: context.fhirUser })) {
    return null
  }

  const provision = getConsentProvision(consent)
  if (!provision) {
    // No provision = default permit (consent exists but no restrictions)
    return 'permit'
  }

  // Check provision period
  if (!isPeriodActive(provision.period)) {
    return null // Provision not active
  }

  // Check if provision covers the resource type
  if (!provisionCoversResourceType(provision, context.resourceType)) {
    return null // Provision doesn't apply to this resource
  }

  // Return the provision type (permit/deny)
  // Default to permit if no type specified (consent exists = permission)
  return getProvisionType(provision)
}

/**
 * Query FHIR server for Consent resources
 */
async function fetchConsents(
  serverUrl: string,
  patientId: string,
  clientId: string,
  authHeader: string
): Promise<FhirConsent[]> {
  // Build search query for active consents for this patient
  // Note: Filtering by actor (client) is done in-memory as FHIR Consent search
  // doesn't always support complex actor queries
  const searchUrl = `${serverUrl}/Consent?patient=Patient/${patientId}&status=active&_count=100`

  logger.consent.debug('Fetching consents from FHIR server', { 
    searchUrl: searchUrl.replace(serverUrl, '[server]'),
    patientId,
    clientId
  })

  try {
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/fhir+json',
        'Authorization': authHeader
      }
    })

    if (!response.ok) {
      // Log but don't throw - treat as no consents found
      logger.consent.warn('Failed to fetch consents', { 
        status: response.status,
        statusText: response.statusText
      })
      return []
    }

    const bundle: unknown = await response.json()
    const consents = bundleResources(bundle, isFhirConsent)

    logger.consent.debug('Fetched consents', {
      total: isRecord(bundle) ? bundle.total : undefined,
      returned: consents.length 
    })

    return consents
  } catch (error) {
    logger.consent.error('Error fetching consents', { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    })
    return []
  }
}

type IalAuditSummary = ConsentDecisionEvent['ial']

/** Log a consent decision for the audit trail; an `ialCheck` key marks a combined Consent+IAL decision. */
export function logAuditEntry(
  entry: ConsentAuditEntry & { ialCheck?: IalAuditSummary },
  extra?: { cached?: boolean; checkDurationMs?: number },
): void {
  const level = entry.decision === 'deny' && entry.enforced ? 'warn' : 'info'
  const withIal = entry.ialCheck !== undefined
  const ial = entry.ialCheck ?? null

  logger.consent[level](withIal ? 'Consent+IAL decision' : 'Consent decision', {
    decision: entry.decision,
    enforced: entry.enforced,
    mode: entry.mode,
    consentId: entry.consentId,
    patientId: entry.patientId,
    clientId: entry.clientId,
    resourceType: entry.resourceType,
    method: entry.method,
    serverName: entry.serverName,
    reason: entry.reason,
    ...(withIal && {
      ial: ial && { allowed: ial.allowed, level: ial.actualLevel, required: ial.requiredLevel, sensitive: ial.isSensitiveResource },
    }),
  })

  consentMetricsLogger.logDecision({
    ...(withIal && { ial }),
    decision: entry.decision,
    enforced: entry.enforced,
    mode: entry.mode,
    consentId: entry.consentId,
    patientId: entry.patientId,
    clientId: entry.clientId,
    userId: entry.userId,
    username: entry.username,
    resourceType: entry.resourceType,
    resourcePath: entry.resourcePath,
    serverName: entry.serverName,
    method: entry.method,
    reason: entry.reason,
    cached: extra?.cached ?? false,
    checkDurationMs: extra?.checkDurationMs ?? 0,
  })
}

/**
 * Get consent configuration (runtime: realm attributes merged over env vars)
 */
export function getConsentConfig(): ConsentConfig {
  return getRuntimeConsentConfig()
}

/**
 * Check if consent check should be skipped for this context
 */
async function shouldSkipConsentCheck(
  context: ConsentCheckContext,
  consentConfig: ConsentConfig,
  ownPatientOf: OwnPatientResolver,
): Promise<string | null> {
  // Check if consent enforcement is disabled
  if (!consentConfig.enabled || consentConfig.mode === 'disabled') {
    return 'Consent enforcement disabled'
  }

  // Check if client is exempt
  if (consentConfig.exemptClients.includes(context.clientId)) {
    return `Client ${context.clientId} is exempt from consent checks`
  }

  // Check if resource type is exempt
  if (context.resourceType && consentConfig.exemptResourceTypes.includes(context.resourceType)) {
    return `Resource type ${context.resourceType} is exempt from consent checks`
  }

  // A consent governs disclosure of the patient's own data, which is what the compartment holds.
  if (context.resourceType && !PATIENT_COMPARTMENT.has(context.resourceType)) {
    return `Resource type ${context.resourceType} is outside the patient compartment`
  }

  // Check if we need consent for this resource type (if list is specified)
  if (consentConfig.requiredForResourceTypes.length > 0) {
    if (!context.resourceType || !consentConfig.requiredForResourceTypes.includes(context.resourceType)) {
      return `Resource type ${context.resourceType || 'unknown'} not in required list`
    }
  }

  // Check if we have a patient context
  if (!context.patientId) {
    return 'No patient context - cannot check consent'
  }

  if (await isSelfAccess(context, ownPatientOf)) {
    return 'Patient is accessing their own record'
  }

  return null // Don't skip
}

/**
 * Is the requester the patient whose data this is?
 *
 * A FHIR Consent authorizes DISCLOSURE to someone else. A patient reading their
 * own record discloses nothing, and a right of access is not a grant the subject
 * makes to themselves — gating it on a Consent would let a missing or lapsed one
 * lock a patient out of their own chart. Whether the patient authorized the APP
 * is a real question, but it is OAuth consent and Keycloak already records it.
 *
 * Derived per REQUEST, not per client, because a client can serve both
 * populations: the same viewer used by a practitioner is a disclosure and stays
 * enforced. That is what an `exemptClients` entry cannot express.
 *
 * A Person fhirUser is the patient when the Patient it links to is the one the request is about.
 */
async function isSelfAccess(context: ConsentCheckContext, ownPatientOf: OwnPatientResolver): Promise<boolean> {
  if (!context.fhirUser || !context.patientId) return false
  const user = normalizeFhirUser(context.fhirUser)
  if (user.startsWith('Patient/')) return user.slice('Patient/'.length) === context.patientId
  if (!user.startsWith('Person/')) return false
  const linked = await ownPatientOf(context.fhirUser)
  if (!linked) return false
  return normalizeFhirUser(linked).replace(/^Patient\//, '') === context.patientId
}

/** The Patient a Person fhirUser links to, as a reference, or undefined. */
type OwnPatientResolver = (fhirUser: string) => Promise<string | undefined>

export function tokenIdentity(tokenPayload: SmartTokenPayload): { userId: string | null; username: string | null } {
  return {
    userId: optionalString(tokenPayload.sub) || null,
    username: optionalString(tokenPayload.preferred_username) || null,
  }
}

/**
 * Main consent check function
 */
export async function checkConsent(
  tokenPayload: SmartTokenPayload,
  serverName: string,
  serverUrl: string,
  resourcePath: string,
  method: string,
  authHeader: string,
  configOverride?: ConsentConfig
): Promise<ConsentCheckResult> {
  const startTime = performance.now()
  const consentConfig = configOverride ?? getConsentConfig()
  const context = await buildConsentContext(tokenPayload, serverName, resourcePath, method)
  const { userId, username } = tokenIdentity(tokenPayload)

  // Check if we should skip consent checking
  const ownPatientOf: OwnPatientResolver = (fhirUser) =>
    resolveFhirUserForClient(fhirUser, true, serverUrl, serverName, authHeader).catch(() => undefined)
  const skipReason = await shouldSkipConsentCheck(context, consentConfig, ownPatientOf)
  if (skipReason) {
    const result: ConsentCheckResult = {
      decision: 'permit',
      consentId: null,
      reason: skipReason,
      cached: false,
      checkDurationMs: performance.now() - startTime,
      context
    }

    // Still log in audit-only mode
    if (consentConfig.mode === 'audit-only') {
      logAuditEntry({
        timestamp: new Date().toISOString(),
        decision: result.decision,
        consentId: result.consentId,
        patientId: context.patientId,
        clientId: context.clientId,
        userId,
        username,
        resourceType: context.resourceType,
        resourcePath: context.resourcePath,
        serverName: context.serverName,
        method: context.method,
        scopes: context.scopes,
        reason: result.reason,
        mode: consentConfig.mode,
        enforced: false
      }, { cached: false, checkDurationMs: result.checkDurationMs })
    }

    return result
  }

  // Try cache first
  const cacheKey = {
    patientId: context.patientId!,
    clientId: context.clientId,
    serverName: context.serverName
  }
  
  let consents = consentCache.get(cacheKey)
  const cached = consents !== null

  // Fetch from FHIR server if not cached
  if (!consents) {
    consents = await fetchConsents(
      serverUrl,
      context.patientId!,
      context.clientId,
      authHeader
    )
    
    // Cache the results
    consentCache.set(cacheKey, consents, consentConfig.cacheTtl)
  }

  // Evaluate consents
  let decision: ConsentDecision = 'deny'
  let matchingConsentId: string | null = null
  let reason = 'No valid consent found for this client and resource'

  for (const consent of consents) {
    const consentDecision = evaluateConsent(consent, context)
    
    if (consentDecision === 'permit') {
      decision = 'permit'
      matchingConsentId = consent.id ? `Consent/${consent.id}` : null
      reason = `Access permitted by consent ${matchingConsentId || '(anonymous)'}`
      break // First permit wins
    } else if (consentDecision === 'deny') {
      // Explicit deny
      decision = 'deny'
      matchingConsentId = consent.id ? `Consent/${consent.id}` : null
      reason = `Access denied by consent ${matchingConsentId || '(anonymous)'}`
      // Continue checking - a later permit might override
    }
  }

  const checkDurationMs = performance.now() - startTime

  const result: ConsentCheckResult = {
    decision,
    consentId: matchingConsentId,
    reason,
    cached,
    checkDurationMs,
    context
  }

  // Log audit entry
  logAuditEntry({
    timestamp: new Date().toISOString(),
    decision: result.decision,
    consentId: result.consentId,
    patientId: context.patientId,
    clientId: context.clientId,
    userId,
    username,
    resourceType: context.resourceType,
    resourcePath: context.resourcePath,
    serverName: context.serverName,
    method: context.method,
    scopes: context.scopes,
    reason: result.reason,
    mode: consentConfig.mode,
    enforced: consentConfig.mode === 'enforce'
  }, { cached, checkDurationMs })

  return result
}

/**
 * Invalidate consent cache for a patient (call when consent is updated)
 */
export function invalidateConsentCache(patientId: string, serverName?: string): void {
  consentCache.invalidatePatient(patientId, serverName)
}

/**
 * Get consent cache statistics
 */
export function getConsentCacheStats() {
  return consentCache.getStats()
}
