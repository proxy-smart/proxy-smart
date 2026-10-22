// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { fakeKcAdmin, mockKcAdminFactory } from './helpers/keycloak-admin'
import type RealmRepresentation from '@keycloak/keycloak-admin-client/lib/defs/realmRepresentation'

process.env.KEYCLOAK_REALM = 'proxy-smart'

const { admin } = fakeKcAdmin()
let realm: RealmRepresentation = {}
const writes: RealmRepresentation[] = []
admin.realms.findOne = async () => realm
admin.realms.update = async (_query, patch) => { writes.push(patch) }
mockKcAdminFactory(async () => admin)

const { ensureKeycloakEventLogging } = await import('@/init/realm-settings')
const { AUTH_EVENT_TYPES, ENABLED_EVENT_TYPES } = await import('@/lib/keycloak-event-types')

const enabled = { eventsEnabled: true, adminEventsEnabled: true, adminEventsDetailsEnabled: true }

describe('ensureKeycloakEventLogging', () => {
  beforeEach(() => { writes.length = 0 })

  it('adds the types a realm with events already on is missing, keeping the ones an operator added', async () => {
    realm = { ...enabled, enabledEventTypes: ['LOGIN', 'VERIFY_EMAIL'] }
    await ensureKeycloakEventLogging()
    expect(writes).toHaveLength(1)
    const types = writes[0]?.enabledEventTypes ?? []
    expect(types).toContain('VERIFY_EMAIL')
    expect(types).toContain('IDENTITY_PROVIDER_FIRST_LOGIN_ERROR')
    expect(new Set(types).size).toBe(types.length)
  })

  it('leaves a realm alone that already records every type', async () => {
    realm = { ...enabled, enabledEventTypes: [...ENABLED_EVENT_TYPES] }
    await ensureKeycloakEventLogging()
    expect(writes).toHaveLength(0)
  })

  it('polls identity-provider sign-ins as auth events', () => {
    expect(AUTH_EVENT_TYPES).toContain('IDENTITY_PROVIDER_LOGIN_ERROR')
  })
})
