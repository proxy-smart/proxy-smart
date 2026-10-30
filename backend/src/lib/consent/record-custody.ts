// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { refusal, upstreamUnverifiable, type AccessDecision } from '../access-decision'
import { parseFhirPath } from '../fhir-capabilities'
import { upstreamFhirQuery } from '../fhir-upstream-query'
import { logger } from '../logger'
import { normalizeFhirUser, resolveTokenPatientId } from '../patient-context'
import { compartmentPatients } from '../patient-compartment/definition'
import { lookupStored } from '../patient-compartment/stored-resource'
import { screenAnswer, type ScreenedAnswer } from './screen-answer'
import { getRuntimeConsentConfig } from '../runtime-config'
import type { AccessControlContext } from '../smart-access-control'
import { isRecord } from '../type-guards'
import { resolveFhirUserForClient } from './person-resolver'

/** The role a record-holding consent names its holder in. */
export const CUSTODIAN_ROLE = { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' } as const

/** Managing consent is how a closed record is opened again, so it is never closed itself. */
const ALWAYS_REACHABLE: ReadonlySet<string> = new Set(['Consent'])
const LOOKUP_BATCH = 50
const LOOKUP_PAGES = 10
const ERASE = 'erase'
const CLOSED_MESSAGE = 'The patient withdrew the consent this record is held on, so it is closed: nothing can be added, and only the patient can see it.'

type Custody = { closed: boolean; expiresAt: number }
const custody = new Map<string, Custody>()

export type CustodyContext = Pick<AccessControlContext, 'serverUrl' | 'serverId' | 'serverName' | 'authHeader' | 'upstreamFetch'>

export type CustodyDecision = AccessDecision<{ screenReads: boolean }>

/** Forget what is known about these patients' records, or about every record. */
export function invalidateRecordCustody(patientId?: string): void {
  if (!patientId) {
    custody.clear()
    return
  }
  for (const key of custody.keys()) if (key.endsWith(`|${patientId}`)) custody.delete(key)
}

function isCustodianConsent(consent: Record<string, unknown>): boolean {
  const provisions = Array.isArray(consent.provision) ? consent.provision : [consent.provision]
  return provisions.some((provision) => isRecord(provision) && Array.isArray(provision.actor) && provision.actor.some((actor) =>
    isRecord(actor) && isRecord(actor.role) && Array.isArray(actor.role.coding) && actor.role.coding.some((coding) =>
      isRecord(coding) && coding.system === CUSTODIAN_ROLE.system && coding.code === CUSTODIAN_ROLE.code)))
}

/** Closed: the patient gave a record-holding consent and none of them stands now. No such consent: not governed here. */
export function isRecordClosed(consents: readonly Record<string, unknown>[]): boolean {
  const custodial = consents.filter(isCustodianConsent)
  return custodial.length > 0 && !custodial.some((consent) => consent.status === 'active')
}

function patientOfConsent(consent: Record<string, unknown>, serverUrl: string): string | undefined {
  return compartmentPatients(consent, serverUrl)[0]
}

async function consentsOf(ctx: CustodyContext, patientIds: string[]): Promise<Record<string, unknown>[] | null> {
  const consents: Record<string, unknown>[] = []
  let url: string | null = `${ctx.serverUrl}/Consent?patient=${patientIds.map((id) => encodeURIComponent(`Patient/${id}`)).join(',')}&_count=200`
  for (let page = 0; url && page < LOOKUP_PAGES; page++) {
    const bundle = await upstreamFhirQuery(ctx, url, 'record custody lookup')
    if (!bundle) return null
    for (const entry of Array.isArray(bundle.entry) ? bundle.entry : []) {
      if (isRecord(entry) && isRecord(entry.resource) && entry.resource.resourceType === 'Consent') consents.push(entry.resource)
    }
    const next = Array.isArray(bundle.link) ? bundle.link.find((link) => isRecord(link) && link.relation === 'next') : undefined
    url = isRecord(next) && typeof next.url === 'string' && next.url.startsWith(ctx.serverUrl) ? next.url : null
  }
  return consents
}

/** Which of these patients' records are closed; null when the lookup failed, so callers fail closed. */
export async function closedRecords(ctx: CustodyContext, patientIds: Iterable<string>): Promise<Set<string> | null> {
  const now = Date.now()
  const closed = new Set<string>()
  const unknown: string[] = []
  for (const id of new Set(patientIds)) {
    const known = custody.get(`${ctx.serverId}|${id}`)
    if (known && known.expiresAt > now) {
      if (known.closed) closed.add(id)
    } else {
      unknown.push(id)
    }
  }
  const ttl = getRuntimeConsentConfig().cacheTtl
  for (let i = 0; i < unknown.length; i += LOOKUP_BATCH) {
    const batch = unknown.slice(i, i + LOOKUP_BATCH)
    const consents = await consentsOf(ctx, batch)
    if (!consents) return null
    for (const id of batch) {
      const isClosed = isRecordClosed(consents.filter((consent) => patientOfConsent(consent, ctx.serverUrl) === id))
      custody.set(`${ctx.serverId}|${id}`, { closed: isClosed, expiresAt: now + ttl })
      if (isClosed) closed.add(id)
    }
  }
  return closed
}

/** The member's own Patient id, for a Patient or Person sign-in. */
async function ownPatientOf(ctx: AccessControlContext): Promise<string | null> {
  const fhirUser = ctx.tokenPayload.fhirUser
  if (typeof fhirUser !== 'string') return null
  const user = normalizeFhirUser(fhirUser)
  if (user.startsWith('Patient/')) return user.slice('Patient/'.length)
  if (!user.startsWith('Person/')) return null
  const linked = await resolveFhirUserForClient(fhirUser, true, ctx.serverUrl, ctx.serverId, ctx.authHeader)
  const patient = linked ? normalizeFhirUser(linked) : null
  return patient?.startsWith('Patient/') ? patient.slice('Patient/'.length) : null
}

function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The patients a write lands in: from its body, and from what it replaces or removes. */
async function writtenPatients(ctx: AccessControlContext, body: string | undefined): Promise<string[] | null> {
  const patients = new Set<string>()
  const resource = parseBody(body)
  if (resource) for (const id of compartmentPatients(resource, ctx.serverUrl)) patients.add(id)
  const { resourceType, resourceId } = parseFhirPath(ctx.resourcePath, ctx.method)
  if (resourceType && resourceId && ctx.method !== 'POST') {
    const stored = await lookupStored(ctx, resourceType, resourceId, 'record custody lookup')
    if (stored.status === 'unverifiable') return null
    if (stored.status === 'found') for (const id of compartmentPatients(stored.resource, ctx.serverUrl)) patients.add(id)
  }
  return [...patients]
}

function closedRefusal(mode: string, detail: Record<string, unknown>): CustodyDecision {
  logger.consent.warn('Request reaches a closed record', { ...detail, wouldDeny: mode !== 'enforce' })
  if (mode !== 'enforce') return { allowed: true, screenReads: false }
  return refusal(CLOSED_MESSAGE, 'record_closed')
}

/**
 * A record whose holding consent was withdrawn stays held but closed. The patient keeps reading it
 * and removing what is theirs; nobody adds to it, and nobody else reaches it. Reads by a caller with
 * no patient context come back `screenReads`, so closed records are taken out of the answer.
 */
export async function enforceRecordCustody(ctx: AccessControlContext, body?: string): Promise<CustodyDecision> {
  const config = getRuntimeConsentConfig()
  if (!config.enabled || config.mode === 'disabled') return { allowed: true, screenReads: false }

  const path = parseFhirPath(ctx.resourcePath, ctx.method)
  if (path.resourceType && ALWAYS_REACHABLE.has(path.resourceType)) return { allowed: true, screenReads: false }
  const reads = ctx.method === 'GET' || ctx.method === 'HEAD' || path.isSearchEndpoint
  const removes = ctx.method === 'DELETE' || (ctx.method === 'POST' && path.operationName === ERASE)

  const own = await ownPatientOf(ctx)
  const patient = await resolveTokenPatientId(ctx.tokenPayload) ?? own
  const detail = { resourcePath: ctx.resourcePath, method: ctx.method, server: ctx.serverName }

  if (patient) {
    const closed = await closedRecords(ctx, [patient])
    if (!closed) return upstreamUnverifiable('Whether this record is open could not be checked right now. Please try again.')
    if (!closed.has(patient)) return { allowed: true, screenReads: false }
    if (own === patient && (reads || removes)) return { allowed: true, screenReads: false }
    return closedRefusal(config.mode, { ...detail, patient })
  }

  if (reads) return { allowed: true, screenReads: true }
  const patients = await writtenPatients(ctx, body)
  if (!patients) return upstreamUnverifiable('Whether this record is open could not be checked right now. Please try again.')
  if (patients.length === 0) return { allowed: true, screenReads: false }
  const closed = await closedRecords(ctx, patients)
  if (!closed) return upstreamUnverifiable('Whether this record is open could not be checked right now. Please try again.')
  if (closed.size === 0) return { allowed: true, screenReads: false }
  return closedRefusal(config.mode, { ...detail, patients: [...closed] })
}

/** Take closed records out of an answer: entries leave a Bundle, a single closed resource is refused. */
export async function screenClosedRecords(ctx: CustodyContext, answer: ScreenedAnswer): Promise<ScreenedAnswer> {
  const enforce = getRuntimeConsentConfig().mode === 'enforce'
  return screenAnswer(answer, {
    patientsOf: (resource) => (isRecord(resource) ? compartmentPatients(resource, ctx.serverUrl) : []),
    refusedAmong: (patientIds) => closedRecords(ctx, patientIds),
    enforce,
    refusal: { status: 403, body: { error: 'record_closed', message: CLOSED_MESSAGE } },
    unverifiable: { status: 502, body: { error: 'upstream_error', message: 'Whether these records are open could not be checked right now. Please try again.' } },
    report: (detail) => logger.consent.warn('Closed records taken out of an answer', { ...detail, server: ctx.serverName, wouldDeny: !enforce }),
  })
}

/** Whether new data into this patient's record must be refused now: false when consent is not enforced, null when unknown. */
export async function refusesNewData(ctx: CustodyContext, patientId: string): Promise<boolean | null> {
  const config = getRuntimeConsentConfig()
  if (!config.enabled || config.mode === 'disabled') return false
  const closed = await closedRecords(ctx, [patientId])
  if (!closed) return null
  if (!closed.has(patientId)) return false
  if (config.mode !== 'enforce') {
    logger.consent.warn('New data for a closed record', { patientId, server: ctx.serverName, wouldDeny: true })
    return false
  }
  return true
}
