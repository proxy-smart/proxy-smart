// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { AppStateCaller } from './context'
import type { AppStateMode, AppStateRegistration, AppStateRole } from './registration'
import { parseSearchQuery, splitSearchValues } from './resource'

export type { AppStateCaller } from './context'
export type { AppStateRegistration } from './registration'

export type AppStateInteraction = 'search' | 'create' | 'update' | 'delete'

type ScopeContext = 'patient' | 'user'

export type AppStateDecision = { allowed: true } | { allowed: false; reason: string }

const PERMISSION: Record<AppStateInteraction, string> = { search: 's', create: 'c', update: 'u', delete: 'd' }
const V1_PERMISSION: Record<AppStateInteraction, string> = { search: 'read', create: 'write', update: 'write', delete: 'write' }
const MODE: Record<AppStateInteraction, AppStateMode> = { search: 'query', create: 'modify', update: 'modify', delete: 'modify' }

const SCOPE_CONTEXTS: Record<AppStateRole, readonly ScopeContext[]> = {
  patient: ['patient', 'user'],
  user: ['user'],
  global: ['user'],
}

const SUBJECT_LABEL: Record<AppStateRole, string> = {
  patient: 'the in-context patient',
  user: 'the in-context user',
  global: 'global state',
}

const BASIC_SCOPE_RE = /^(patient|user)\/(Basic|\*)\.([a-z*]+)(?:\?(.*))?$/

function permits(permissions: string, interaction: AppStateInteraction): boolean {
  if (permissions === '*' || permissions === V1_PERMISSION[interaction]) return true
  return /^c?r?u?d?s?$/.test(permissions) && permissions.includes(PERMISSION[interaction])
}

function narrowsTo(query: string | undefined, stateCode: string): boolean {
  if (query === undefined) return true
  const params = parseSearchQuery(query)
  if (!params.ok) return false
  if ([...params.value.keys()].some((key) => key !== 'code')) return false
  return (params.value.get('code') ?? []).every((value) => splitSearchValues(value).includes(stateCode))
}

function scopeGrants(scopes: ReadonlySet<string>, context: ScopeContext, interaction: AppStateInteraction, stateCode: string): boolean {
  for (const scope of scopes) {
    const match = BASIC_SCOPE_RE.exec(scope)
    if (!match || match[1] !== context) continue
    if (permits(match[3], interaction) && narrowsTo(match[4], stateCode)) return true
  }
  return false
}

function subjectRoles(caller: AppStateCaller, subject: string | null): AppStateRole[] {
  if (subject === null) return ['global']
  const roles: AppStateRole[] = []
  if (subject === caller.patient) roles.push('patient')
  if (caller.users.includes(subject)) roles.push('user')
  return roles
}

export function authorizeAppState(input: {
  caller: AppStateCaller
  registration: AppStateRegistration
  interaction: AppStateInteraction
  stateCode: string
  subject: string | null
}): AppStateDecision {
  const { caller, registration, interaction, stateCode, subject } = input
  const mode = MODE[interaction]

  const roles = subjectRoles(caller, subject)
  if (roles.length === 0) {
    const reason = 'The subject is neither the in-context patient nor the in-context user'
    return { allowed: false, reason: caller.unbound ? `${reason}. ${caller.unbound}` : reason }
  }

  const registered = roles.filter((role) => registration[role][mode].has(stateCode))
  if (registered.length === 0) {
    const about = roles.map((role) => SUBJECT_LABEL[role]).join(' or ')
    return { allowed: false, reason: `This app is not registered to ${mode} App State ${stateCode} for ${about}` }
  }

  const contexts = [...new Set(registered.flatMap((role) => SCOPE_CONTEXTS[role]))]
  if (!contexts.some((context) => scopeGrants(caller.scopes, context, interaction, stateCode))) {
    const needed = contexts.map((context) => `${context}/Basic.${PERMISSION[interaction]}`).join(' or ')
    return { allowed: false, reason: `The token does not grant ${interaction} on this App State (requires ${needed})` }
  }

  return { allowed: true }
}
