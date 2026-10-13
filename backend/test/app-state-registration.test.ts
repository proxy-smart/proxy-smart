// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'
import { parseAppStateRegistration } from '../src/lib/app-state/registration'
import { createClientConfigCache } from '../src/lib/smart-client-config-cache'
import { UpdateSmartAppRequest } from '../src/schemas'

const PREFS = 'https://app.example.org|prefs'
const CONFIG = 'https://app.example.org|hospital-config'

describe('app state codes on the SMART app registration', () => {
  it('stores codes as Keycloak string attributes on create', () => {
    const { representation } = buildCreatePlan({
      clientId: 'demo-app',
      name: 'Demo',
      appStateCodes: [PREFS],
      appStateGlobalCodes: [CONFIG],
    })
    const attributes = representation.attributes
    expect(attributes).toMatchObject({
      app_state_codes: JSON.stringify([PREFS]),
      app_state_global_codes: JSON.stringify([CONFIG]),
    })
  })

  it('writes, clears and preserves codes on update', () => {
    const existing = { clientId: 'demo-app', attributes: { app_state_codes: JSON.stringify([PREFS]) } }
    expect(buildUpdateRepresentation({ appStateCodes: [CONFIG] }, existing).attributes?.app_state_codes).toBe(JSON.stringify([CONFIG]))
    expect(buildUpdateRepresentation({ appStateCodes: [] }, existing).attributes?.app_state_codes).toBe('')
    expect(buildUpdateRepresentation({ name: 'x' }, existing).attributes?.app_state_codes).toBe(JSON.stringify([PREFS]))
  })

  it('reads the registration back, tolerating absent and malformed attributes', () => {
    const registration = parseAppStateRegistration({
      app_state_codes: JSON.stringify([PREFS]),
      app_state_global_codes: JSON.stringify([CONFIG]),
    })
    expect([...registration.codes]).toEqual([PREFS])
    expect([...registration.globalCodes]).toEqual([CONFIG])
    expect(parseAppStateRegistration(undefined).codes.size).toBe(0)
    expect(parseAppStateRegistration({ app_state_codes: 'not json' }).codes.size).toBe(0)
    expect(parseAppStateRegistration({ app_state_codes: JSON.stringify(['no-separator', 3]) }).codes.size).toBe(0)
  })

  it('only accepts system|code values through the admin API', () => {
    expect(Value.Check(UpdateSmartAppRequest, { appStateCodes: [PREFS] })).toBe(true)
    expect(Value.Check(UpdateSmartAppRequest, { appStateCodes: ['prefs'] })).toBe(false)
  })
})

describe('getAppStateRegistration', () => {
  it('returns the registered codes for a known client', async () => {
    const cache = createClientConfigCache(async () => ({
      status: 'found',
      config: { redirectUris: [], appState: parseAppStateRegistration({ app_state_codes: JSON.stringify([PREFS]) }) },
    }))
    expect([...(await cache.getAppStateRegistration('demo-app')).codes]).toEqual([PREFS])
  })

  it('returns no codes for an unknown client', async () => {
    const cache = createClientConfigCache(async () => ({ status: 'absent' }))
    expect((await cache.getAppStateRegistration('nobody')).codes.size).toBe(0)
  })

  it('throws when Keycloak cannot be asked, instead of answering with no codes', async () => {
    const cache = createClientConfigCache(async () => ({ status: 'unavailable', reason: 'down' }))
    await expect(cache.getAppStateRegistration('demo-app')).rejects.toThrow('down')
  })
})
