// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * ensureCimdPolicy — production advertised CIMD without the Keycloak policy that makes a URL
 * client_id work, so every claude.ai connector sign-in ended on "Client not found".
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

interface NamedEntry { name?: string; enabled?: boolean }

let profiles: NamedEntry[] = []
let policies: NamedEntry[] = []
let writes = 0

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => ({
    clientPolicies: {
      listProfiles: async () => ({ profiles: profiles.map(p => ({ ...p, executors: [{ executor: 'client-id-metadata-document', configuration: {} }] })) }),
      listPolicies: async () => ({ policies: policies.map(p => ({ ...p, conditions: [{ condition: 'client-id-uri', configuration: {} }] })) }),
      createProfiles: async () => { writes += 1 },
      updatePolicy: async () => { writes += 1 },
    },
  }),
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

process.env.CIMD_TRUSTED_DOMAINS = 'claude.ai'

const { ensureCimdPolicy } = await import('../src/init/clients')
const { isCimdActive } = await import('../src/lib/cimd-policy')

describe('ensureCimdPolicy', () => {
  beforeEach(() => {
    profiles = []
    policies = []
    writes = 0
  })

  it('creates the policy when the realm has none, and discovery may then advertise CIMD', async () => {
    await ensureCimdPolicy()
    expect(writes).toBe(2)
    expect(isCimdActive()).toBe(true)
  })

  it('leaves an active policy alone', async () => {
    profiles = [{ name: 'cimd-profile' }]
    policies = [{ name: 'cimd-policy', enabled: true }]
    await ensureCimdPolicy()
    expect(writes).toBe(0)
    expect(isCimdActive()).toBe(true)
  })

  it('respects a policy an operator disabled, and stops advertising CIMD', async () => {
    profiles = [{ name: 'cimd-profile' }]
    policies = [{ name: 'cimd-policy', enabled: false }]
    await ensureCimdPolicy()
    expect(writes).toBe(0)
    expect(isCimdActive()).toBe(false)
  })
})
