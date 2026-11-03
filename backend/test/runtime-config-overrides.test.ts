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
  getRuntimeIalConfig,
  saveAccessControlConfig,
  saveConsentConfig,
  saveIalConfig,
} from '../src/lib/runtime-config'
import { BASE_TEST_ENV, useTestEnv } from './helpers/test-env'

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

describe('the consent app as a SMART app', () => {
  useTestEnv()

  it.serial('keeps the chosen app through a save that does not send it', async () => {
    const { admin, realm } = fakeRealmAdmin({})
    await saveConsentConfig(admin, { ...getRuntimeConsentConfig(), appClientId: 'consent-app' })

    const { appClientId: _omitted, ...withoutApp } = getRuntimeConsentConfig()
    await saveConsentConfig(admin, { ...withoutApp, cacheTtl: 1234 })

    expect(realm.attributes['consent_settings.app_client_id']).toBe('consent-app')
    expect(getRuntimeConsentConfig().appClientId).toBe('consent-app')
  })
})

const ONBOARDING = 'https://portal.example.org/onboarding'
const ENV_ONBOARDING = 'https://env.example.org/join'

describe('patient onboarding URL', () => {
  useTestEnv({ ...BASE_TEST_ENV, PATIENT_ONBOARDING_URL: undefined })

  it.serial('is saved as an IAL setting and served at runtime', async () => {
    const { admin, realm } = fakeRealmAdmin({})
    await saveIalConfig(admin, { ...getRuntimeIalConfig(), onboardingUrl: ONBOARDING })

    expect(realm.attributes).toEqual({ 'ial_settings.onboarding_url': ONBOARDING })
    expect(getRuntimeIalConfig().onboardingUrl).toBe(ONBOARDING)
  })

  it.serial('survives a save from a client that does not send it', async () => {
    const { admin, realm } = fakeRealmAdmin({})
    await saveIalConfig(admin, { ...getRuntimeIalConfig(), onboardingUrl: ONBOARDING })

    const { onboardingUrl: _omitted, ...withoutUrl } = getRuntimeIalConfig()
    await saveIalConfig(admin, { ...withoutUrl, verifyPatientLink: false })

    expect(realm.attributes['ial_settings.onboarding_url']).toBe(ONBOARDING)
    expect(getRuntimeIalConfig().onboardingUrl).toBe(ONBOARDING)
  })
})

describe('patient onboarding URL with PATIENT_ONBOARDING_URL set', () => {
  useTestEnv({ ...BASE_TEST_ENV, PATIENT_ONBOARDING_URL: ENV_ONBOARDING })

  it.serial('defaults to the env var and can be switched off from the admin UI', async () => {
    const { admin, realm } = fakeRealmAdmin({})
    await saveIalConfig(admin, { ...getRuntimeIalConfig(), onboardingUrl: null })
    expect(getRuntimeIalConfig().onboardingUrl).toBeNull()

    await saveIalConfig(admin, { ...getRuntimeIalConfig(), onboardingUrl: ENV_ONBOARDING })
    expect(realm.attributes['ial_settings.onboarding_url']).toBeUndefined()
    expect(getRuntimeIalConfig().onboardingUrl).toBe(ENV_ONBOARDING)
  })
})
