// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { parseTokenScopes } from '@proxy-smart/auth'
import { resolveTokenPatient } from '../patient-context'
import { tokenContextStore } from '../token-context-store'
import { relativeReference } from './resource'
import type { AppStateRegistration } from './registration'

export type { AppStateRegistration } from './registration'

export type AppStateInteraction = 'search' | 'create' | 'update' | 'delete'

type ScopeContext = 'patient' | 'user'

export interface AppStateCaller {
  clientId: string
  scopes: ReadonlySet<string>
  patient: string | null
  users: readonly string[]
}

export type AppStateDecision = { allowed: true } | { allowed: false; reason: string }

const PERMISSION: Record<AppStateInteraction, string> = { search: 's', create: 'c', update: 'u', delete: 'd' }
const V1_PERMISSION: Record<AppStateInteraction, string> = { search: 'read', create: 'write', update: 'write', delete: 'write' }

const BASIC_SCOPE_RE = /^(patient|user)\/(Basic|\*)\.([a-z*]+)(?:\?(.*))?$/

function stringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value ? value : undefined
}

export async function callerFromToken(payload: Record<string, unknown>): Promise<AppStateCaller> {
  const clientId = stringClaim(payload, 'azp') ?? stringClaim(payload, 'client_id') ?? ''
  const resolved = await resolveTokenPatient(payload)
  const patient = resolved ? (relativeReference(resolved.patient) ?? `Patient/${resolved.patient}`) : null

  const jti = stringClaim(payload, 'jti')
  const issued = jti ? (await tokenContextStore.get(jti, clientId || undefined))?.fhirUser : undefined
  const users = [issued, stringClaim(payload, 'fhirUser')]
    .map((ref) => (ref ? relativeReference(ref) : null))
    .filter((ref): ref is string => ref !== null)

  return { clientId, scopes: parseTokenScopes(payload), patient, users: [...new Set(users)] }
}

function permits(permissions: string, interaction: AppStateInteraction): boolean {
  if (permissions === '*' || permissions === V1_PERMISSION[interaction]) return true
  return /^c?r?u?d?s?$/.test(permissions) && permissions.includes(PERMISSION[interaction])
}

function narrowsTo(query: string | undefined, stateCode: string): boolean {
  if (query === undefined) return true
  const params = new URLSearchParams(query)
  if ([...params.keys()].some((key) => key !== 'code')) return false
  return params.getAll('code').every((value) => value.split(',').includes(stateCode))
}

function scopeGrants(scopes: ReadonlySet<string>, context: ScopeContext, interaction: AppStateInteraction, stateCode: string): boolean {
  for (const scope of scopes) {
    const match = BASIC_SCOPE_RE.exec(scope)
    if (!match || match[1] !== context) continue
    if (permits(match[3], interaction) && narrowsTo(match[4], stateCode)) return true
  }
  return false
}

function subjectContexts(caller: AppStateCaller, subject: string | null): ScopeContext[] {
  if (subject === null) return ['user']
  const ref = relativeReference(subject)
  if (!ref) return []
  const contexts: ScopeContext[] = []
  if (ref === caller.patient) contexts.push('patient', 'user')
  if (caller.users.includes(ref)) contexts.push('user')
  return [...new Set(contexts)]
}

export function authorizeAppState(input: {
  caller: AppStateCaller
  registration: AppStateRegistration
  interaction: AppStateInteraction
  stateCode: string
  subject: string | null
}): AppStateDecision {
  const { caller, registration, interaction, stateCode, subject } = input

  if (!registration.codes.has(stateCode) && !registration.globalCodes.has(stateCode)) {
    return { allowed: false, reason: `This app is not registered for the App State code ${stateCode}` }
  }

  if (subject === null && interaction !== 'search' && !registration.globalCodes.has(stateCode)) {
    return { allowed: false, reason: `This app may not modify global App State for ${stateCode}` }
  }

  const contexts = subjectContexts(caller, subject)
  if (contexts.length === 0) {
    return { allowed: false, reason: 'The subject is neither the in-context patient nor the in-context user' }
  }

  if (!contexts.some((context) => scopeGrants(caller.scopes, context, interaction, stateCode))) {
    const needed = contexts.map((context) => `${context}/Basic.${PERMISSION[interaction]}`).join(' or ')
    return { allowed: false, reason: `The token does not grant ${interaction} on this App State (requires ${needed})` }
  }

  return { allowed: true }
}
