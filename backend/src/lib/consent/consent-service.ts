// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// "Consent" here is always the FHIR Consent resource, never Keycloak's OAuth consent screen.
// It gates disclosure to someone else; reaching one's own record needs none (isSelfAccess).

import { parseTokenScopes } from '@proxy-smart/auth'
import {
  type FhirConsent,
  type ConsentCheckContext,
  type ConsentCheckResult,
  type ConsentAuditEntry,
  type ConsentConfig,
  type ConsentDecision,
  type SmartTokenPayload,
  bundleResources,
  isFhirConsent,
} from './types'
import { addedByRequester } from './added-by-requester'
import { actingPractitioner, practitionerOrganizations } from './organization-membership'
import { consentOperation, consentRuling, type ConsentRequest } from './provision-rules'
import { consentCache } from './consent-cache'
import { invalidateRecordCustody } from './record-custody'
import { resolveFhirUserForClient } from './person-resolver'
import { logger } from '../logger'
import { getRuntimeConsentConfig } from '../runtime-config'
import { consentMetricsLogger, type ConsentDecisionEvent } from '../consent-metrics-logger'
import { normalizeFhirUser, resolveTokenPatientId } from '../patient-context'
import { isRecord, optionalString } from '../type-guards'
import { PATIENT_COMPARTMENT } from '../patient-compartment/definition'
import { upstreamFetch } from '../upstream-fetch'

// The token decides whose consent governs; the path is a last resort so the check is never skipped.
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

function extractResourceType(resourcePath: string): string | null {
  if (!resourcePath || resourcePath === '/') {
    return null
  }

  const parts = resourcePath.split(/[/?]/)
  const resourceType = parts[0]
  
  if (resourceType && /^[A-Z][a-zA-Z]+$/.test(resourceType)) {
    return resourceType
  }
  
  return null
}

function extractResourceId(resourcePath: string): string | null {
  const match = resourcePath.match(/^[A-Z][a-zA-Z]+\/([^/?]+)/)
  return match ? match[1] : null
}

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
    fhirUser: tokenPayload.fhirUser || null,
    userId: tokenIdentity(tokenPayload).userId,
  }
}

async function fetchConsents(
  serverUrl: string,
  patientId: string,
  clientId: string,
  authHeader: string
): Promise<FhirConsent[]> {
  // Actor filtering happens in memory; FHIR Consent search support for actor queries is uneven.
  const searchUrl = `${serverUrl}/Consent?patient=Patient/${patientId}&status=active&_count=100`

  logger.consent.debug('Fetching consents from FHIR server', { 
    searchUrl: searchUrl.replace(serverUrl, '[server]'),
    patientId,
    clientId
  })

  try {
    const response = await upstreamFetch(searchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/fhir+json',
        'Authorization': authHeader
      }
    })

    if (!response.ok) {
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
  }).catch((error: unknown) => logger.consent.error('Failed to record consent decision metrics', undefined, error))
}

/** Realm attributes merged over env vars. */
export function getConsentConfig(): ConsentConfig {
  return getRuntimeConsentConfig()
}

async function planConsentCheck(
  context: ConsentCheckContext,
  consentConfig: ConsentConfig,
  ownPatientOf: OwnPatientResolver,
): Promise<{ skip: string } | { patientId: string }> {
  if (!consentConfig.enabled || consentConfig.mode === 'disabled') {
    return { skip: 'Consent enforcement disabled' }
  }

  if (consentConfig.exemptClients.includes(context.clientId)) {
    return { skip: `Client ${context.clientId} is exempt from consent checks` }
  }

  if (context.resourceType && consentConfig.exemptResourceTypes.includes(context.resourceType)) {
    return { skip: `Resource type ${context.resourceType} is exempt from consent checks` }
  }

  // A consent governs disclosure of the patient's own data, which is what the compartment holds.
  if (context.resourceType && !PATIENT_COMPARTMENT.has(context.resourceType)) {
    return { skip: `Resource type ${context.resourceType} is outside the patient compartment` }
  }

  if (consentConfig.requiredForResourceTypes.length > 0) {
    if (!context.resourceType || !consentConfig.requiredForResourceTypes.includes(context.resourceType)) {
      return { skip: `Resource type ${context.resourceType || 'unknown'} not in required list` }
    }
  }

  if (!context.patientId) {
    return { skip: 'No patient context - cannot check consent' }
  }

  if (await isSelfAccess(context, ownPatientOf)) {
    return { skip: 'Patient is accessing their own record' }
  }

  return { patientId: context.patientId }
}

