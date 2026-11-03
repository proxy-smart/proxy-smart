// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseTokenScopes } from '@proxy-smart/auth'
import { logger } from '../logger'
import { parseFhirPath } from '../fhir-capabilities'
import { operationOutcome } from '../fhir-operation-outcome'
import { compartmentPatients, PATIENT_COMPARTMENT } from '../patient-compartment/definition'
import { isRecord } from '../type-guards'
import { buildConsentContext, consentDecisionFor, getConsentConfig, isOwnRecord } from './consent-service'
import { consentOperation } from './provision-rules'
import { screenAnswer, type ScreenedAnswer } from './screen-answer'
import type { ConsentConfig, SmartTokenPayload } from './types'

export interface ConsentScreenContext {
  tokenPayload: SmartTokenPayload
  serverName: string
  serverUrl: string
  referenceBase: string
  authHeader: string
  resourcePath: string
  method: string
}

export interface ScreenedRequest {
  tokenPayload: SmartTokenPayload
  resourcePath: string
  method: string
  body?: string
}

export type ScreenableQuery = { allowed: true; queryString: string } | { allowed: false; status: number; body: Record<string, unknown> }

const BROAD_CONTEXTS = ['user/', 'system/', 'agent/']
const CONSENT_DENIED = 'The patient has not granted this client access to their record.'
const UNSCREENABLE_SUMMARIES: ReadonlySet<string> = new Set(['count', 'text'])
const INCLUDE_PARAM_RE = /^_(rev)?include(:|$)/

export function screensConsent(tokenPayload: SmartTokenPayload): boolean {
  return [...parseTokenScopes(tokenPayload)].some((scope) => BROAD_CONTEXTS.some((context) => scope.startsWith(context)))
}

function governedPatients(resource: unknown, config: ConsentConfig, referenceBase: string): string[] {
  if (!isRecord(resource) || typeof resource.resourceType !== 'string') return []
  const type = resource.resourceType
  if (config.exemptResourceTypes.includes(type)) return []
  if (config.requiredForResourceTypes.length > 0 && !config.requiredForResourceTypes.includes(type)) return []
  return compartmentPatients(resource, referenceBase)
}

async function refusedPatients(ctx: ConsentScreenContext, config: ConsentConfig, patientIds: readonly string[]): Promise<Set<string>> {
  const refused = new Set<string>()
  if (patientIds.length === 0) return refused
  const base = await buildConsentContext(ctx.tokenPayload, ctx.serverName, ctx.resourcePath, ctx.method)
  if (config.exemptClients.includes(base.clientId)) return refused
  await Promise.all([...new Set(patientIds)].map(async (patientId) => {
    const context = { ...base, patientId }
    if (await isOwnRecord(context, ctx.serverUrl, ctx.authHeader)) return
    const { decision } = await consentDecisionFor(context, ctx.serverUrl, ctx.authHeader, config)
    if (decision !== 'permit') refused.add(patientId)
  }))
  return refused
}

function governedType(config: ConsentConfig, resourceType: string): boolean {
  if (!PATIENT_COMPARTMENT.has(resourceType) || config.exemptResourceTypes.includes(resourceType)) return false
  return config.requiredForResourceTypes.length === 0 || config.requiredForResourceTypes.includes(resourceType)
}

/** The resource type a read returns records of, or null when it can return several types. */
function readType(resourcePath: string, method: string): string | null {
  const path = parseFhirPath(resourcePath, method)
  if (path.isOperation) return null
  return path.compartmentType ?? path.resourceType
}

/** Whether this read's answer is screened per patient: consent is on and no exemption covers the client, scopes or type. */
function screensRead(req: ScreenedRequest, config: ConsentConfig): boolean {
  if (!config.enabled || config.mode === 'disabled') return false
  if (consentOperation(req.method, req.resourcePath) !== 'read' || !screensConsent(req.tokenPayload)) return false
  const clientId = req.tokenPayload.azp || req.tokenPayload.sub || 'unknown'
  if (config.exemptClients.includes(clientId)) return false
  const path = parseFhirPath(req.resourcePath, req.method)
  if (!path.resourceType) return path.isOperation || path.hasSearchSemantics
  return governedType(config, readType(req.resourcePath, req.method) ?? path.resourceType)
}

function queryOf(queryString: string): URLSearchParams {
  return new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString)
}

function formBody(req: ScreenedRequest): URLSearchParams {
  const searchesByForm = req.method === 'POST' && parseFhirPath(req.resourcePath, req.method).isSearchEndpoint
  return new URLSearchParams(searchesByForm && req.body ? req.body : '')
}

