// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, test } from 'bun:test'
import { ACCESS_POSTURE_SETTINGS, ENFORCEMENT_MODES, accessPostureMode, isEnforcementMode, parseAccessPosture, requireEnforcementMode } from './posture'

const POSTURE = {
  consent: 'enforce',
  scopeEnforcement: 'enforce',
  roleBasedFiltering: 'audit-only',
  tenantIsolation: 'disabled',
  fhirAudience: 'enforce',
}

describe('enforcement modes', () => {
  test('isEnforcementMode accepts exactly the listed modes', () => {
    for (const mode of ENFORCEMENT_MODES) expect(isEnforcementMode(mode)).toBe(true)
    for (const value of ['Enforce', 'audit', '', null, 1]) expect(isEnforcementMode(value)).toBe(false)
  })

  test('requireEnforcementMode returns a mode and throws naming the value otherwise', () => {
    expect(requireEnforcementMode('disabled', 'mode')).toBe('disabled')
    expect(() => requireEnforcementMode('off', 'CONSENT_MODE')).toThrow('CONSENT_MODE')
  })
})

describe('accessPostureMode', () => {
  test('reads one key without requiring the others', () => {
    expect(accessPostureMode({ roleBasedFiltering: 'audit-only' }, 'roleBasedFiltering')).toBe('audit-only')
    expect(() => accessPostureMode({}, 'consent', 'release posture')).toThrow('release posture: consent')
  })
})

describe('parseAccessPosture', () => {
  test('returns every posture key and drops unknown ones', () => {
    expect(parseAccessPosture({ ...POSTURE, extra: 'ignored' })).toEqual({
      consent: 'enforce',
      scopeEnforcement: 'enforce',
      roleBasedFiltering: 'audit-only',
      tenantIsolation: 'disabled',
      fhirAudience: 'enforce',
    })
  })

  test('covers exactly the keys that have a setting', () => {
    expect(Object.keys(parseAccessPosture(POSTURE)).sort()).toEqual(Object.keys(ACCESS_POSTURE_SETTINGS).sort())
  })

  test('throws naming the source and the key', () => {
    expect(() => parseAccessPosture({ ...POSTURE, fhirAudience: 'off' }, 'access-posture.json')).toThrow('access-posture.json: fhirAudience')
    const { tenantIsolation, ...missing } = POSTURE
    expect(tenantIsolation).toBe('disabled')
    expect(() => parseAccessPosture(missing)).toThrow('access posture: tenantIsolation')
    expect(() => parseAccessPosture(['enforce'])).toThrow('access posture')
  })
})
