// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { randomUUID } from 'crypto'
import type { AppStateBasicType, AppStateBundleType, FhirOperationOutcomeType } from '@/schemas/app-state'
import { logger } from '../logger'
import { authorizeAppState, type AppStateCaller, type AppStateInteraction } from './access'
import { appStateCapabilityStatement } from './endpoint'
import type { AppStateRegistration } from './registration'
import {
  checkCreate,
  checkSubject,
  checkUpdate,
  etag,
  fhirFailure,
  parseAppStateBody,
  parseIfMatch,
  parseStateCode,
  stateCodeOf,
  subjectOf,
  type FhirFailure,
} from './resource'
import type { AppStateBackend, AppStateRecord } from './store'

export interface AppStateLimits {
  maxResourceBytes: number
  maxPerSubject: number
}

export interface AppStateServiceOptions {
  backend: AppStateBackend
  registrations: (clientId: string) => Promise<AppStateRegistration>
  endpointUrl: () => string
  fhirBaseUrlPrefix: () => string
  limits: () => AppStateLimits
  newId?: () => string
  now?: () => Date
}

export interface AppStateResponse {
  status: number
  body: AppStateBasicType | AppStateBundleType | FhirOperationOutcomeType | null
  headers: Record<string, string>
}

export type AppStateService = ReturnType<typeof createAppStateService>

function failed(failure: FhirFailure): AppStateResponse {
  return { status: failure.status, body: failure.outcome, headers: {} }
}

const preconditionFailed = (diagnostics: string) => failed(fhirFailure(412, 'conflict', diagnostics))

