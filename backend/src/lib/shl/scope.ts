// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * SECURITY-CRITICAL, default-deny SHL scope decisions. A study-scoped share exposes only that study via DICOMweb and
 * only its ImagingStudy, the session Patient and metadata via FHIR; whole-patient shares pass through to the caller.
 */

import { isRecord, optionalString } from '../type-guards'

/** `rewrittenSearch`, when present, MUST replace the upstream query string. */
export interface ScopeDecision {
  allowed: boolean
  /** Includes the leading `?`, or `''` for none. */
  rewrittenSearch?: string
}

function pathSegments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

function toSearch(params: URLSearchParams): string {
  const s = params.toString()
  return s ? `?${s}` : ''
}

export function isDicomPathAllowed(
  pathAfterDicomweb: string,
  search: string,
  studyInstanceUID?: string,
): ScopeDecision {
  if (!studyInstanceUID) return { allowed: true }

  const segments = pathSegments(pathAfterDicomweb)

  // WADO-RS: studies/{uid}/...
  if (segments[0] === 'studies' && segments.length >= 2) {
    return segments[1] === studyInstanceUID ? { allowed: true } : { allowed: false }
  }

  // QIDO-RS study list: force the result set down to the shared study.
  if (segments.length === 1 && segments[0] === 'studies') {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const existing = params.get('StudyInstanceUID')
    if (existing !== null && existing !== studyInstanceUID) {
      return { allowed: false }
    }
    if (existing === null) {
      params.set('StudyInstanceUID', studyInstanceUID)
      return { allowed: true, rewrittenSearch: toSearch(params) }
    }
    return { allowed: true }
  }

  return { allowed: false }
}

/** STOW-RS targets only: deeper DICOMweb paths have no POST semantics, and a PACS may misread one. */
function isStowTarget(dicomPath: string): boolean {
  const segments = pathSegments(dicomPath)
  if (segments[0] !== 'studies') return false
  return segments.length === 1 || segments.length === 2
}

/**
 * The only FHIR write is a conditional ImagingStudy update, the FHIR half of a DICOM upload grant.
 * A PUT by id is refused: it would let a recipient overwrite a study by guessing its id.
 */
export function fhirWriteRefusal(request: {
  method: string
  fhirPath: string
  search: string
  dicomWriteGranted: boolean
  attested: boolean
}): DicomWriteRefusal | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return null

  if (method !== 'PUT') {
    return { status: 405, error: `${method} is not supported on shared links` }
  }
  if (!request.dicomWriteGranted) {
    return { status: 405, error: 'Only read operations are allowed on this shared link' }
  }
  if (pathSegments(request.fhirPath)[0] !== 'ImagingStudy' || pathSegments(request.fhirPath).length !== 1) {
    return { status: 403, error: 'This link may only file an ImagingStudy for the imaging it uploads' }
  }
  if (!new URLSearchParams(request.search).has('identifier')) {
    return { status: 403, error: 'ImagingStudy must be filed by identifier (conditional update)' }
  }
  if (!request.attested) {
    return { status: 403, error: 'Sign before uploading: POST /api/shl/attest with your name and signature' }
  }
  return null
}

export interface DicomWriteRefusal {
  status: 403 | 405
  error: string
}

/** Writes only; attestation is required before the write so it can be attributed. */
export function dicomWriteRefusal(request: {
  method: string
  dicomPath: string
  dicomWriteGranted: boolean
  attested: boolean
}): DicomWriteRefusal | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return null

  if (method !== 'POST') {
    return { status: 405, error: `${method} is not supported on shared links` }
  }
  if (!request.dicomWriteGranted) {
    return { status: 405, error: 'Only read operations are allowed on this shared link' }
  }
  if (!isStowTarget(request.dicomPath)) {
    return { status: 403, error: 'Uploads are only accepted at studies or studies/{studyInstanceUID}' }
  }
  if (!request.attested) {
    return { status: 403, error: 'Sign before uploading: POST /api/shl/attest with your name and signature' }
  }
  return null
}

export function scopeFhirRequest(
  fhirPath: string,
  search: string,
  opts: { patientId: string; studyInstanceUID?: string },
): ScopeDecision {
  const { patientId, studyInstanceUID } = opts

  if (!studyInstanceUID) return { allowed: true }

  const segments = pathSegments(fhirPath)

  if (segments.length === 1 && segments[0] === 'metadata') {
    return { allowed: true }
  }

  if (segments[0] === 'Patient') {
    if (segments.length === 2 && segments[1] === patientId) {
      return { allowed: true }
    }
    return { allowed: false }
  }

  if (segments[0] === 'ImagingStudy') {
    // A read by id cannot be tied to the study UID without an upstream lookup; force search.
    if (segments.length >= 2) {
      return { allowed: false }
    }

    const wanted = `urn:oid:${studyInstanceUID}`
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const existing = params.get('identifier')
    if (existing !== null && existing !== wanted) {
      return { allowed: false }
    }
    if (existing === null) {
      params.set('identifier', wanted)
      return { allowed: true, rewrittenSearch: toSearch(params) }
    }
    return { allowed: true }
  }

  return { allowed: false }
}