function elementRoots(resourceType: string): string[] {
  return [...new Set((PATIENT_COMPARTMENT.get(resourceType)?.elements ?? []).map((path) => path.split('.')[0] ?? path))]
}

function unscreenable(message: string): ScreenableQuery {
  return { allowed: false, status: 403, body: operationOutcome('forbidden', message) }
}

/**
 * A read whose answer the consent screen could not check is refused, or narrowed so it can be:
 * a count or a narrative carries no patient reference, and _elements must keep the elements naming the patient.
 */
export function screenableQuery(req: ScreenedRequest, queryString: string): ScreenableQuery {
  const config = getConsentConfig()
  if (!screensRead(req, config)) return { allowed: true, queryString }
  const query = queryOf(queryString)
  const form = formBody(req)
  const params = [...query, ...form]
  const summary = params.find(([name, value]) => name === '_summary' && UNSCREENABLE_SUMMARIES.has(value))?.[1]
  const hasElements = params.some(([name]) => name === '_elements')
  if (!summary && !hasElements) return { allowed: true, queryString }

  const enforce = config.mode === 'enforce'
  logger.consent.warn('Read whose answer cannot be screened for consent as asked', { resourcePath: req.resourcePath, summary, elements: hasElements, wouldDeny: !enforce })
  if (!enforce) return { allowed: true, queryString }

  if (summary) {
    return unscreenable(`_summary=${summary} answers without the patient references consent is checked against. Search without it while consent is enforced.`)
  }
  const type = readType(req.resourcePath, req.method)
  if (!type || form.has('_elements') || params.some(([name]) => INCLUDE_PARAM_RE.test(name))) {
    return unscreenable('_elements on a read that returns several resource types, or sent in a form body, would drop the patient references consent is checked against. Leave _elements out while consent is enforced.')
  }
  const requested = query.getAll('_elements').flatMap((value) => value.split(',')).map((name) => name.trim()).filter(Boolean)
  query.set('_elements', [...new Set([...requested, ...elementRoots(type)])].join(','))
  return { allowed: true, queryString: `?${query.toString()}` }
}

function isSearchset(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && body.resourceType === 'Bundle' && body.type === 'searchset'
}

function entryCount(body: Record<string, unknown>): number {
  return Array.isArray(body.entry) ? body.entry.length : 0
}

function hasNextPage(body: Record<string, unknown>): boolean {
  return Array.isArray(body.link) && body.link.some((link) => isRecord(link) && link.relation === 'next')
}

/** A total is kept only when the screened answer accounts for it: nothing taken out and no page left to screen. */
function withVerifiedTotal(before: ScreenedAnswer, after: ScreenedAnswer): ScreenedAnswer {
  if (!isSearchset(before.body) || !isSearchset(after.body) || !('total' in after.body)) return after
  if (entryCount(before.body) === entryCount(after.body) && !hasNextPage(after.body)) return after
  return { status: after.status, body: Object.fromEntries(Object.entries(after.body).filter(([key]) => key !== 'total')) }
}

const NOT_SCREENABLE: ScreenedAnswer = {
  status: 406,
  body: operationOutcome('not-supported', 'Records are screened for patient consent before they are returned, which needs a FHIR JSON answer. Ask for _format=json.'),
}

export async function screenUnconsentedRecords(ctx: ConsentScreenContext, answer: ScreenedAnswer): Promise<ScreenedAnswer> {
  const config = getConsentConfig()
  if (!config.enabled || config.mode === 'disabled') return answer
  if (consentOperation(ctx.method, ctx.resourcePath) !== 'read' || !screensConsent(ctx.tokenPayload)) return answer
  const enforce = config.mode === 'enforce'
  if (answer.status < 300 && typeof answer.body === 'string' && answer.body.length > 0 && screensRead(ctx, config)) {
    logger.consent.warn('Answer that cannot be screened for consent', { resourcePath: ctx.resourcePath, server: ctx.serverName, wouldDeny: !enforce })
    return enforce ? NOT_SCREENABLE : answer
  }
  const screened = await screenAnswer(answer, {
    patientsOf: (resource) => governedPatients(resource, config, ctx.referenceBase),
    refusedAmong: (patientIds) => refusedPatients(ctx, config, patientIds),
    enforce,
    refusal: { status: 403, body: { error: 'consent_denied', message: CONSENT_DENIED } },
    unverifiable: answer,
    report: (detail) => logger.consent.warn('Records without consent taken out of an answer', { ...detail, server: ctx.serverName, wouldDeny: !enforce }),
  })
  return enforce && screensRead(ctx, config) ? withVerifiedTotal(answer, screened) : screened
}
