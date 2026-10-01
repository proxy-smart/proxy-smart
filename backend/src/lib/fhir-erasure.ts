// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { logger } from './logger'
import { normalizeFhirUser, resolveTokenPatient } from './patient-context'

/** `POST [base]/[type]/[id]/$erase`, answered by the proxy rather than forwarded. */
export const ERASE_OPERATION = 'erase'

const CLINICIAN_TYPES: ReadonlySet<string> = new Set(['Practitioner', 'PractitionerRole', 'Organization'])
const ATTESTING_FIELDS = ['asserter', 'recorder', 'performer', 'requester', 'informationSource', 'author', 'attester', 'verifier'] as const
const VERIFIED_CODES: ReadonlySet<string> = new Set(['confirmed', 'verified'])
const OWNER_FIELDS = ['subject', 'patient'] as const
const PAGE_LIMIT = 20
const REFERENCE_DEPTH = 4

type FhirResource = Record<string, unknown>

export interface ErasureRequest {
  resourceType: string
  resourceId: string
  tokenPayload: Record<string, unknown>
  serverUrl: string
  authHeader: string
  upstreamFetch: (url: string, init?: RequestInit) => Promise<Response>
  expungeSupported: boolean
}

export interface ErasureOutcome {
  status: number
  body: FhirResource
}

class ErasureRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function isRecord(value: unknown): value is FhirResource {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

function outcome(severity: 'information' | 'error', code: string, diagnostics: string): FhirResource {
  return { resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics }] }
}

function referenceTarget(reference: string): { type: string; id: string } | null {
  const match = reference.match(/(?:^|\/)([A-Z][A-Za-z]+)\/([^/]+?)(?:\/_history\/[^/]+)?$/)
  return match ? { type: match[1], id: match[2] } : null
}

function refersTo(reference: unknown, type: string, id: string): boolean {
  if (typeof reference !== 'string') return false
  const target = referenceTarget(reference)
  return target?.type === type && target.id === id
}

function collectReferences(value: unknown, out: string[], depth = 0): string[] {
  if (depth > REFERENCE_DEPTH) return out
  for (const item of asArray(value)) {
    if (!isRecord(item)) continue
    if (typeof item.reference === 'string') out.push(item.reference)
    for (const nested of Object.values(item)) collectReferences(nested, out, depth + 1)
  }
  return out
}

function isClinicianReference(reference: string): boolean {
  const target = referenceTarget(reference)
  return target !== null && CLINICIAN_TYPES.has(target.type)
}

function hasVerifiedStatus(resource: FhirResource): boolean {
  const status = resource.verificationStatus
  if (!isRecord(status)) return false
  return asArray(status.coding).some((c) => isRecord(c) && typeof c.code === 'string' && VERIFIED_CODES.has(c.code))
}

function versionAttested(resource: FhirResource): boolean {
  if (hasVerifiedStatus(resource)) return true
  return ATTESTING_FIELDS.some((field) => collectReferences(resource[field], []).some(isClinicianReference))
}

function provenanceAttested(provenance: FhirResource): boolean {
  return asArray(provenance.agent).some((agent) => {
    if (!isRecord(agent)) return false
    return [agent.who, agent.onBehalfOf].some((r) => isRecord(r) && typeof r.reference === 'string' && isClinicianReference(r.reference))
  })
}

function ownerOf(resource: FhirResource): string | null {
  for (const field of OWNER_FIELDS) {
    const ref = resource[field]
    if (isRecord(ref) && typeof ref.reference === 'string') {
      const target = referenceTarget(ref.reference)
      if (target?.type === 'Patient') return `Patient/${target.id}`
    }
  }
  return null
}

/** The erasure right belongs to the data subject: the signed-in user must be the patient. */
function dataSubject(tokenPayload: Record<string, unknown>): string | null {
  const fhirUser = tokenPayload.fhirUser
  if (typeof fhirUser !== 'string') return null
  const user = normalizeFhirUser(fhirUser)
  if (!user.startsWith('Patient/')) return null
  const context = resolveTokenPatient(tokenPayload)
  if (context && normalizeFhirUser(context.patient.includes('/') ? context.patient : `Patient/${context.patient}`) !== user) return null
  return user
}

async function call(req: ErasureRequest, method: string, path: string, body?: FhirResource): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/fhir+json' }
  if (req.authHeader) headers.Authorization = req.authHeader
  if (body) headers['Content-Type'] = 'application/fhir+json'
  const url = path.startsWith(req.serverUrl) ? path : `${req.serverUrl}/${path}`
  return req.upstreamFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

async function ensureOk(res: Response, action: string, tolerated: readonly number[] = []): Promise<void> {
  if (res.ok || tolerated.includes(res.status)) return
  const detail = await res.text().catch(() => '')
  throw new ErasureRefusal(502, 'exception', `${action} failed upstream (HTTP ${res.status}) ${detail.slice(0, 200)}`.trim())
}