export function createAppStateService(options: AppStateServiceOptions) {
  const { backend } = options
  const newId = options.newId ?? randomUUID
  const now = options.now ?? (() => new Date())

  async function authorize(
    caller: AppStateCaller,
    interaction: AppStateInteraction,
    stateCode: string,
    subject: string | null,
  ): Promise<FhirFailure | null> {
    if (!caller.clientId) return fhirFailure(403, 'forbidden', 'The access token does not identify the app')
    let registration: AppStateRegistration
    try {
      registration = await options.registrations(caller.clientId)
    } catch (error) {
      logger.fhir.error('App State registration lookup failed', {
        clientId: caller.clientId,
        error: error instanceof Error ? error.message : String(error),
      })
      return fhirFailure(503, 'transient', 'App State authorization is temporarily unavailable')
    }
    const decision = authorizeAppState({ caller, registration, interaction, stateCode, subject })
    if (decision.allowed) return null
    logger.fhir.warn('App State request refused', { clientId: caller.clientId, interaction, stateCode, reason: decision.reason })
    return fhirFailure(403, 'forbidden', decision.reason)
  }

  function persisted(resource: AppStateBasicType, id: string, version: number): AppStateBasicType {
    return { ...resource, id, meta: { ...resource.meta, versionId: String(version), lastUpdated: now().toISOString() } }
  }

  function written(status: number, record: AppStateRecord, extra: Record<string, string> = {}): AppStateResponse {
    logger.fhir.info('App State written', { clientId: record.clientId, stateCode: record.stateCode, id: record.id, version: record.version })
    return { status, body: record.resource, headers: { etag: etag(record.version), ...extra } }
  }

  async function search(caller: AppStateCaller, params: URLSearchParams): Promise<AppStateResponse> {
    const codes = params.getAll('code')
    const stateCode = parseStateCode(codes.length === 1 ? codes[0] : null)
    if (!stateCode.ok) return failed(stateCode)

    const subjects = params.getAll('subject')
    const missing = params.getAll('subject:missing')
    let subject: string | null
    if (subjects.length === 1 && missing.length === 0) {
      const checked = checkSubject(subjects[0], options.fhirBaseUrlPrefix())
      if (!checked.ok) return failed(checked)
      subject = checked.value
    } else if (subjects.length === 0 && missing.length === 1 && missing[0] === 'true') {
      subject = null
    } else {
      return failed(fhirFailure(400, 'invalid', 'Supply exactly one of subject or subject:missing=true'))
    }

    const denied = await authorize(caller, 'search', stateCode.value, subject)
    if (denied) return failed(denied)

    const records = await backend.search({ stateCode: stateCode.value, subject })
    const endpoint = options.endpointUrl()
    const bundle: AppStateBundleType = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: records.length,
      link: [{ relation: 'self', url: `${endpoint}/Basic?${params.toString()}` }],
      entry: records.map((record) => ({
        fullUrl: `${endpoint}/Basic/${record.id}`,
        resource: record.resource,
        search: { mode: 'match' },
      })),
    }
    return { status: 200, body: bundle, headers: {} }
  }

  async function create(caller: AppStateCaller, raw: string): Promise<AppStateResponse> {
    const limits = options.limits()
    const parsed = parseAppStateBody(raw, limits.maxResourceBytes)
    if (!parsed.ok) return failed(parsed)
    const checked = checkCreate(parsed.value, options.fhirBaseUrlPrefix())
    if (!checked.ok) return failed(checked)

    const stateCode = stateCodeOf(checked.value)
    const subject = subjectOf(checked.value)
    const denied = await authorize(caller, 'create', stateCode, subject)
    if (denied) return failed(denied)

    if (await backend.count({ stateCode, subject }) >= limits.maxPerSubject) {
      return failed(fhirFailure(422, 'business-rule', `At most ${limits.maxPerSubject} App State resources are kept per state code and subject`))
    }

    const id = newId()
    const record: AppStateRecord = { id, version: 1, stateCode, subject, clientId: caller.clientId, resource: persisted(checked.value, id, 1) }
    await backend.insert(record)
    return written(201, record, { location: `${options.endpointUrl()}/Basic/${id}/_history/1` })
  }

  async function current(id: string, ifMatch: string | null): Promise<{ record: AppStateRecord; expected: number } | AppStateResponse> {
    const expected = parseIfMatch(ifMatch)
    if (expected === null) return preconditionFailed('If-Match with the current ETag is required')
    const record = await backend.get(id)
    if (!record) return preconditionFailed(`Basic/${id} does not exist or has been deleted`)
    return { record, expected }
  }

  async function update(caller: AppStateCaller, id: string, ifMatch: string | null, raw: string): Promise<AppStateResponse> {
    const parsed = parseAppStateBody(raw, options.limits().maxResourceBytes)
    if (!parsed.ok) return failed(parsed)
    const checked = checkUpdate(parsed.value, id)
    if (!checked.ok) return failed(checked)

    const found = await current(id, ifMatch)
    if (!('record' in found)) return found
    const { record, expected } = found

    const denied = await authorize(caller, 'update', record.stateCode, record.subject)
    if (denied) return failed(denied)
    if (record.version !== expected) return preconditionFailed(`Basic/${id} is at version ${record.version}`)
    if (stateCodeOf(checked.value) !== record.stateCode || subjectOf(checked.value) !== record.subject) {
      return preconditionFailed('Basic.code and Basic.subject cannot change')
    }

    const version = record.version + 1
    const next: AppStateRecord = { ...record, version, resource: persisted(checked.value, id, version) }
    if (!(await backend.replace(next, expected))) return preconditionFailed(`Basic/${id} changed concurrently`)
    return written(200, next)
  }

  async function remove(caller: AppStateCaller, id: string, ifMatch: string | null): Promise<AppStateResponse> {
    const found = await current(id, ifMatch)
    if (!('record' in found)) return found
    const { record, expected } = found

    const denied = await authorize(caller, 'delete', record.stateCode, record.subject)
    if (denied) return failed(denied)
    if (record.version !== expected) return preconditionFailed(`Basic/${id} is at version ${record.version}`)
    if (!(await backend.remove(id, expected))) return preconditionFailed(`Basic/${id} changed concurrently`)

    logger.fhir.info('App State deleted', { clientId: caller.clientId, stateCode: record.stateCode, id })
    return { status: 204, body: null, headers: {} }
  }

  const capabilityStatement = () => appStateCapabilityStatement(options.endpointUrl(), options.limits())

  return { search, create, update, remove, capabilityStatement }
}