// Selective sharing (whole-patient shares only): pre-screen before upstream, then post-filter as defense-in-depth.
// Verification status is a display signal, never an access filter.

export interface SelectiveScope {
  excludedTypes: readonly string[]
  /** `ResourceType/id` */
  excludedIds: readonly string[]
  /** e.g. `vital-signs`, `laboratory` */
  excludedObservationCategories: readonly string[]
}

export type SelectivePreAction =
  | { action: 'passthrough' }
  | { action: 'deny' }
  | { action: 'empty-bundle' }

type FhirResourceLike = Record<string, unknown>

interface FhirBundleLike {
  resourceType: 'Bundle'
  type: string
  total?: number
  entry: unknown[]
}

/** SHL `query` hints; none for whole-patient shares, since naming reachable types reveals the withheld ones. */
export function shareQueryHints(narrowing: { studyInstanceUID?: string }): string[] | undefined {
  if (!narrowing.studyInstanceUID) return undefined
  return [`ImagingStudy?identifier=urn:oid:${narrowing.studyInstanceUID}`]
}

/** Act only on `true`: `false` covers both study-scoped and de-selected shares. */
export function isCompleteShare(narrowing: {
  selectiveScope?: SelectiveScope
  studyInstanceUID?: string
}): boolean {
  const narrowed = narrowing.selectiveScope
    ? isSelectiveScopeActive(narrowing.selectiveScope)
    : false
  return !narrowed && !narrowing.studyInstanceUID
}

export function isSelectiveScopeActive(scope: SelectiveScope): boolean {
  return (
    scope.excludedTypes.length > 0 ||
    scope.excludedIds.length > 0 ||
    scope.excludedObservationCategories.length > 0
  )
}

function observationCategoryCodes(resource: FhirResourceLike): string[] {
  if (!Array.isArray(resource.category)) return []
  const codes: string[] = []
  for (const concept of resource.category) {
    const codings: unknown = isRecord(concept) ? concept.coding : undefined
    if (!Array.isArray(codings)) continue
    for (const coding of codings) {
      const code = isRecord(coding) ? optionalString(coding.code) : undefined
      if (code) codes.push(code)
    }
  }
  return codes
}

/** `category` is comma-separated and repeatable. */
function requestedObservationCategories(search: string): string[] {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  return params
    .getAll('category')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

export function isResourceExcluded(resource: FhirResourceLike, scope: SelectiveScope): boolean {
  const resourceType = optionalString(resource.resourceType)
  const { id } = resource
  if (resourceType && scope.excludedTypes.includes(resourceType)) return true
  if (resourceType && id && scope.excludedIds.includes(`${resourceType}/${String(id)}`)) return true
  if (resourceType === 'Observation' && scope.excludedObservationCategories.length > 0) {
    const codes = observationCategoryCodes(resource)
    if (codes.some((c) => scope.excludedObservationCategories.includes(c))) return true
  }
  return false
}

export function preScreenSelectiveRequest(
  fhirPath: string,
  search: string,
  scope: SelectiveScope,
): SelectivePreAction {
  const segments = pathSegments(fhirPath)
  // Base/pagination (`_getpages`) and metadata: fetch, then post-filter.
  if (segments.length === 0 || segments[0] === 'metadata') return { action: 'passthrough' }

  const type = segments[0]
  const isRead = segments.length >= 2

  if (scope.excludedTypes.includes(type)) {
    return isRead ? { action: 'deny' } : { action: 'empty-bundle' }
  }

  if (isRead && scope.excludedIds.includes(`${type}/${segments[1]}`)) {
    return { action: 'deny' }
  }

  if (type === 'Observation' && !isRead && scope.excludedObservationCategories.length > 0) {
    const requested = requestedObservationCategories(search)
    if (requested.length > 0 && requested.every((c) => scope.excludedObservationCategories.includes(c))) {
      return { action: 'empty-bundle' }
    }
  }

  return { action: 'passthrough' }
}

export function emptySearchBundle(): FhirBundleLike {
  return { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }
}

export interface SelectiveFilterResult {
  body: unknown
  /** Caller must respond 404. */
  denied: boolean
}

/** Bundles drop hidden entries and `total`, keeping link-based pagination consistent. */
export function applySelectiveFilter(payload: unknown, scope: SelectiveScope): SelectiveFilterResult {
  if (!isSelectiveScopeActive(scope) || !isRecord(payload)) {
    return { body: payload, denied: false }
  }

  if (payload.resourceType === 'Bundle' && Array.isArray(payload.entry)) {
    const kept = payload.entry.filter((entry) => {
      const resource = isRecord(entry) ? entry.resource : undefined
      return !isRecord(resource) || !isResourceExcluded(resource, scope)
    })
    if (kept.length === payload.entry.length) return { body: payload, denied: false }
    const { total: _drop, ...rest } = payload
    return { body: { ...rest, entry: kept }, denied: false }
  }

  if (typeof payload.resourceType === 'string') {
    return { body: payload, denied: isResourceExcluded(payload, scope) }
  }

  return { body: payload, denied: false }
}
