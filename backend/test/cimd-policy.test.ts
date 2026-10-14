// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import type ClientProfileRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientProfileRepresentation.js'
import type ClientPolicyRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientPolicyRepresentation.js'
import { applyCimdPolicy, readCimdStatus, syncCimdResourceAllowList, type CimdPolicyAdmin } from '../src/lib/cimd-policy'
import { isRecord } from '../src/lib/type-guards'

const ALLOW_LIST = 'cimd-resource-indicator-allow-list'
const FHIR = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'
const MCP = 'https://proxy.example.com/mcp'

function fakePolicyAdmin(profiles: ClientProfileRepresentation[] = [], policies: ClientPolicyRepresentation[] = []) {
  const state = { profiles, policies, profileWrites: 0 }
  const admin: CimdPolicyAdmin = {
    clientPolicies: {
      listProfiles: async () => ({ profiles: state.profiles }),
      listPolicies: async () => ({ policies: state.policies }),
      createProfiles: async (rep) => { state.profileWrites += 1; state.profiles = rep?.profiles ?? [] },
      updatePolicy: async (rep) => { state.policies = rep?.policies ?? [] },
    },
  }
  return { admin, state }
}

function executorConfig(state: { profiles: ClientProfileRepresentation[] }): Record<string, unknown> | undefined {
  const config = state.profiles[0]?.executors?.find((e) => e.executor === 'client-id-metadata-document')?.configuration
  return isRecord(config) ? config : undefined
}

describe('CIMD resource-indicator allow list (Keycloak 26.8 rejects an unlisted resource)', () => {
  it('writes the allow list with the policy', async () => {
    const { admin, state } = fakePolicyAdmin()
    await applyCimdPolicy(admin, { trustedDomains: ['claude.ai'], resourceAllowList: [FHIR, MCP] })
    expect(executorConfig(state)?.[ALLOW_LIST]).toEqual([MCP, FHIR])
  })

  it('syncs the list into an existing profile and keeps its other settings', async () => {
    const { admin, state } = fakePolicyAdmin()
    await applyCimdPolicy(admin, { trustedDomains: ['claude.ai'], allowHttpScheme: true })

    expect(await syncCimdResourceAllowList(admin, [MCP, FHIR])).toBe(true)
    expect(executorConfig(state)?.[ALLOW_LIST]).toEqual([MCP, FHIR])
    expect(executorConfig(state)?.['cimd-allow-http-scheme']).toBe(true)
    expect(executorConfig(state)?.['cimd-allow-permitted-domains']).toEqual(['claude.ai'])
  })

  it('leaves an up-to-date profile unwritten', async () => {
    const { admin, state } = fakePolicyAdmin()
    await applyCimdPolicy(admin, { trustedDomains: ['claude.ai'], resourceAllowList: [FHIR, MCP] })
    const writes = state.profileWrites

    expect(await syncCimdResourceAllowList(admin, [MCP, FHIR])).toBe(false)
    expect(state.profileWrites).toBe(writes)
  })

  it('does nothing where CIMD is not configured', async () => {
    const { admin, state } = fakePolicyAdmin()
    expect(await syncCimdResourceAllowList(admin, [FHIR])).toBe(false)
    expect(state.profileWrites).toBe(0)
  })

  it('reports the list in the status', async () => {
    const { admin } = fakePolicyAdmin()
    await applyCimdPolicy(admin, { trustedDomains: ['claude.ai'], resourceAllowList: [FHIR] })
    expect((await readCimdStatus(admin)).resourceAllowList).toEqual([FHIR])
  })
})
