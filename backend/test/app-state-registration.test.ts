// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'
import {
  appStateFields,
  buildAppStateRegistration,
  parseAppStateRegistration,
  type AppStateRegistration,
} from '../src/lib/app-state/registration'
import { createClientConfigCache } from '../src/lib/smart-client-config-cache'
import { UpdateSmartAppRequest } from '../src/schemas'

const PREFS = 'https://app.example.org|prefs'
const CONFIG = 'https://app.example.org|hospital-config'
const KEYS = 'https://app.example.org|keys'

function grants(registration: AppStateRegistration): Record<string, string[]> {
  return {
    patientQuery: [...registration.patient.query],
    patientModify: [...registration.patient.modify],
    userQuery: [...registration.user.query],
    userModify: [...registration.user.modify],
    globalQuery: [...registration.global.query],
    globalModify: [...registration.global.modify],
  }
}

describe('app state codes on the SMART app registration', () => {
  it('stores codes as Keycloak string attributes on create', () => {
    const { representation } = buildCreatePlan({
      clientId: 'demo-app',
      name: 'Demo',
      appStateCodes: [PREFS],
      appStateGlobalCodes: [CONFIG],
      appStatePermissions: { patient: { query: [KEYS] } },
    })
    expect(representation.attributes).toMatchObject({
      app_state_codes: JSON.stringify([PREFS]),
      app_state_global_codes: JSON.stringify([CONFIG]),
      app_state_permissions: JSON.stringify({ patient: { query: [KEYS] } }),
    })
  })

  it('writes, clears and preserves codes on update', () => {
    const existing = { clientId: 'demo-app', attributes: { app_state_codes: JSON.stringify([PREFS]), app_state_permissions: JSON.stringify({ user: { modify: [KEYS] } }) } }
    expect(buildUpdateRepresentation({ appStateCodes: [CONFIG] }, existing).attributes?.app_state_codes).toBe(JSON.stringify([CONFIG]))
    expect(buildUpdateRepresentation({ appStateCodes: [] }, existing).attributes?.app_state_codes).toBe('')
    expect(buildUpdateRepresentation({ name: 'x' }, existing).attributes?.app_state_codes).toBe(JSON.stringify([PREFS]))
    expect(buildUpdateRepresentation({ appStatePermissions: {} }, existing).attributes?.app_state_permissions).toBe('')
    expect(buildUpdateRepresentation({ appStatePermissions: { global: { query: [CONFIG], modify: [] } } }, existing).attributes?.app_state_permissions)
      .toBe(JSON.stringify({ global: { query: [CONFIG] } }))
  })

  it('keeps the meaning of the two legacy lists', () => {
    const registration = parseAppStateRegistration({
      app_state_codes: JSON.stringify([PREFS]),
      app_state_global_codes: JSON.stringify([CONFIG]),
    })
    expect(grants(registration)).toEqual({
      patientQuery: [PREFS, CONFIG],
      patientModify: [PREFS, CONFIG],
      userQuery: [PREFS, CONFIG],
      userModify: [PREFS, CONFIG],
      globalQuery: [PREFS, CONFIG],
      globalModify: [CONFIG],
    })
  })

  it('reads the six per-subject sets and adds them to the legacy lists', () => {
    const registration = parseAppStateRegistration({
      app_state_codes: JSON.stringify([PREFS]),
      app_state_permissions: JSON.stringify({ patient: { query: [KEYS] }, global: { modify: [KEYS, 'bad'] } }),
    })
    expect(grants(registration)).toMatchObject({ patientQuery: [PREFS, KEYS], patientModify: [PREFS], globalModify: [KEYS] })
  })

  it('tolerates absent and malformed attributes', () => {
    const empty = (attrs: Record<string, unknown> | undefined) => Object.values(grants(parseAppStateRegistration(attrs))).every((codes) => codes.length === 0)
    expect(empty(undefined)).toBe(true)
    expect(empty({ app_state_codes: 'not json' })).toBe(true)
    expect(empty({ app_state_codes: JSON.stringify(['no-separator', 3]) })).toBe(true)
    expect(empty({ app_state_permissions: JSON.stringify({ patient: 'x', user: { query: 'y' } }) })).toBe(true)
  })

  it('reports what is stored, not the effective sets, to the admin API', () => {
    expect(appStateFields({
      app_state_codes: JSON.stringify([PREFS]),
      app_state_permissions: JSON.stringify({ patient: { query: [KEYS] } }),
    })).toEqual({ appStateCodes: [PREFS], appStateGlobalCodes: [], appStatePermissions: { patient: { query: [KEYS] } } })
  })

  it('only accepts system|code values through the admin API', () => {
    expect(Value.Check(UpdateSmartAppRequest, { appStateCodes: [PREFS] })).toBe(true)
    expect(Value.Check(UpdateSmartAppRequest, { appStateCodes: ['prefs'] })).toBe(false)
    expect(Value.Check(UpdateSmartAppRequest, { appStatePermissions: { patient: { query: [PREFS] } } })).toBe(true)
    expect(Value.Check(UpdateSmartAppRequest, { appStatePermissions: { patient: { query: ['prefs'] } } })).toBe(false)
    expect(Value.Check(UpdateSmartAppRequest, { appStatePermissions: { encounter: { query: [PREFS] } } })).toBe(false)
  })
})

describe('getAppStateRegistration', () => {
  it('returns the registered codes for a known client', async () => {
    const cache = createClientConfigCache(async () => ({
      status: 'found',
      config: { redirectUris: [], appState: buildAppStateRegistration({ codes: [PREFS] }) },
    }))
    expect([...(await cache.getAppStateRegistration('demo-app')).patient.query]).toEqual([PREFS])
  })

  it('returns no codes for an unknown client', async () => {
    const cache = createClientConfigCache(async () => ({ status: 'absent' }))
    expect((await cache.getAppStateRegistration('nobody')).patient.query.size).toBe(0)
  })

  it('throws when Keycloak cannot be asked, instead of answering with no codes', async () => {
    const cache = createClientConfigCache(async () => ({ status: 'unavailable', reason: 'down' }))
    await expect(cache.getAppStateRegistration('demo-app')).rejects.toThrow('down')
  })
})
