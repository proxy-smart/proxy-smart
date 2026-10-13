// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Value } from '@sinclair/typebox/value'
import { AppStateBasic, type AppStateBasicType, type FhirOperationOutcomeType } from '@/schemas/app-state'
import { isStateCode } from './registration'

export const SUBJECT_TYPES: readonly string[] = ['Patient', 'Practitioner', 'PractitionerRole', 'RelatedPerson', 'Person']

const REFERENCE_TAIL_RE = /(?:^|\/)([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/
const ABSOLUTE_RE = /^https?:\/\/\S+$/

export interface FhirFailure {
  ok: false
  status: number
  outcome: FhirOperationOutcomeType
}

export type FhirResult<T> = { ok: true; value: T } | FhirFailure

export function fhirFailure(status: number, code: string, diagnostics: string): FhirFailure {
  return { ok: false, status, outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] } }
}

export function relativeReference(reference: string): string | null {
  const match = REFERENCE_TAIL_RE.exec(reference)
  return match ? `${match[1]}/${match[2]}` : null
}

export function stateCodeOf(resource: AppStateBasicType): string {
  const [coding] = resource.code.coding
  return `${coding.system}|${coding.code}`
}

export function subjectOf(resource: AppStateBasicType): string | null {
  return resource.subject?.reference ?? null
}

export function parseStateCode(value: string | null): FhirResult<string> {
  if (!isStateCode(value)) {
    return fhirFailure(400, 'invalid', 'code must be a single App State code of the form system|code')
  }
  return { ok: true, value }
}

export function checkSubject(subject: string, fhirBaseUrlPrefix: string): FhirResult<string> {
  const tail = REFERENCE_TAIL_RE.exec(subject)
  if (!ABSOLUTE_RE.test(subject) || !tail) {
    return fhirFailure(400, 'invalid', 'Basic.subject.reference SHALL be an absolute reference')
  }
  if (!SUBJECT_TYPES.includes(tail[1])) {
    return fhirFailure(400, 'not-supported', `App State subjects may be ${SUBJECT_TYPES.join(', ')}, not ${tail[1]}`)
  }
  const base = subject.slice(0, subject.length - tail[0].length)
  const rest = base.startsWith(fhirBaseUrlPrefix) ? base.slice(fhirBaseUrlPrefix.length).split('/') : []
  if (rest.length !== 2 || rest.some((segment) => !segment)) {
    return fhirFailure(400, 'invalid', 'Basic.subject.reference SHALL reference a resource on a FHIR server this proxy serves')
  }
  return { ok: true, value: subject }
}

export function parseAppStateBody(raw: string, maxBytes: number): FhirResult<AppStateBasicType> {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return fhirFailure(413, 'too-costly', `App State resources may not exceed ${maxBytes} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fhirFailure(400, 'structure', 'The request body is not valid JSON')
  }
  if (!Value.Check(AppStateBasic, parsed)) {
    const error = Value.Errors(AppStateBasic, parsed).First()
    const where = error?.path || '/'
    return fhirFailure(400, 'structure', `Not a valid SMART App State Basic resource at ${where}: ${error?.message ?? 'invalid'}`)
  }
  return { ok: true, value: parsed }
}

export function checkCreate(resource: AppStateBasicType, fhirBaseUrlPrefix: string): FhirResult<AppStateBasicType> {
  if (resource.id !== undefined) return fhirFailure(400, 'invalid', 'Basic.id SHALL NOT be included when creating App State')
  if (resource.meta?.versionId !== undefined) {
    return fhirFailure(400, 'invalid', 'Basic.meta.versionId SHALL NOT be included when creating App State')
  }
  const subject = subjectOf(resource)
  if (subject !== null) {
    const checked = checkSubject(subject, fhirBaseUrlPrefix)
    if (!checked.ok) return checked
  }
  return { ok: true, value: resource }
}

export function checkUpdate(resource: AppStateBasicType, id: string): FhirResult<AppStateBasicType> {
  if (resource.id !== id) return fhirFailure(400, 'invalid', 'Basic.id SHALL be present and match the id in the URL')
  return { ok: true, value: resource }
}

export function parseIfMatch(header: string | null): number | null {
  const match = header ? /^(?:W\/)?"(\d+)"$/.exec(header.trim()) : null
  return match ? Number(match[1]) : null
}

export function etag(version: number): string {
  return `W/"${version}"`
}
