// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Tests for ensureShlExchangeClient — reconciles the SHL token-exchange client's
 * secret in Keycloak from config, so no SHL secret is committed to realm-export
 * and Keycloak never drifts from what the backend authenticates with.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ensureShlExchangeClient } from '../src/lib/kc-system-provisioning'
import { fakeKcAdmin } from './helpers/keycloak-admin'

const ENV_KEY = 'SHL_EXCHANGE_CLIENT_SECRET'
let savedSecret: string | undefined

const EXISTING = { id: 'uuid-1', clientId: 'shl-exchange' }
const namedScopes = (...names: string[]) => names.map((name) => ({ id: `id:${name}`, name }))
const SHL_SCOPES = namedScopes('patient/*.read', 'patient/*.write')

describe('ensureShlExchangeClient', () => {
  beforeEach(() => { savedSecret = process.env[ENV_KEY] })
  afterEach(() => {
    if (savedSecret === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = savedSecret
  })

  it('creates the client with the config secret when it does not exist', async () => {
    process.env[ENV_KEY] = 'strong-secret-123'
    const { admin, created, updated } = fakeKcAdmin({ realmScopes: SHL_SCOPES })

    await ensureShlExchangeClient(admin)

    expect(created).toHaveLength(1)
    expect(updated).toHaveLength(0)
    expect(created[0].clientId).toBe('shl-exchange')
    expect(created[0].secret).toBe('strong-secret-123')
    expect(created[0].serviceAccountsEnabled).toBe(true)
    expect(created[0].publicClient).toBe(false)
    // The SHL proxy requests patient/*.read and the Consent mirror patient/*.write.
    expect(created[0].optionalClientScopes).toEqual(['patient/*.read', 'patient/*.write'])
  })

  it('attaches the patient scopes an existing client is missing', async () => {
    process.env[ENV_KEY] = 'strong-secret-123'
    const kc = fakeKcAdmin({ clients: [EXISTING], realmScopes: SHL_SCOPES })

    await ensureShlExchangeClient(kc.admin)

    expect(kc.optionalScopeNames()).toEqual(['patient/*.read', 'patient/*.write'])
  })

  it('leaves scopes an existing client already has', async () => {
    process.env[ENV_KEY] = 'strong-secret-123'
    const kc = fakeKcAdmin({
      clients: [EXISTING],
      realmScopes: SHL_SCOPES,
      optionalScopes: ['patient/*.read', 'patient/*.write'],
    })

    await ensureShlExchangeClient(kc.admin)

    expect(kc.optionalScopeNames()).toEqual([])
  })

  it('skips a scope the realm does not define, and still attaches the rest', async () => {
    process.env[ENV_KEY] = 'strong-secret-123'
    const kc = fakeKcAdmin({ clients: [EXISTING], realmScopes: namedScopes('patient/*.read') })

    await ensureShlExchangeClient(kc.admin)

    expect(kc.optionalScopeNames()).toEqual(['patient/*.read'])
  })

  it('reconciles the secret on an existing client without recreating it', async () => {
    process.env[ENV_KEY] = 'rotated-secret-456'
    const { admin, created, updated } = fakeKcAdmin({ clients: [EXISTING], realmScopes: SHL_SCOPES })

    await ensureShlExchangeClient(admin)

    expect(created).toHaveLength(0)
    expect(updated).toHaveLength(1)
    expect(updated[0].id).toBe('uuid-1')
    expect(updated[0].payload.secret).toBe('rotated-secret-456')
  })

  it('is a no-op when no secret is configured (SHL disabled)', async () => {
    delete process.env[ENV_KEY]
    const { admin, created, updated } = fakeKcAdmin({ realmScopes: SHL_SCOPES })

    await ensureShlExchangeClient(admin)

    expect(created).toHaveLength(0)
    expect(updated).toHaveLength(0)
  })

  it('does not throw when Keycloak rejects the operation', async () => {
    process.env[ENV_KEY] = 'strong-secret-123'
    const { admin } = fakeKcAdmin()
    admin.clients.find = async () => { throw new Error('kc down') }

    await expect(ensureShlExchangeClient(admin)).resolves.toBeUndefined()
  })
})
