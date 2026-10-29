// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { getAttr } from '../keycloak-component-config'
import { isRecord, parseJson } from '../type-guards'
import { STATE_CODE_PATTERN, type AppStatePermissionsType } from '@/schemas/app-state'

export const APP_STATE_CODES_ATTRIBUTE = 'app_state_codes'
export const APP_STATE_GLOBAL_CODES_ATTRIBUTE = 'app_state_global_codes'
export const APP_STATE_PERMISSIONS_ATTRIBUTE = 'app_state_permissions'

export type AppStateRole = 'patient' | 'user' | 'global'
export type AppStateMode = 'query' | 'modify'

export const APP_STATE_ROLES: readonly AppStateRole[] = ['patient', 'user', 'global']
export const APP_STATE_MODES: readonly AppStateMode[] = ['query', 'modify']

export type AppStateRegistration = Readonly<Record<AppStateRole, Readonly<Record<AppStateMode, ReadonlySet<string>>>>>

type Grant = readonly [AppStateRole, AppStateMode]

const CODE_GRANTS: readonly Grant[] = [
  ['patient', 'query'], ['patient', 'modify'], ['user', 'query'], ['user', 'modify'], ['global', 'query'],
]
const GLOBAL_CODE_GRANTS: readonly Grant[] = [...CODE_GRANTS, ['global', 'modify']]

const STATE_CODE_RE = new RegExp(STATE_CODE_PATTERN)

export function isStateCode(value: unknown): value is string {
  return typeof value === 'string' && STATE_CODE_RE.test(value)
}

export interface AppStateGrants {
  codes?: Iterable<string>
  globalCodes?: Iterable<string>
  permissions?: AppStatePermissionsType
}

export function buildAppStateRegistration({ codes = [], globalCodes = [], permissions = {} }: AppStateGrants): AppStateRegistration {
  const sets = (): Record<AppStateMode, Set<string>> => ({ query: new Set(), modify: new Set() })
  const registration: Record<AppStateRole, Record<AppStateMode, Set<string>>> = { patient: sets(), user: sets(), global: sets() }
  const grant = (grants: readonly Grant[], granted: Iterable<string>) => {
    for (const code of granted) {
      if (!isStateCode(code)) continue
      for (const [role, mode] of grants) registration[role][mode].add(code)
    }
  }
  grant(CODE_GRANTS, codes)
  grant(GLOBAL_CODE_GRANTS, globalCodes)
  for (const role of APP_STATE_ROLES) {
    for (const mode of APP_STATE_MODES) grant([[role, mode]], permissions[role]?.[mode] ?? [])
  }
  return registration
}

export const NO_APP_STATE: AppStateRegistration = buildAppStateRegistration({})

function readJson(attrs: Record<string, unknown> | undefined, key: string): unknown {
  return parseJson(getAttr(attrs, key))
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function stateCodes(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isStateCode))] : []
}

function normalizePermissions(value: unknown): AppStatePermissionsType {
  const permissions: AppStatePermissionsType = {}
  for (const role of APP_STATE_ROLES) {
    const query = stateCodes(field(field(value, role), 'query'))
    const modify = stateCodes(field(field(value, role), 'modify'))
    if (query.length > 0 || modify.length > 0) {
      permissions[role] = { ...(query.length > 0 && { query }), ...(modify.length > 0 && { modify }) }
    }
  }
  return permissions
}

export function appStateFields(attrs: Record<string, unknown> | undefined) {
  return {
    appStateCodes: stateCodes(readJson(attrs, APP_STATE_CODES_ATTRIBUTE)),
    appStateGlobalCodes: stateCodes(readJson(attrs, APP_STATE_GLOBAL_CODES_ATTRIBUTE)),
    appStatePermissions: normalizePermissions(readJson(attrs, APP_STATE_PERMISSIONS_ATTRIBUTE)),
  }
}

export function parseAppStateRegistration(attrs: Record<string, unknown> | undefined): AppStateRegistration {
  const fields = appStateFields(attrs)
  return buildAppStateRegistration({ codes: fields.appStateCodes, globalCodes: fields.appStateGlobalCodes, permissions: fields.appStatePermissions })
}

// Keycloak client attributes are plain strings; an empty value clears the attribute.
export function serializeStateCodes(codes: readonly string[]): string {
  return codes.length > 0 ? JSON.stringify([...new Set(codes)]) : ''
}

function serializePermissions(permissions: AppStatePermissionsType): string {
  const normalized = normalizePermissions(permissions)
  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : ''
}

export function appStateAttributes(body: {
  appStateCodes?: string[]
  appStateGlobalCodes?: string[]
  appStatePermissions?: AppStatePermissionsType
}): Record<string, string> {
  return {
    ...(body.appStateCodes !== undefined && { [APP_STATE_CODES_ATTRIBUTE]: serializeStateCodes(body.appStateCodes) }),
    ...(body.appStateGlobalCodes !== undefined && { [APP_STATE_GLOBAL_CODES_ATTRIBUTE]: serializeStateCodes(body.appStateGlobalCodes) }),
    ...(body.appStatePermissions !== undefined && { [APP_STATE_PERMISSIONS_ATTRIBUTE]: serializePermissions(body.appStatePermissions) }),
  }
}
