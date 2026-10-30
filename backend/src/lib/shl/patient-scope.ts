// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { PAGE_CONTINUATION_PARAMS, isPageContinuation, parseFhirPath } from '../fhir-capabilities'
import { literalReferenceTarget } from '../fhir-reference'
import {
  PATIENT_COMPARTMENT, compartmentSearchParam, confinedBySecurityContext, patientCompartmentVerdict,
} from '../patient-compartment/definition'
import { isRecord } from '../type-guards'
import type { ScopeDecision, SelectiveFilterResult } from './scope'

export interface SharedPatient {
  patientId: string
  serverUrl: string
}

export interface SharedRequest {
  method: string
  fhirPath: string
  search: string
}

const PATIENT = 'Patient'
const SHARED_PAGING_PARAMS: ReadonlySet<string> = new Set([...PAGE_CONTINUATION_PARAMS].filter((name) => name !== '_format'))
const PATIENT_PARAMS: ReadonlySet<string> = new Set(['patient', 'subject'])
const DENY: ScopeDecision = { allowed: false }

function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
}

function toSearch(params: URLSearchParams): string {
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function namesPatient(value: string, shared: SharedPatient): boolean {
  if (value === shared.patientId) return true
  const target = literalReferenceTarget(value, shared.serverUrl)
  return target?.type === PATIENT && target.id === shared.patientId
}

function patientParamNames(resourceType: string): ReadonlySet<string> {
  const param = PATIENT_COMPARTMENT.get(resourceType)?.param
  if (resourceType === PATIENT) return new Set(['_id'])
  return param ? new Set([...PATIENT_PARAMS, param]) : PATIENT_PARAMS
}

function namesOnlySharedPatient(params: URLSearchParams, resourceType: string, shared: SharedPatient): boolean {
  const names = patientParamNames(resourceType)
  for (const [name, value] of params) {
    if (!names.has(name.split(':')[0])) continue
    if (!value.split(',').every((part) => namesPatient(part.trim(), shared))) return false
  }
  return true
}

function confinedSearch(resourceType: string, search: string, shared: SharedPatient): ScopeDecision {
  const params = searchParams(search)
  params.delete('_format')
  if (!namesOnlySharedPatient(params, resourceType, shared)) return DENY
  const forced = compartmentSearchParam(resourceType, shared.patientId)
  if (forced) params.append(...forced)
  return { allowed: true, rewrittenSearch: toSearch(params) }
}

function withoutFormat(search: string): ScopeDecision {
  const params = searchParams(search)
  if (!params.has('_format')) return { allowed: true }
  params.delete('_format')
  return { allowed: true, rewrittenSearch: toSearch(params) }
}


/** Keeps a whole-patient share inside its patient's compartment; the answer is then checked by {@link screenSharedPatientAnswer}. */
export function confineToSharedPatient(request: SharedRequest, shared: SharedPatient): ScopeDecision {
  const segments = request.fhirPath.split('/').filter(Boolean)
  if (segments.length === 0) return isPageContinuation(searchParams(request.search), SHARED_PAGING_PARAMS) ? { allowed: true } : DENY
  if (segments.length === 1 && segments[0] === 'metadata') return { allowed: true }

  const path = parseFhirPath(request.fhirPath, request.method.toUpperCase())
  const resourceType = path.resourceType
  if (!resourceType) return DENY

  if (path.compartmentType) {
    if (path.compartmentType !== PATIENT || segments[1] !== shared.patientId) return DENY
    return withoutFormat(request.search)
  }
  if (resourceType === PATIENT && segments[1] && !segments[1].startsWith('_') && segments[1] !== shared.patientId) return DENY
  if (path.isOperation) return resourceType === PATIENT && path.resourceId === shared.patientId ? withoutFormat(request.search) : DENY
  if (path.isHistory) return path.isInstance ? withoutFormat(request.search) : DENY
  if (path.isInstance) return withoutFormat(request.search)
  if (confinedBySecurityContext(resourceType)) return DENY
  return confinedSearch(resourceType, request.search, shared)
}

function belongsToSharedPatient(resource: Record<string, unknown>, shared: SharedPatient): boolean {
  const type = resource.resourceType
  if (typeof type !== 'string') return true
  if (type === PATIENT) return resource.id === shared.patientId
  if (!PATIENT_COMPARTMENT.has(type) && !confinedBySecurityContext(type)) return true
  return patientCompartmentVerdict(resource, shared.patientId, shared.serverUrl).member
}

/** Drops Bundle entries of anyone but the shared patient, and denies a single such resource. */
export function screenSharedPatientAnswer(payload: unknown, shared: SharedPatient): SelectiveFilterResult {
  if (!isRecord(payload)) return { body: payload, denied: false }
  if (payload.resourceType === 'Bundle' && Array.isArray(payload.entry)) {
    const kept = payload.entry.filter((entry) => !isRecord(entry) || !isRecord(entry.resource) || belongsToSharedPatient(entry.resource, shared))
    if (kept.length === payload.entry.length) return { body: payload, denied: false }
    const { total: _dropped, ...rest } = payload
    return { body: { ...rest, entry: kept }, denied: false }
  }
  return { body: payload, denied: !belongsToSharedPatient(payload, shared) }
}