async function collectEntries(req: ErasureRequest, path: string): Promise<FhirResource[]> {
  const entries: FhirResource[] = []
  let next: string | null = path
  for (let page = 0; next && page < PAGE_LIMIT; page++) {
    const res = await call(req, 'GET', next)
    if (res.status === 404 || res.status === 410) return entries
    await ensureOk(res, `Reading ${path}`)
    const bundle: unknown = await res.json()
    if (!isRecord(bundle)) break
    entries.push(...asArray(bundle.entry).filter(isRecord))
    const link = asArray(bundle.link).find((l) => isRecord(l) && l.relation === 'next')
    next = isRecord(link) && typeof link.url === 'string' && link.url.startsWith(req.serverUrl) ? link.url : null
  }
  return entries
}

function resourcesOf(entries: FhirResource[]): FhirResource[] {
  return entries.map((e) => e.resource).filter(isRecord)
}

async function expunge(req: ErasureRequest, reference: string): Promise<void> {
  const parameters = {
    resourceType: 'Parameters',
    parameter: [
      { name: 'expungeDeletedResources', valueBoolean: true },
      { name: 'expungePreviousVersions', valueBoolean: true },
    ],
  }
  await ensureOk(await call(req, 'POST', `${reference}/$expunge`, parameters), `Expunging ${reference}`)
}

/** A Provenance about several records keeps its other targets; one about this record alone goes. */
async function detachProvenance(req: ErasureRequest, provenance: FhirResource): Promise<void> {
  if (typeof provenance.id !== 'string') return
  const reference = `Provenance/${provenance.id}`
  const remaining = asArray(provenance.target).filter(
    (t) => !(isRecord(t) && refersTo(t.reference, req.resourceType, req.resourceId)),
  )
  if (remaining.length === 0) {
    await ensureOk(await call(req, 'DELETE', reference), `Deleting ${reference}`, [404, 410])
  } else {
    await ensureOk(await call(req, 'PUT', reference, { ...provenance, target: remaining }), `Updating ${reference}`)
  }
  await expunge(req, reference)
}

async function erase(req: ErasureRequest): Promise<ErasureOutcome> {
  const { resourceType, resourceId } = req
  const reference = `${resourceType}/${resourceId}`

  const subject = dataSubject(req.tokenPayload)
  if (!subject) throw new ErasureRefusal(403, 'forbidden', 'Only the patient a record belongs to can erase it')
  if (resourceType === 'Patient') {
    throw new ErasureRefusal(422, 'not-supported', 'Erasing the Patient resource removes the whole record, which this operation does not do')
  }
  if (!req.expungeSupported) {
    throw new ErasureRefusal(501, 'not-supported', 'This FHIR server cannot purge resource history, so records cannot be erased here')
  }

  const versions = resourcesOf(await collectEntries(req, `${reference}/_history?_count=100`))
  if (versions.length === 0) throw new ErasureRefusal(404, 'not-found', `${reference} was not found`)
  if (!versions.every((v) => ownerOf(v) === subject)) {
    throw new ErasureRefusal(403, 'forbidden', `${reference} is not part of your record`)
  }

  const provenance = resourcesOf(await collectEntries(req, `Provenance?target=${encodeURIComponent(reference)}&_count=100`))
  if (versions.some(versionAttested) || provenance.some(provenanceAttested)) {
    throw new ErasureRefusal(409, 'business-rule', `A clinician attested ${reference}, so it can be marked entered-in-error but not erased`)
  }

  const referrers = resourcesOf(
    (await collectEntries(req, `${resourceType}?_id=${encodeURIComponent(resourceId)}&_revinclude=*&_count=100`))
      .filter((e) => isRecord(e.search) && e.search.mode === 'include'),
  ).filter((r) => r.resourceType !== 'Provenance')
  if (referrers.length > 0) {
    const names = referrers.map((r) => `${String(r.resourceType)}/${String(r.id)}`).join(', ')
    throw new ErasureRefusal(409, 'conflict', `${reference} is referenced by ${names}; those references must go first`)
  }

  for (const p of provenance) await detachProvenance(req, p)
  await ensureOk(await call(req, 'DELETE', reference), `Deleting ${reference}`, [404, 410])
  await expunge(req, reference)

  logger.fhir.info('Erased a record at the request of its data subject', {
    reference, subject, provenance: provenance.length, versions: versions.length,
  })
  return { status: 200, body: outcome('information', 'informational', `${reference} was erased`) }
}

/** Erase one record and its history, after confirming the caller may: refusals come back as OperationOutcomes. */
export async function eraseRecord(req: ErasureRequest): Promise<ErasureOutcome> {
  try {
    return await erase(req)
  } catch (error) {
    if (error instanceof ErasureRefusal) {
      logger.fhir.warn('Record erasure refused', { resourceType: req.resourceType, resourceId: req.resourceId, status: error.status, reason: error.message })
      return { status: error.status, body: outcome('error', error.code, error.message) }
    }
    throw error
  }
}
