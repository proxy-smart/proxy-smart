// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { Value } from '@sinclair/typebox/value'
import { LaunchTask, type LaunchTaskType } from '@/schemas/auth/task-launch'
import { isFhirId } from './fhir-reference'

export const SMART_CODES_SYSTEM = 'http://hl7.org/fhir/smart-app-launch/CodeSystem/smart-codes'

const LAUNCH_KINDS = { 'launch-app-ehr': 'ehr', 'launch-app-standalone': 'standalone' } as const
const APPLICATION_INPUT = 'smartonfhir-application'
const APP_CONTEXT_INPUT = 'smartonfhir-appcontext'

export type LaunchKind = (typeof LAUNCH_KINDS)[keyof typeof LAUNCH_KINDS]
type Reference = NonNullable<LaunchTaskType['for']>
type CodeableConcept = NonNullable<LaunchTaskType['code']>

export interface LaunchTaskRequest {
  kind: LaunchKind
  id?: string
  status: string
  appUrl: string
  appContext?: string
  patient?: Reference
  encounter?: Reference
}

export type LaunchTaskResult = { ok: true; task: LaunchTaskRequest } | { ok: false; issues: string[] }

function hasSmartCode(concept: CodeableConcept | undefined, code: string): boolean {
  return concept?.coding?.some((c) => c.system === SMART_CODES_SYSTEM && c.code === code) ?? false
}

function launchKind(code: CodeableConcept | undefined): LaunchKind | undefined {
  const kinds = Object.entries(LAUNCH_KINDS).filter(([c]) => hasSmartCode(code, c)).map(([, kind]) => kind)
  return kinds.length === 1 ? kinds[0] : undefined
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function structuralIssues(task: unknown): string[] {
  const seen = new Set<string>()
  const issues: string[] = []
  for (const error of Value.Errors(LaunchTask, task)) {
    const path = error.path || '/'
    if (seen.has(path)) continue
    seen.add(path)
    issues.push(`Task${path.replaceAll('/', '.')}: ${error.message}`)
  }
  return issues
}

export function readLaunchTask(resource: unknown): LaunchTaskResult {
  if (!Value.Check(LaunchTask, resource)) return { ok: false, issues: structuralIssues(resource) }

  const issues: string[] = []
  const kind = launchKind(resource.code)
  if (!kind) issues.push(`Task.code must carry ${SMART_CODES_SYSTEM}#launch-app-ehr or #launch-app-standalone`)

  const inputs = resource.input ?? []
  const appInputs = inputs.filter((input) => hasSmartCode(input.type, APPLICATION_INPUT))
  const contextInputs = inputs.filter((input) => hasSmartCode(input.type, APP_CONTEXT_INPUT))

  const appUrl = appInputs.length === 1 ? appInputs[0].valueUrl : undefined
  if (appInputs.length !== 1) issues.push(`Task.input must carry exactly one ${APPLICATION_INPUT} input`)
  else if (appUrl === undefined) issues.push('Task.input:launchurl must be a valueUrl')
  else if (!isHttpUrl(appUrl)) issues.push('Task.input:launchurl must be an absolute http(s) URL')

  const appContext = contextInputs[0]?.valueString
  if (contextInputs.length > 1) issues.push(`Task.input may carry at most one ${APP_CONTEXT_INPUT} input`)
  else if (contextInputs.length === 1 && appContext === undefined) issues.push('Task.input:launchcontext must be a valueString')

  if (issues.length > 0 || !kind || !appUrl) return { ok: false, issues }
  return {
    ok: true,
    task: {
      kind,
      ...(resource.id !== undefined && { id: resource.id }),
      status: resource.status,
      appUrl,
      ...(appContext !== undefined && { appContext }),
      ...(resource.for && { patient: resource.for }),
      ...(resource.encounter && { encounter: resource.encounter }),
    },
  }
}

export type ContextReference = { ok: true; reference: string } | { ok: false; issue: string }

/** A literal reference on one of `bases`, reduced to "Type/id". */
export function contextReference(element: string, ref: Reference, type: string, bases: readonly string[]): ContextReference {
  if (ref.type !== undefined && ref.type !== type) return { ok: false, issue: `${element} must reference a ${type}` }
  const literal = ref.reference
  if (!literal) return { ok: false, issue: `${element} must be a literal reference to a ${type}` }

  const base = bases.find((b) => literal.startsWith(`${b.replace(/\/+$/, '')}/`))
  const relative = base ? literal.slice(base.replace(/\/+$/, '').length + 1) : literal
  if (!base && /^[a-z][a-z0-9+.-]*:/i.test(literal)) return { ok: false, issue: `${element} references a resource on another server` }

  const [resourceType, id, history] = relative.split('/')
  if (resourceType !== type || !isFhirId(id) || (history !== undefined && history !== '_history')) {
    return { ok: false, issue: `${element} must reference a ${type}` }
  }
  return { ok: true, reference: `${type}/${id}` }
}
