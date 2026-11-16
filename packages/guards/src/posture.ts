// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { requireRecord } from './record'
import { isOneOf } from './values'

export const ENFORCEMENT_MODES = ['enforce', 'audit-only', 'disabled'] as const

export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number]

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return isOneOf(ENFORCEMENT_MODES, value)
}

export function requireEnforcementMode(value: unknown, what: string): EnforcementMode {
  if (!isEnforcementMode(value)) throw new Error(`${what} must be one of ${ENFORCEMENT_MODES.join(', ')}`)
  return value
}

/** Each access posture key and the setting that overrides it on a deployment. */
export const ACCESS_POSTURE_SETTINGS = {
  consent: 'CONSENT_MODE',
  scopeEnforcement: 'SCOPE_ENFORCEMENT_MODE',
  roleBasedFiltering: 'ROLE_BASED_FILTERING_MODE',
  tenantIsolation: 'TENANT_ISOLATION_MODE',
  fhirAudience: 'FHIR_AUDIENCE_ENFORCEMENT',
} as const

export type AccessPostureKey = keyof typeof ACCESS_POSTURE_SETTINGS

export type AccessPosture = Record<AccessPostureKey, EnforcementMode>

/** One key of a posture document; throws naming `source` and the key when it is not a mode. */
export function accessPostureMode(posture: Readonly<Record<string, unknown>>, key: AccessPostureKey, source = 'access posture'): EnforcementMode {
  return requireEnforcementMode(posture[key], `${source}: ${key}`)
}

export function parseAccessPosture(value: unknown, source = 'access posture'): AccessPosture {
  const posture = requireRecord(value, source)
  const mode = (key: AccessPostureKey): EnforcementMode => accessPostureMode(posture, key, source)
  return {
    consent: mode('consent'),
    scopeEnforcement: mode('scopeEnforcement'),
    roleBasedFiltering: mode('roleBasedFiltering'),
    tenantIsolation: mode('tenantIsolation'),
    fhirAudience: mode('fhirAudience'),
  }
}
