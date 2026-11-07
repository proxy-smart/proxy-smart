// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isDeepStrictEqual } from 'util'
import { parseTokenScopes } from '@proxy-smart/auth'
import { addedByRequester } from './consent/added-by-requester'
import { getConsentConfig, logAuditEntry, tokenIdentity } from './consent/consent-service'
import { parseFhirPath } from './fhir-capabilities'
import { actorOf, ADDED_BY_POLICY, chartPatientOf, signedAdder, type FhirResource } from './fhir-authorship'
import { operationOutcome } from './fhir-operation-outcome'
import { upstreamFhirQuery } from './fhir-upstream-query'
import { logger } from './logger'
import { lookupStored } from './patient-compartment/stored-resource'
import { isVisibleToTenant } from './tenant-isolation'
import type { AccessControlContext } from './smart-access-control'
import { isRecord, optionalString, parseJsonRecord } from './type-guards'
import { tokenClientId } from './jwt-claims'

/** `GET [base]/$authored`: the records the signed-in user added, as the proxy signed them, answered by the proxy. */
export const AUTHORED_OPERATION = 'authored'

const RETRACTED = 'entered-in-error'
const STATUS_FIELDS = ['status', 'verificationStatus'] as const
const VERSION_META = ['versionId', 'lastUpdated', 'source'] as const
const COMPARED_APART: ReadonlySet<string> = new Set([...STATUS_FIELDS, 'meta', 'note'])
const PAGE_LIMIT = 20
const PAGE_SIZE = 100

export type AuthorRequest = { kind: 'authored' } | { kind: 'retraction'; reference: string; patientId: string | null }

export interface AuthoredOutcome {
  status: number
  body: FhirResource
}

function marksRetracted(value: unknown): boolean {
  if (value === RETRACTED) return true
  return isRecord(value) && Array.isArray(value.coding) && value.coding.some((c) => isRecord(c) && c.code === RETRACTED)
}

function withoutVersion(meta: unknown): unknown {
  if (!isRecord(meta)) return meta
  const rest = Object.fromEntries(Object.entries(meta).filter(([key]) => !VERSION_META.some((field) => field === key)))
  return Object.keys(rest).length > 0 ? rest : undefined
}

function appendsNotes(stored: unknown, proposed: unknown): boolean {
  const before = Array.isArray(stored) ? stored : []
  if (proposed === undefined) return before.length === 0
  return Array.isArray(proposed) && proposed.length >= before.length && before.every((note, i) => isDeepStrictEqual(note, proposed[i]))
}

/** Whether `proposed` is `stored` marked entered-in-error, with at most notes added that say why. */
export function isRetraction(stored: FhirResource, proposed: FhirResource): boolean {
  if (proposed.resourceType !== stored.resourceType || proposed.id !== stored.id) return false
  if (!STATUS_FIELDS.some((field) => marksRetracted(proposed[field]) && !marksRetracted(stored[field]))) return false
  if (!STATUS_FIELDS.every((field) => isDeepStrictEqual(stored[field], proposed[field]) || marksRetracted(proposed[field]))) return false
  if (!isDeepStrictEqual(withoutVersion(stored.meta), withoutVersion(proposed.meta))) return false
  if (!appendsNotes(stored.note, proposed.note)) return false
  const rest = (resource: FhirResource) => Object.fromEntries(Object.entries(resource).filter(([key]) => !COMPARED_APART.has(key)))
  return isDeepStrictEqual(rest(stored), rest(proposed))
}

export function isAuthoredExport(method: string, resourcePath: string): boolean {
  const path = parseFhirPath(resourcePath, method)
  return method === 'GET' && path.isOperation && !path.resourceType && path.operationName === AUTHORED_OPERATION
}

/**
 * A request the user may make as the one who added the records, whatever the patient's consent
 * now says: their own export, or marking a record they added as entered-in-error.
 */
export async function authorRequest(ctx: AccessControlContext, body: string | undefined): Promise<AuthorRequest | null> {
  if (isAuthoredExport(ctx.method, ctx.resourcePath)) return actorOf(ctx.tokenPayload) ? { kind: 'authored' } : null
  if (ctx.method !== 'PUT') return null
  const path = parseFhirPath(ctx.resourcePath, ctx.method)
  if (!path.resourceType || !path.resourceId || path.isOperation || path.isHistory) return null
  const proposed = parseJsonRecord(body)
  const fhirUser = optionalString(ctx.tokenPayload.fhirUser)
  if (!proposed || !fhirUser || !actorOf(ctx.tokenPayload)) return null
  if (!STATUS_FIELDS.some((field) => marksRetracted(proposed[field]))) return null
  const stored = await lookupStored(ctx, path.resourceType, path.resourceId, 'author retraction lookup')
  if (stored.status !== 'found' || !isRetraction(stored.resource, proposed)) return null
  const context = { resourceType: path.resourceType, resourceId: path.resourceId, fhirUser }
  if (!await addedByRequester(context, ctx.serverUrl, ctx.authHeader)) return null
  return { kind: 'retraction', reference: `${path.resourceType}/${path.resourceId}`, patientId: chartPatientOf(stored.resource)?.split('/')[1] ?? null }
}

