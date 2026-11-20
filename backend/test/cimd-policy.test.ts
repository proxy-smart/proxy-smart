// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type ClientPolicyRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientPolicyRepresentation.js'
import {
  adoptKeycloakCimdPolicy,
  cimdStatus,
  isTrustedCimdHost,
  readCimdTrustedDomains,
  retireKeycloakCimdPolicy,
  writeCimdTrustedDomains,
} from '../src/lib/cimd-policy'
import { fakeKcAdmin } from './helpers/keycloak-admin'
import { useTestEnv } from './helpers/test-env'

useTestEnv()

const keycloakCimdPolicy = (domains: string[], enabled = true): ClientPolicyRepresentation => ({
  name: 'cimd-policy',
  enabled,
  conditions: [{ condition: 'client-id-uri', configuration: { 'client-id-uri-allow-permitted-domains': domains } }],
  profiles: ['cimd-profile'],
})
const OTHER_POLICY: ClientPolicyRepresentation = { name: 'fapi', enabled: true, conditions: [{ condition: 'any-client' }] }

describe('CIMD trusted domains', () => {
  it('reads never-configured as undefined, so a first start can adopt Keycloak\'s list', async () => {
    expect(await readCimdTrustedDomains(fakeKcAdmin().admin)).toBeUndefined()
  })

  it('stores a normalised list and keeps the realm\'s other attributes', async () => {
    const fake = fakeKcAdmin({ realmAttributes: { 'client_registration.enabled': 'true' } })
    expect(await writeCimdTrustedDomains(fake.admin, [' Claude.ai ', 'vscode.dev', 'claude.ai'])).toEqual(['claude.ai', 'vscode.dev'])
    expect(await readCimdTrustedDomains(fake.admin)).toEqual(['claude.ai', 'vscode.dev'])
    expect(fake.realmAttributes['client_registration.enabled']).toBe('true')
  })

  it('keeps an emptied list as configured, which disables CIMD', async () => {
    const fake = fakeKcAdmin()
    await writeCimdTrustedDomains(fake.admin, [])
    expect(await readCimdTrustedDomains(fake.admin)).toEqual([])
    expect(cimdStatus([])).toEqual({ enabled: false, trustedDomains: [] })
  })

  it('trusts a client by the host of its metadata document URL', () => {
    const domains = ['claude.ai', '*.vscode.dev']
    expect(isTrustedCimdHost('https://claude.ai/oauth/mcp-oauth-client-metadata', domains)).toBe(true)
    expect(isTrustedCimdHost('https://insiders.vscode.dev/client.json', domains)).toBe(true)
    expect(isTrustedCimdHost('https://claude.ai.evil.example/client.json', domains)).toBe(false)
    expect(isTrustedCimdHost('not a url', domains)).toBe(false)
  })
})

describe('handing CIMD over from Keycloak', () => {
  it('disables only Keycloak\'s CIMD policy, which refuses the proxy callback', async () => {
    const fake = fakeKcAdmin({ policies: [keycloakCimdPolicy(['claude.ai', 'vscode.dev']), OTHER_POLICY] })

    expect(await retireKeycloakCimdPolicy(fake.admin)).toEqual(['claude.ai', 'vscode.dev'])
    expect(fake.policies.map((policy) => [policy.name, policy.enabled])).toEqual([['cimd-policy', false], ['fapi', true]])
  })

  it('leaves the policies alone when no CIMD policy is active', async () => {
    const fake = fakeKcAdmin({ policies: [keycloakCimdPolicy(['claude.ai'], false), OTHER_POLICY] })
    const before = fake.policies

    expect(await retireKeycloakCimdPolicy(fake.admin)).toBeNull()
    expect(fake.policies).toBe(before)
  })

  it('adopts the domains Keycloak trusted when the proxy has none yet', async () => {
    const fake = fakeKcAdmin({ policies: [keycloakCimdPolicy(['claude.ai', 'vscode.dev'])] })
    await adoptKeycloakCimdPolicy(fake.admin)
    expect(await readCimdTrustedDomains(fake.admin)).toEqual(['claude.ai', 'vscode.dev'])
  })

  it('never overrides domains an operator already set on the proxy', async () => {
    const fake = fakeKcAdmin({ policies: [keycloakCimdPolicy(['claude.ai'])], realmAttributes: { 'cimd.trusted_domains': '' } })
    await adoptKeycloakCimdPolicy(fake.admin)
    expect(await readCimdTrustedDomains(fake.admin)).toEqual([])
    expect(fake.policies[0]?.enabled).toBe(false)
  })
})
