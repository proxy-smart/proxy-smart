// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import posture from './access-posture.json'
import { ACCESS_POSTURE_SETTINGS, ENFORCEMENT_MODES, isEnforcementMode, parseAccessPosture, type EnforcementMode } from '@proxy-smart/guards'
import { IDENTITY_ASSURANCE_LEVELS, type IdentityAssuranceLevel } from './consent/types'
import { isOneOf } from './type-guards'

export { isEnforcementMode, type EnforcementMode }

/** The intended posture of every deployment; env vars and saved admin settings only override it. */
export const ENFORCEMENT_DEFAULTS = parseAccessPosture(posture, 'access-posture.json')

/** Security settings and the values each accepts; anything else stops startup. */
const SECURITY_ENV: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [Object.values(ACCESS_POSTURE_SETTINGS), ENFORCEMENT_MODES],
  [['CONSENT_ENABLED', 'IAL_ENABLED', 'IAL_VERIFY_PATIENT_LINK', 'IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE', 'TENANT_QUERY_ISOLATION'], ['true', 'false']],
  [['IAL_MINIMUM_LEVEL', 'IAL_SENSITIVE_MINIMUM_LEVEL'], IDENTITY_ASSURANCE_LEVELS],
  [['DICOM_UPLOAD_ADMISSION_ON_ERROR'], ['allow', 'deny']],
]

function setValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Unset uses the default; a set value that is not a mode enforces. */
export function parseEnforcementMode(value: unknown, fallback: EnforcementMode): EnforcementMode {
  const raw = setValue(value)
  if (raw === undefined) return fallback
  return isEnforcementMode(raw) ? raw : 'enforce'
}

/** Unset uses the default; only the exact string false turns the check off. */
export function parseSecurityFlag(value: unknown, fallback: boolean): boolean {
  const raw = setValue(value)
  return raw === undefined ? fallback : raw !== 'false'
}

/** Unset uses the default; a set value that is not a level requires the highest one. */
export function parseAssuranceLevel(value: unknown, fallback: IdentityAssuranceLevel): IdentityAssuranceLevel {
  const raw = setValue(value)
  if (raw === undefined) return fallback
  return isOneOf(IDENTITY_ASSURANCE_LEVELS, raw) ? raw : 'level4'
}

/** One message per security variable set to a value it does not recognise. */
export function securityEnvErrors(env: Readonly<Record<string, string | undefined>>): string[] {
  return SECURITY_ENV.flatMap(([names, accepted]) => names.flatMap((name) => {
    const raw = setValue(env[name])
    return raw === undefined || accepted.includes(raw) ? [] : [`${name}="${raw}" is not one of ${accepted.join(', ')}`]
  }))
}
