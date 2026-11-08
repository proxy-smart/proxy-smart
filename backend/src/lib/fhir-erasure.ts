// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { actorOf, ADDED_BY_POLICY, chartPatientOf, creationOf, recordAdder, type FhirResource } from './fhir-authorship'
import type { StudyImageErasure } from './dicom-storage'
import { dicomStudyIdentifierQuery, dicomStudyUidsOf } from './dicomweb-access'
import { logger } from './logger'
import { normalizeFhirUser } from './patient-context'
import { isRecord } from './type-guards'
import type { UpstreamFetch } from './upstream-fetch'

/** `POST [base]/[type]/[id]/$erase`, answered by the proxy rather than forwarded. */
export const ERASE_OPERATION = 'erase'

const CLINICIAN_TYPES: ReadonlySet<string> = new Set(['Practitioner', 'PractitionerRole', 'Organization'])
const ATTESTING_FIELDS = ['asserter', 'recorder', 'performer', 'requester', 'informationSource', 'author', 'attester', 'verifier'] as const
const VERIFIED_CODES: ReadonlySet<string> = new Set(['confirmed', 'verified'])
const KEPT_TYPES: ReadonlyMap<string, string> = new Map([
  ['Patient', 'Erasing the Patient resource removes the whole record, which this operation does not do'],
  ['Person', 'Erasing a Person removes an identity, which this operation does not do'],
  ['Consent', 'A consent is withdrawn, not erased, so the record of what was agreed stays'],
  ['Provenance', 'Provenance is the audit trail of the record and goes only with the records it is about'],
  ['AuditEvent', 'Audit events are kept as the record of who accessed what'],
])
const MEMBER_TYPES = ['Patient/', 'Person/'] as const
const PAGE_LIMIT = 20
const REFERENCE_DEPTH = 4

