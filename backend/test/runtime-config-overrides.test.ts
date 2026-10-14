// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import posture from '../src/lib/access-posture.json'
import { ENFORCEMENT_DEFAULTS } from '../src/lib/enforcement-mode'
import {
  changedFrom,
  getRuntimeAccessControlConfig,
  getRuntimeConsentConfig,
  saveAccessControlConfig,
  saveConsentConfig,
} from '../src/lib/runtime-config'
import { useTestEnv } from './helpers/test-env'

function fakeRealmAdmin(attributes: Record<string, string>) {
  const realm = { attributes: { ...attributes } }
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  admin.realms.findOne = async () => realm
  admin.realms.update = async (_query, rep) => { realm.attributes = { ...(rep.attributes ?? {}) } }
  return { admin, realm }
}

describe('access posture', () => {
  it('is the source of the enforcement defaults', () => {
    expect(posture.consent).toBe(ENFORCEMENT_DEFAULTS.consent)
    expect(posture.roleBasedFiltering).toBe(ENFORCEMENT_DEFAULTS.roleBasedFiltering)
    expect(posture.fhirAudience).toBe(ENFORCEMENT_DEFAULTS.fhirAudience)
    expect(posture.scopeEnforcement).toBe(ENFORCEMENT_DEFAULTS.scopeEnforcement)
  })

  it('keeps only the fields that differ', () => {
    expect(changedFrom({ a: 1, b: ['x'] }, { a: 1, b: ['y'] }, ['a', 'b'])).toEqual({ b: ['x'] })
  })
})

describe('saved settings store only what differs from the defaults', () => {
  useTestEnv()

  it.serial('saves an exemption without pinning the consent mode', async () => {
    const { admin, realm } = fakeRealmAdmin({ 'consent_settings.mode': 'audit-only', other: 'kept' })
    await saveConsentConfig(admin, { ...getRuntimeConsentConfig(), mode: ENFORCEMENT_DEFAULTS.consent, exemptClients: ['patient-portal'] })

    expect(realm.attributes).toEqual({ other: 'kept', 'consent_settings.exempt_clients': 'patient-portal' })
    expect(getRuntimeConsentConfig().mode).toBe(ENFORCEMENT_DEFAULTS.consent)
    expect(getRuntimeConsentConfig().exemptClients).toEqual(['patient-portal'])
  })

  it.serial('drops a saved mode once it is set back to the default', async () => {
    const { admin, realm } = fakeRealmAdmin({})
    await saveAccessControlConfig(admin, { ...getRuntimeAccessControlConfig(), roleBasedFiltering: 'audit-only' })
    expect(realm.attributes['access_control.role_based_filtering']).toBe('audit-only')

    await saveAccessControlConfig(admin, { ...getRuntimeAccessControlConfig(), roleBasedFiltering: ENFORCEMENT_DEFAULTS.roleBasedFiltering })
    expect(realm.attributes).toEqual({})
    expect(getRuntimeAccessControlConfig().roleBasedFiltering).toBe(ENFORCEMENT_DEFAULTS.roleBasedFiltering)
  })
})
