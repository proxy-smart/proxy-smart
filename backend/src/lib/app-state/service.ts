// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { randomUUID } from 'crypto'
import type { AppStateBasicType, AppStateBundleType, FhirOperationOutcomeType } from '@/schemas/app-state'
import { logger } from '../logger'
import { authorizeAppState, type AppStateInteraction } from './access'
import { callerFromToken, type AppStateCaller, type AppStateFhirServer } from './context'
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
  parseSearchQuery,
  parseStateCode,
  splitSearchValues,
  stateCodeOf,
  subjectOf,
  trimTrailingSlash,
  type FhirFailure,
  type FhirResult,
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
  fhirServers: () => Promise<readonly AppStateFhirServer[]>
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

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createAppStateService(options: AppStateServiceOptions) {
  const { backend } = options
  const newId = options.newId ?? randomUUID
  const now = options.now ?? (() => new Date())

  async function servers(): Promise<FhirResult<readonly AppStateFhirServer[]>> {
    try {
      return { ok: true, value: await options.fhirServers() }
    } catch (error) {
      logger.fhir.error('App State could not list the FHIR servers', { error: errorMessage(error) })
      return fhirFailure(503, 'transient', 'App State is temporarily unavailable')
    }
  }

  async function fhirBases(): Promise<FhirResult<string[]>> {
    const listed = await servers()
    return listed.ok ? { ok: true, value: listed.value.map((server) => trimTrailingSlash(server.base)) } : listed
  }

  async function caller(payload: Record<string, unknown>): Promise<FhirResult<AppStateCaller>> {
    const listed = await servers()
    return listed.ok ? { ok: true, value: await callerFromToken(payload, listed.value) } : listed
  }

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
      logger.fhir.error('App State registration lookup failed', { clientId: caller.clientId, error: errorMessage(error) })
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

  async function searchedSubject(params: Map<string, string[]>): Promise<FhirResult<string | null>> {
    const subjects = params.get('subject') ?? []
    const missing = params.get('subject:missing') ?? []
    if (subjects.length === 1 && missing.length === 0) {
      const bases = await fhirBases()
      return bases.ok ? checkSubject(subjects[0], bases.value) : bases
    }
    if (subjects.length === 0 && missing.length === 1 && missing[0] === 'true') return { ok: true, value: null }
    return fhirFailure(400, 'invalid', 'Supply exactly one of subject or subject:missing=true')
  }

  async function search(caller: AppStateCaller, query: string): Promise<AppStateResponse> {
    const params = parseSearchQuery(query)
    if (!params.ok) return failed(params)
    const codes = (params.value.get('code') ?? []).flatMap(splitSearchValues)
    const stateCode = parseStateCode(codes.length === 1 ? codes[0] : null)
    if (!stateCode.ok) return failed(stateCode)
    const subject = await searchedSubject(params.value)
    if (!subject.ok) return failed(subject)

    const denied = await authorize(caller, 'search', stateCode.value, subject.value)
    if (denied) return failed(denied)

    const records = await backend.search({ stateCode: stateCode.value, subject: subject.value })
    const endpoint = options.endpointUrl()
    const subjectParam = subject.value === null ? 'subject:missing=true' : `subject=${encodeURIComponent(subject.value)}`
    const bundle: AppStateBundleType = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: records.length,
      link: [{ relation: 'self', url: `${endpoint}/Basic?code=${encodeURIComponent(stateCode.value)}&${subjectParam}` }],
      ...(records.length > 0 && {
        entry: records.map((record) => ({ fullUrl: `${endpoint}/Basic/${record.id}`, resource: record.resource, search: { mode: 'match' } })),
      }),
    }
    return { status: 200, body: bundle, headers: {} }
  }

  async function create(caller: AppStateCaller, raw: string): Promise<AppStateResponse> {
    const limits = options.limits()
    const parsed = parseAppStateBody(raw, limits.maxResourceBytes)
    if (!parsed.ok) return failed(parsed)
    const bases = await fhirBases()
    if (!bases.ok) return failed(bases)
    const checked = checkCreate(parsed.value, bases.value)
    if (!checked.ok) return failed(checked)

    const stateCode = stateCodeOf(checked.value)
    const subject = subjectOf(checked.value)
    const denied = await authorize(caller, 'create', stateCode, subject)
    if (denied) return failed(denied)

    const id = newId()
    const record: AppStateRecord = { id, version: 1, stateCode, subject, clientId: caller.clientId, resource: persisted(checked.value, id, 1) }
    if (!(await backend.insert(record, limits.maxPerSubject))) {
      return failed(fhirFailure(422, 'business-rule', `At most ${limits.maxPerSubject} App State resources are kept per state code and subject`))
    }
    return written(201, record, { location: `${options.endpointUrl()}/Basic/${id}/_history/1` })
  }

  async function current(id: string, ifMatch: string | null): Promise<{ record: AppStateRecord; expected: number | null } | AppStateResponse> {
    const record = await backend.get(id)
    if (!record) return preconditionFailed(`Basic/${id} does not exist or has been deleted`)
    const condition = parseIfMatch(ifMatch)
    if (!condition.present) return failed(fhirFailure(400, 'required', 'If-Match with the current ETag is required'))
    return { record, expected: condition.version }
  }

  async function update(caller: AppStateCaller, id: string, ifMatch: string | null, raw: string): Promise<AppStateResponse> {
    const found = await current(id, ifMatch)
    if (!('record' in found)) return found
    const { record, expected } = found

    const parsed = parseAppStateBody(raw, options.limits().maxResourceBytes)
    if (!parsed.ok) return failed(parsed)
    const checked = checkUpdate(parsed.value, id)
    if (!checked.ok) return failed(checked)

    const denied = await authorize(caller, 'update', record.stateCode, record.subject)
    if (denied) return failed(denied)
    if (record.version !== expected) return preconditionFailed(`Basic/${id} is at version ${record.version}`)
    if (stateCodeOf(checked.value) !== record.stateCode || subjectOf(checked.value) !== record.subject) {
      return preconditionFailed('Basic.code and Basic.subject cannot change')
    }

    const version = record.version + 1
    const next: AppStateRecord = { ...record, version, resource: persisted(checked.value, id, version) }
    if (!(await backend.replace(next, record.version))) return preconditionFailed(`Basic/${id} changed concurrently`)
    return written(200, next)
  }

  async function remove(caller: AppStateCaller, id: string, ifMatch: string | null): Promise<AppStateResponse> {
    const found = await current(id, ifMatch)
    if (!('record' in found)) return found
    const { record, expected } = found

    const denied = await authorize(caller, 'delete', record.stateCode, record.subject)
    if (denied) return failed(denied)
    if (record.version !== expected) return preconditionFailed(`Basic/${id} is at version ${record.version}`)
    if (!(await backend.remove(id, record.version))) return preconditionFailed(`Basic/${id} changed concurrently`)

    logger.fhir.info('App State deleted', { clientId: caller.clientId, stateCode: record.stateCode, id })
    return { status: 204, body: null, headers: {} }
  }

  const capabilityStatement = () => appStateCapabilityStatement(options.endpointUrl(), options.limits())

  return { caller, search, create, update, remove, capabilityStatement }
}