export interface ErasureRequest {
  resourceType: string
  resourceId: string
  tokenPayload: Record<string, unknown>
  serverUrl: string
  authHeader: string
  upstreamFetch: UpstreamFetch
  expungeSupported: boolean
  /** The member's own Patient for a `Person/…` sign-in, followed through the Person's links. */
  personPatient: (person: string) => Promise<string | undefined>
  /** Removes a study's images from the PACS when its ImagingStudy is erased. */
  eraseStudyImages?: (studyUid: string) => Promise<StudyImageErasure>
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

/** Who the signed-in member is, as the proxy may have recorded them adding a record: their fhirUser and, for a Person, their own Patient. */
async function memberIdentities(req: ErasureRequest): Promise<Set<string>> {
  const actor = actorOf(req.tokenPayload)
  if (!actor || !MEMBER_TYPES.some((type) => actor.startsWith(type))) return new Set()
  const linked = actor.startsWith('Person/') ? await req.personPatient(actor) : undefined
  return new Set(linked ? [actor, normalizeFhirUser(linked)] : [actor])
}

function localReference(reference: string): string | undefined {
  const target = referenceTarget(reference)
  return target ? `${target.type}/${target.id}` : undefined
}

function tracksAuthorship(provenance: FhirResource): boolean {
  return Array.isArray(provenance.policy) && provenance.policy.includes(ADDED_BY_POLICY)
}

/** Records predating signed authorship: the member's when they created them on their own chart and no one else is named. */
function selfReported(versions: FhirResource[], member: Set<string>): boolean {
  const created = creationOf(versions)
  const chart = created && chartPatientOf(created)
  if (!created || !chart || !member.has(chart)) return false
  const authors = ATTESTING_FIELDS.flatMap((field) => collectReferences(created[field], [])).map(localReference)
  return authors.length > 0 && authors.every((author) => author !== undefined && member.has(author))
}

/** The member added this record: the proxy signed it so, or it predates that signing and names only them. */
async function addedByMember(req: ErasureRequest, versions: FhirResource[], provenance: FhirResource[], member: Set<string>): Promise<'signed' | 'self-reported' | undefined> {
  const adder = await recordAdder(req.resourceType, req.resourceId, versions, provenance)
  if (adder !== undefined) return member.has(adder) ? 'signed' : undefined
  if (provenance.some(tracksAuthorship)) return undefined
  return selfReported(versions, member) ? 'self-reported' : undefined
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

/** A Provenance about several records keeps its other targets; one about this record alone, or only its chart besides, goes. */
async function detachProvenance(req: ErasureRequest, provenance: FhirResource, chart: string | undefined): Promise<void> {
  if (typeof provenance.id !== 'string') return
  const reference = `Provenance/${provenance.id}`
  const remaining = asArray(provenance.target).filter(
    (t) => !(isRecord(t) && refersTo(t.reference, req.resourceType, req.resourceId)),
  )
  const anchorsOnly = remaining.every((t) => isRecord(t) && t.reference === chart)
  if (anchorsOnly) {
    await ensureOk(await call(req, 'DELETE', reference), `Deleting ${reference}`, [404, 410])
  } else {
    await ensureOk(await call(req, 'PUT', reference, { ...provenance, target: remaining }), `Updating ${reference}`)
  }
  await expunge(req, reference)
}

/** Study UIDs another ImagingStudy also names keep their images; every other study's images go before the record does. */
async function eraseImages(req: ErasureRequest, versions: FhirResource[]): Promise<{ erased: string[]; kept: string[] }> {
  const studyUids = [...new Set(versions.flatMap(dicomStudyUidsOf))]
  const erased: string[] = []
  const kept: string[] = []
  for (const studyUid of studyUids) {
    const named = resourcesOf(await collectEntries(req, `ImagingStudy?${dicomStudyIdentifierQuery(studyUid)}&_elements=identifier&_count=100`))
    if (named.some((r) => r.id !== req.resourceId)) {
      kept.push(studyUid)
      continue
    }
    if (!req.eraseStudyImages) throw new ErasureRefusal(501, 'not-supported', 'The images of this study cannot be removed here, so its record is kept')
    let result: StudyImageErasure
    try {
      result = await req.eraseStudyImages(studyUid)
    } catch (error) {
      throw new ErasureRefusal(502, 'exception', error instanceof Error ? error.message : 'Deleting the study images failed')
    }
    if (result === 'unsupported') throw new ErasureRefusal(501, 'not-supported', 'This PACS cannot delete studies, so the record and its images are kept')
    erased.push(studyUid)
  }
  return { erased, kept }
}

async function erase(req: ErasureRequest): Promise<ErasureOutcome> {
  const { resourceType, resourceId } = req
  const reference = `${resourceType}/${resourceId}`

  const member = await memberIdentities(req)
  if (member.size === 0) throw new ErasureRefusal(403, 'forbidden', 'Only a member who added a record can erase it; clinicians mark records entered-in-error')
  const kept = KEPT_TYPES.get(resourceType)
  if (kept) throw new ErasureRefusal(422, 'not-supported', kept)
  if (!req.expungeSupported) {
    throw new ErasureRefusal(501, 'not-supported', 'This FHIR server cannot purge resource history, so records cannot be erased here')
  }

  const versions = resourcesOf(await collectEntries(req, `${reference}/_history?_count=100`))
  if (versions.length === 0) throw new ErasureRefusal(404, 'not-found', `${reference} was not found`)

  const provenance = resourcesOf(await collectEntries(req, `Provenance?target=${encodeURIComponent(reference)}&_count=100`))
  const basis = await addedByMember(req, versions, provenance, member)
  if (!basis) {
    throw new ErasureRefusal(403, 'forbidden', `${reference} was not added by you, so it is not yours to erase`)
  }
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

  const images = resourceType === 'ImagingStudy' ? await eraseImages(req, versions) : undefined

  const created = creationOf(versions)
  const chart = created ? chartPatientOf(created) : undefined
  for (const p of provenance) await detachProvenance(req, p, chart)
  await ensureOk(await call(req, 'DELETE', reference), `Deleting ${reference}`, [404, 410])
  await expunge(req, reference)

  logger.fhir.info('Erased a record at the request of the member who added it', {
    reference, member: [...member], basis, provenance: provenance.length, versions: versions.length, images,
  })
  const imagesKept = images && images.kept.length > 0 ? '; its images stay because another record names the same study' : ''
  return { status: 200, body: outcome('information', 'informational', `${reference} was erased${imagesKept}`) }
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
