// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

export const ENFORCEMENT_MODES = ['enforce', 'audit-only', 'disabled'] as const

export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number]

export const ENFORCEMENT_DEFAULTS = {
  consent: 'audit-only',
  scopeEnforcement: 'enforce',
  roleBasedFiltering: 'audit-only',
  tenantIsolation: 'disabled',
} as const satisfies Record<string, EnforcementMode>

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return ENFORCEMENT_MODES.some(mode => mode === value)
}

export function parseEnforcementMode(value: unknown, fallback: EnforcementMode): EnforcementMode {
  return isEnforcementMode(value) ? value : fallback
}
