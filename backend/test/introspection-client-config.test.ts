// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Tests for ensureIntrospectionClientConfig — relaxes Keycloak 26.6.2+ (CVE-2026-37979)
 * introspection audience enforcement on the proxy's introspection client, so it can
 * introspect SMART tokens whose narrowed `aud` doesn't list it (otherwise every valid
 * token introspects as active:false).
 */
import { describe, it, expect } from 'bun:test'
import { ensureIntrospectionClientConfig } from '../src/lib/kc-system-provisioning'
import { fakeKcAdmin } from './helpers/keycloak-admin'
import { useTestEnv } from './helpers/test-env'

const ATTR = 'allow.token.introspection.without.audience.check'
const ENV_KEY = 'KEYCLOAK_ADMIN_CLIENT_ID'

describe('ensureIntrospectionClientConfig', () => {
  useTestEnv({ [ENV_KEY]: 'admin-service' })

  it('sets the attribute when missing, preserving existing attributes', async () => {
    const { admin, updated } = fakeKcAdmin({ clients: [
      { id: 'uuid-1', clientId: 'admin-service', attributes: { 'access.token.lifespan': '3600' } },
    ] })

    await ensureIntrospectionClientConfig(admin)

    expect(updated).toHaveLength(1)
    const attrs = updated[0].payload.attributes ?? {}
    expect(attrs[ATTR]).toBe('true')
    expect(attrs['access.token.lifespan']).toBe('3600')
  })

  it('is a no-op when the attribute is already set (idempotent)', async () => {
    const { admin, updated } = fakeKcAdmin({ clients: [
      { id: 'uuid-1', clientId: 'admin-service', attributes: { [ATTR]: 'true' } },
    ] })

    await ensureIntrospectionClientConfig(admin)

    expect(updated).toHaveLength(0)
  })

  it('is a no-op when the introspection client does not exist', async () => {
    const { admin, updated } = fakeKcAdmin()

    await ensureIntrospectionClientConfig(admin)

    expect(updated).toHaveLength(0)
  })

  it('does not throw when Keycloak rejects the update', async () => {
    const { admin } = fakeKcAdmin({ clients: [{ id: 'uuid-1', clientId: 'admin-service', attributes: {} }] })
    admin.clients.update = async () => { throw new Error('kc down') }

    await expect(ensureIntrospectionClientConfig(admin)).resolves.toBeUndefined()
  })
})
