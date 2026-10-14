// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import posture from './access-posture.json'

export const ENFORCEMENT_MODES = ['enforce', 'audit-only', 'disabled'] as const

export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number]

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return ENFORCEMENT_MODES.some(mode => mode === value)
}

function postureMode(value: unknown, name: string): EnforcementMode {
  if (!isEnforcementMode(value)) throw new Error(`access-posture.json: ${name} must be one of ${ENFORCEMENT_MODES.join(', ')}`)
  return value
}

/** The intended posture of every deployment; env vars and saved admin settings only override it. */
export const ENFORCEMENT_DEFAULTS = {
  consent: postureMode(posture.consent, 'consent'),
  scopeEnforcement: postureMode(posture.scopeEnforcement, 'scopeEnforcement'),
  roleBasedFiltering: postureMode(posture.roleBasedFiltering, 'roleBasedFiltering'),
  tenantIsolation: postureMode(posture.tenantIsolation, 'tenantIsolation'),
  fhirAudience: postureMode(posture.fhirAudience, 'fhirAudience'),
} satisfies Record<string, EnforcementMode>

export function parseEnforcementMode(value: unknown, fallback: EnforcementMode): EnforcementMode {
  return isEnforcementMode(value) ? value : fallback
}
