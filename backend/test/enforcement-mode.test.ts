// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { parseAssuranceLevel, parseEnforcementMode, parseSecurityFlag, securityEnvErrors } from '../src/lib/enforcement-mode'
import { config } from '../src/config'
import { applyEnv, useTestEnv } from './helpers/test-env'

describe('parseEnforcementMode', () => {
  it('accepts the three modes', () => {
    expect(parseEnforcementMode('enforce', 'disabled')).toBe('enforce')
    expect(parseEnforcementMode('audit-only', 'enforce')).toBe('audit-only')
    expect(parseEnforcementMode('disabled', 'enforce')).toBe('disabled')
  })

  it('uses the default when the value is unset or blank', () => {
    expect(parseEnforcementMode(undefined, 'disabled')).toBe('disabled')
    expect(parseEnforcementMode('', 'audit-only')).toBe('audit-only')
    expect(parseEnforcementMode('  ', 'disabled')).toBe('disabled')
  })

  it('enforces when a value is set but not a mode, whatever the default', () => {
    expect(parseEnforcementMode('ENFORCE', 'disabled')).toBe('enforce')
    expect(parseEnforcementMode('off', 'audit-only')).toBe('enforce')
    expect(parseEnforcementMode('true', 'disabled')).toBe('enforce')
  })
})

describe('parseSecurityFlag', () => {
  it('reads true and false, and the default when unset', () => {
    expect(parseSecurityFlag('true', false)).toBe(true)
    expect(parseSecurityFlag('false', true)).toBe(false)
    expect(parseSecurityFlag(undefined, true)).toBe(true)
    expect(parseSecurityFlag('', false)).toBe(false)
  })

  it('stays on for a value that is neither true nor false', () => {
    expect(parseSecurityFlag('TRUE', false)).toBe(true)
    expect(parseSecurityFlag('0', false)).toBe(true)
    expect(parseSecurityFlag('no', true)).toBe(true)
  })
})

describe('parseAssuranceLevel', () => {
  it('reads a level, the default when unset, and the highest level for anything else', () => {
    expect(parseAssuranceLevel('level2', 'level1')).toBe('level2')
    expect(parseAssuranceLevel(undefined, 'level3')).toBe('level3')
    expect(parseAssuranceLevel('Level3', 'level1')).toBe('level4')
  })
})

describe('securityEnvErrors', () => {
  it('is empty for unset and valid values', () => {
    expect(securityEnvErrors({})).toEqual([])
    expect(securityEnvErrors({
      TENANT_ISOLATION_MODE: 'enforce',
      CONSENT_MODE: 'audit-only',
      SCOPE_ENFORCEMENT_MODE: 'disabled',
      ROLE_BASED_FILTERING_MODE: '',
      FHIR_AUDIENCE_ENFORCEMENT: 'enforce',
      CONSENT_ENABLED: 'false',
    })).toEqual([])
  })

  it('names every security variable set to a value it does not recognise', () => {
    const errors = securityEnvErrors({
      TENANT_ISOLATION_MODE: 'ENFORCE',
      CONSENT_MODE: 'on',
      SCOPE_ENFORCEMENT_MODE: 'strict',
      ROLE_BASED_FILTERING_MODE: 'yes',
      FHIR_AUDIENCE_ENFORCEMENT: 'audit',
      CONSENT_ENABLED: '1',
    })
    expect(errors).toHaveLength(6)
    const tenant = errors.find(error => error.startsWith('TENANT_ISOLATION_MODE'))
    expect(tenant).toContain('"ENFORCE"')
    expect(tenant).toContain('enforce, audit-only, disabled')
    expect(errors.some(error => error.startsWith('CONSENT_ENABLED'))).toBe(true)
  })

  it('checks the identity assurance and query isolation settings too', () => {
    const errors = securityEnvErrors({
      IAL_ENABLED: 'TRUE',
      IAL_MINIMUM_LEVEL: 'Level2',
      IAL_SENSITIVE_MINIMUM_LEVEL: '3',
      IAL_VERIFY_PATIENT_LINK: 'no',
      IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE: 'yes',
      TENANT_QUERY_ISOLATION: 'on',
    })
    expect(errors.map(error => error.split('=')[0]).sort()).toEqual([
      'IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE',
      'IAL_ENABLED',
      'IAL_MINIMUM_LEVEL',
      'IAL_SENSITIVE_MINIMUM_LEVEL',
      'IAL_VERIFY_PATIENT_LINK',
      'TENANT_QUERY_ISOLATION',
    ])
  })
})

describe('security modes read from the environment', () => {
  useTestEnv({
    CONSENT_MODE: undefined,
    SCOPE_ENFORCEMENT_MODE: undefined,
    CONSENT_ENABLED: undefined,
    IAL_ENABLED: undefined,
    IAL_MINIMUM_LEVEL: undefined,
    IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE: undefined,
  })

  it('enforces consent and scopes for unrecognised values', () => {
    applyEnv({ CONSENT_MODE: 'Enforce', SCOPE_ENFORCEMENT_MODE: 'on', CONSENT_ENABLED: 'yes' })
    expect(config.consent.mode).toBe('enforce')
    expect(config.accessControl.scopeEnforcement).toBe('enforce')
    expect(config.consent.enabled).toBe(true)
  })

  it('turns consent off only for the exact string false', () => {
    applyEnv({ CONSENT_ENABLED: 'false' })
    expect(config.consent.enabled).toBe(false)
  })

  it('keeps identity assurance on and strict for unrecognised values', () => {
    applyEnv({ IAL_ENABLED: 'TRUE', IAL_MINIMUM_LEVEL: 'Level2', IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE: 'yes' })
    expect(config.ial.enabled).toBe(true)
    expect(config.ial.minimumLevel).toBe('level4')
    expect(config.ial.allowOnPersonLookupFailure).toBe(false)
  })
})
