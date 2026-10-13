// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { getAttr } from '../keycloak-component-config'
import { STATE_CODE_PATTERN } from '@/schemas/app-state'

export const APP_STATE_CODES_ATTRIBUTE = 'app_state_codes'
export const APP_STATE_GLOBAL_CODES_ATTRIBUTE = 'app_state_global_codes'

export interface AppStateRegistration {
  codes: ReadonlySet<string>
  globalCodes: ReadonlySet<string>
}

export const NO_APP_STATE: AppStateRegistration = { codes: new Set(), globalCodes: new Set() }

const STATE_CODE_RE = new RegExp(STATE_CODE_PATTERN)

export function isStateCode(value: unknown): value is string {
  return typeof value === 'string' && STATE_CODE_RE.test(value)
}

function readCodes(attrs: Record<string, unknown> | undefined, key: string): Set<string> {
  const raw = getAttr(attrs, key)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter(isStateCode)) : new Set()
  } catch {
    return new Set()
  }
}

export function parseAppStateRegistration(attrs: Record<string, unknown> | undefined): AppStateRegistration {
  return {
    codes: readCodes(attrs, APP_STATE_CODES_ATTRIBUTE),
    globalCodes: readCodes(attrs, APP_STATE_GLOBAL_CODES_ATTRIBUTE),
  }
}

// Keycloak client attributes are plain strings; an empty list clears the attribute.
export function serializeStateCodes(codes: readonly string[]): string {
  return codes.length > 0 ? JSON.stringify([...new Set(codes)]) : ''
}

export function appStateAttributes(body: { appStateCodes?: string[]; appStateGlobalCodes?: string[] }): Record<string, string> {
  return {
    ...(body.appStateCodes !== undefined && { [APP_STATE_CODES_ATTRIBUTE]: serializeStateCodes(body.appStateCodes) }),
    ...(body.appStateGlobalCodes !== undefined && { [APP_STATE_GLOBAL_CODES_ATTRIBUTE]: serializeStateCodes(body.appStateGlobalCodes) }),
  }
}