/** Put what an author did into the patient's access log, as the consent decisions are. */
export function logAuthorAccess(ctx: AccessControlContext, patientId: string | null, resourceType: string | null, reason: string): void {
  const config = getConsentConfig()
  logAuditEntry({
    timestamp: new Date().toISOString(),
    decision: 'permit',
    consentId: null,
    patientId,
    clientId: tokenClientId(ctx.tokenPayload) ?? '',
    ...tokenIdentity(ctx.tokenPayload),
    resourceType,
    resourcePath: ctx.resourcePath,
    serverName: ctx.serverName,
    method: ctx.method,
    scopes: [...parseTokenScopes(ctx.tokenPayload)],
    reason,
    mode: config.mode,
    enforced: config.mode === 'enforce',
  })
}

async function addedByProvenance(ctx: AccessControlContext, actor: string): Promise<{ provenance: FhirResource[]; truncated: boolean }> {
  const provenance: FhirResource[] = []
  let url: string | null = `${ctx.serverUrl}/Provenance?agent=${encodeURIComponent(actor)}&_count=${PAGE_SIZE}`
  for (let page = 0; url && page < PAGE_LIMIT; page++) {
    const bundle = await upstreamFhirQuery(ctx, url, 'authored records lookup')
    if (!bundle) throw new Error('The Provenance search failed upstream')
    for (const entry of Array.isArray(bundle.entry) ? bundle.entry : []) {
      const resource = isRecord(entry) ? entry.resource : undefined
      if (isRecord(resource) && Array.isArray(resource.policy) && resource.policy.includes(ADDED_BY_POLICY)) provenance.push(resource)
    }
    const next = Array.isArray(bundle.link) ? bundle.link.find((link) => isRecord(link) && link.relation === 'next') : undefined
    url = isRecord(next) && typeof next.url === 'string' && next.url.startsWith(ctx.serverUrl) ? next.url : null
  }
  return { provenance, truncated: url !== null }
}

function creationOfProvenance(provenance: FhirResource): string | undefined {
  const targets = Array.isArray(provenance.target) ? provenance.target : []
  const creation = targets.find((t) => isRecord(t) && typeof t.reference === 'string' && t.reference.includes('/_history/'))
  return isRecord(creation) && typeof creation.reference === 'string' ? creation.reference : undefined
}

async function readCreations(ctx: AccessControlContext, creations: string[]): Promise<(FhirResource | null)[]> {
  if (creations.length === 0) return []
  const batch = { resourceType: 'Bundle', type: 'batch', entry: creations.map((url) => ({ request: { method: 'GET', url } })) }
  const headers: Record<string, string> = { Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json' }
  if (ctx.authHeader) headers.Authorization = ctx.authHeader
  const res = await ctx.upstreamFetch(ctx.serverUrl, { method: 'POST', headers, body: JSON.stringify(batch) })
  if (!res.ok) throw new Error(`Reading the records failed upstream (HTTP ${res.status})`)
  const answer: unknown = await res.json()
  const entries = isRecord(answer) && Array.isArray(answer.entry) ? answer.entry : []
  return creations.map((_, i) => {
    const entry = entries[i]
    const ok = isRecord(entry) && isRecord(entry.response) && String(entry.response.status).startsWith('200')
    return ok && isRecord(entry.resource) ? entry.resource : null
  })
}

/**
 * Every record the signed-in user added, at the version they added it, with the Provenance the proxy
 * signed for it. Only Provenance whose signature names them counts; records since erased, and records
 * tagged for another organization while queries are tenant-isolated, are left out.
 */
export async function authoredRecords(ctx: AccessControlContext, tenantOrgId: string | null = null): Promise<AuthoredOutcome> {
  const actor = actorOf(ctx.tokenPayload)
  if (!actor) return { status: 403, body: operationOutcome('forbidden', 'Only a signed-in user has records they added') }
  try {
    const { provenance, truncated } = await addedByProvenance(ctx, actor)
    const signed: { provenance: FhirResource; creation: string }[] = []
    for (const p of provenance) {
      const creation = creationOfProvenance(p)
      if (creation && await signedAdder(p, creation) === actor) signed.push({ provenance: p, creation })
    }
    const records: { provenance: FhirResource; creation: string; resource: FhirResource }[] = []
    for (let i = 0; i < signed.length; i += PAGE_SIZE) {
      const page = signed.slice(i, i + PAGE_SIZE)
      const resources = await readCreations(ctx, page.map(({ creation }) => creation))
      page.forEach((item, j) => {
        const resource = resources[j]
        if (resource && isVisibleToTenant(resource, tenantOrgId)) records.push({ ...item, resource })
      })
    }
    for (const patientId of new Set(records.map(({ resource }) => chartPatientOf(resource)?.split('/')[1]).filter((id) => id !== undefined))) {
      logAuthorAccess(ctx, patientId, null, 'The clinician exported the records they added to this chart')
    }
    logger.fhir.info('Exported the records a user added', { actor, records: records.length, truncated })
    const entry = records.flatMap(({ provenance: p, creation, resource }) => [
      { fullUrl: `${ctx.serverUrl}/${creation}`, resource },
      { fullUrl: `${ctx.serverUrl}/Provenance/${String(p.id)}`, resource: p },
    ])
    if (truncated) {
      entry.push({ fullUrl: 'urn:proxy-smart:authored:truncated', resource: operationOutcome('too-costly', `Only the first ${PAGE_LIMIT * PAGE_SIZE} records are included`, { severity: 'warning' }) })
    }
    return { status: 200, body: { resourceType: 'Bundle', type: 'collection', timestamp: new Date().toISOString(), entry } }
  } catch (error) {
    logger.fhir.error('Could not export the records a user added', { actor }, error)
    return { status: 502, body: operationOutcome('exception', 'The records you added could not be read right now. Please try again.') }
  }
}