// Per request, not per client: the same app used by a practitioner is still a disclosure.
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

  const ownPatientOf: OwnPatientResolver = (fhirUser) =>
    resolveFhirUserForClient(fhirUser, true, serverUrl, serverName, authHeader).catch(() => undefined)
  const plan = await planConsentCheck(context, consentConfig, ownPatientOf)
  if ('skip' in plan) {
    const result: ConsentCheckResult = {
      decision: 'permit',
      consentId: null,
      reason: plan.skip,
      cached: false,
      checkDurationMs: performance.now() - startTime,
      context
    }

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

  const { decision, consentId: matchingConsentId, reason, cached } = await consentDecisionFor(
    { ...context, patientId: plan.patientId }, serverUrl, authHeader, consentConfig,
  )
  const checkDurationMs = performance.now() - startTime

  const result: ConsentCheckResult = {
    decision,
    consentId: matchingConsentId,
    reason,
    cached,
    checkDurationMs,
    context
  }

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

export interface PatientConsentDecision {
  decision: ConsentDecision
  consentId: string | null
  reason: string
  cached: boolean
}

export async function consentDecisionFor(
  context: ConsentCheckContext & { patientId: string },
  serverUrl: string,
  authHeader: string,
  consentConfig: ConsentConfig,
): Promise<PatientConsentDecision> {
  const cacheKey = { patientId: context.patientId, clientId: context.clientId, serverName: context.serverName }
  let consents = consentCache.get(cacheKey)
  const cached = consents !== null
  if (!consents) {
    consents = await fetchConsents(serverUrl, context.patientId, context.clientId, authHeader)
    consentCache.set(cacheKey, consents, consentConfig.cacheTtl)
  }

  const practitioner = consents.length > 0
    ? await actingPractitioner(context.fhirUser, (fhirUser) =>
      resolveFhirUserForClient(fhirUser, false, serverUrl, context.serverName, authHeader).catch(() => undefined))
    : null
  const request: ConsentRequest = {
    clientId: context.clientId,
    fhirUser: context.fhirUser,
    practitioner,
    organizations: await practitionerOrganizations(context.userId, practitioner),
    resourceType: context.resourceType,
    operation: consentOperation(context.method, context.resourcePath),
    serverUrl,
  }
  const settle = (operation: ConsentRequest['operation']) => {
    const rulings = consents.map((consent) => ({ consent, ruling: consentRuling(consent, { ...request, operation }) }))
    return rulings.find(({ ruling }) => ruling === 'deny') ?? rulings.find(({ ruling }) => ruling === 'permit')
  }
  let deciding = settle(request.operation)
  if (!deciding && request.operation === 'change') {
    const asAdder = settle('add')
    if (asAdder?.ruling === 'permit' && await addedByRequester(context, serverUrl, authHeader)) deciding = asAdder
  }
  if (!deciding) return { decision: 'deny', consentId: null, reason: 'No valid consent found for this client and resource', cached }
  const consentId = deciding.consent.id ? `Consent/${deciding.consent.id}` : null
  return deciding.ruling === 'permit'
    ? { decision: 'permit', consentId, reason: `Access permitted by consent ${consentId || '(anonymous)'}`, cached }
    : { decision: 'deny', consentId, reason: `Access denied by consent ${consentId || '(anonymous)'}`, cached }
}

export async function isOwnRecord(
  context: ConsentCheckContext,
  serverUrl: string,
  authHeader: string,
): Promise<boolean> {
  return isSelfAccess(context, (fhirUser) =>
    resolveFhirUserForClient(fhirUser, true, serverUrl, context.serverName, authHeader).catch(() => undefined))
}

export function invalidateConsentCache(patientId: string, serverName?: string): void {
  consentCache.invalidatePatient(patientId, serverName)
  invalidateRecordCustody(patientId)
}

export function getConsentCacheStats() {
  return consentCache.getStats()
}
