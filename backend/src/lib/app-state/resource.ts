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

export interface SplitReference {
  base: string | null
  type: string
  relative: string
}

export function splitReference(reference: string): SplitReference | null {
  const tail = REFERENCE_TAIL_RE.exec(reference)
  if (!tail) return null
  const base = reference.slice(0, reference.length - tail[0].length)
  if (base && !ABSOLUTE_RE.test(base)) return null
  return { base: base || null, type: tail[1], relative: `${tail[1]}/${tail[2]}` }
}

export const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '')

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

export function checkSubject(subject: string, fhirBases: readonly string[]): FhirResult<string> {
  const split = splitReference(subject)
  if (!split?.base) {
    return fhirFailure(400, 'invalid', 'Basic.subject.reference SHALL be an absolute reference')
  }
  if (!SUBJECT_TYPES.includes(split.type)) {
    return fhirFailure(400, 'not-supported', `App State subjects may be ${SUBJECT_TYPES.join(', ')}, not ${split.type}`)
  }
  if (!fhirBases.includes(split.base)) {
    return fhirFailure(400, 'invalid', 'Basic.subject.reference SHALL reference a resource on a FHIR server this proxy serves')
  }
  return { ok: true, value: subject }
}

export function parseSearchQuery(query: string): FhirResult<Map<string, string[]>> {
  const params = new Map<string, string[]>()
  try {
    for (const pair of query.replace(/^\?/, '').split('&')) {
      if (!pair) continue
      const at = pair.indexOf('=')
      const name = decodeURIComponent(at < 0 ? pair : pair.slice(0, at))
      const value = at < 0 ? '' : decodeURIComponent(pair.slice(at + 1))
      params.set(name, [...(params.get(name) ?? []), value])
    }
  } catch {
    return fhirFailure(400, 'invalid', 'The query string is not validly percent-encoded')
  }
  return { ok: true, value: params }
}

export function splitSearchValues(value: string): string[] {
  return value.split(/(?<!\\),/).map((part) => part.replaceAll('\\,', ','))
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

export function checkCreate(resource: AppStateBasicType, fhirBases: readonly string[]): FhirResult<AppStateBasicType> {
  if (resource.id !== undefined) return fhirFailure(400, 'invalid', 'Basic.id SHALL NOT be included when creating App State')
  if (resource.meta?.versionId !== undefined) {
    return fhirFailure(400, 'invalid', 'Basic.meta.versionId SHALL NOT be included when creating App State')
  }
  const subject = subjectOf(resource)
  if (subject !== null) {
    const checked = checkSubject(subject, fhirBases)
    if (!checked.ok) return checked
  }
  return { ok: true, value: resource }
}

export function checkUpdate(resource: AppStateBasicType, id: string): FhirResult<AppStateBasicType> {
  if (resource.id !== id) return fhirFailure(400, 'invalid', 'Basic.id SHALL be present and match the id in the URL')
  return { ok: true, value: resource }
}

export type IfMatch = { present: false } | { present: true; version: number | null }

export function parseIfMatch(header: string | null): IfMatch {
  if (!header?.trim()) return { present: false }
  const match = /^(?:W\/)?"(\d+)"$/.exec(header.trim())
  return { present: true, version: match ? Number(match[1]) : null }
}

export function etag(version: number): string {
  return `W/"${version}"`
}
