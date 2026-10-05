// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Role-based filtering for user-level grants: a member whose fhirUser is a Person is confined to
 * the Patient their Person links to, and a user-level grant with no identity to confine it to
 * reaches no patient data. Practitioners and system grants are unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

const personLinks: Record<string, { Patient?: string; Practitioner?: string }> = {}

mock.module('../src/lib/consent/person-resolver', () => ({
  resolveFhirUserForClient: async (fhirUser: string, patientFacing: boolean | undefined) => {
    const id = fhirUser.match(/Person\/([^/]+)/)?.[1]
    if (!id) return undefined
    return patientFacing ? personLinks[id]?.Patient : personLinks[id]?.Practitioner
  },
}))

const { enforceRoleBasedFiltering } = await import('../src/lib/smart-access-control')
type Ctx = Parameters<typeof enforceRoleBasedFiltering>[0]

function ctx(tokenPayload: Record<string, unknown>, resourcePath = 'ImagingStudy'): Ctx {
  return {
    tokenPayload,
    resourcePath,
    method: 'GET',
    serverUrl: 'https://fhir.example.com',
    serverId: 'test-server',
    serverName: 'test-fhir',
    authHeader: 'Bearer test-token',
    upstreamFetch: mock(() => Promise.resolve(new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] })))),
  }
}

describe('user-level grants under role-based filtering', () => {
  beforeEach(() => {
    process.env.ROLE_BASED_FILTERING_MODE = 'enforce'
    for (const key of Object.keys(personLinks)) delete personLinks[key]
  })
  afterEach(() => { delete process.env.ROLE_BASED_FILTERING_MODE })

  it('confines a Person to the Patient it links to', async () => {
    personLinks['member-1'] = { Patient: 'Patient/own-record' }
    const result = await enforceRoleBasedFiltering(ctx({ scope: 'openid user/*.rs', fhirUser: 'Person/member-1' }), '?_count=100')
    expect(result.allowed).toBe(true)
    expect(result.modifiedQueryString).toContain('patient=Patient/own-record')
  })

  it('refuses patient data to a Person linked to no Patient', async () => {
    personLinks['member-2'] = {}
    const result = await enforceRoleBasedFiltering(ctx({ scope: 'openid user/*.rs', fhirUser: 'Person/member-2' }), '?_count=100')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('lets a Person linked to a Practitioner through, like a Practitioner', async () => {
    personLinks['clinician'] = { Practitioner: 'Practitioner/dr-who' }
    const result = await enforceRoleBasedFiltering(ctx({ scope: 'openid user/*.rs', fhirUser: 'Person/clinician' }), '?_count=100')
    expect(result.allowed).toBe(true)
    expect(result.modifiedQueryString).toBe('?_count=100')
  })

  it('refuses patient data to a user-level grant with no fhirUser', async () => {
    const result = await enforceRoleBasedFiltering(ctx({ scope: 'openid user/*.rs' }), '?_count=100')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('leaves system grants unfiltered', async () => {
    const result = await enforceRoleBasedFiltering(ctx({ scope: 'system/*.rs' }), '?_count=100')
    expect(result.allowed).toBe(true)
    expect(result.modifiedQueryString).toBe('?_count=100')
  })

  it('confines a patient-scoped token whose launch context is gone to the Patient its Person links to', async () => {
    personLinks['member-4'] = { Patient: 'Patient/own-record' }
    const token = { scope: 'openid fhirUser patient/*.rs', fhirUser: 'Person/member-4', jti: 'lost-after-restart' }
    const search = await enforceRoleBasedFiltering(ctx(token), '?_count=100')
    expect(search.allowed).toBe(true)
    expect(search.modifiedQueryString).toContain('patient=Patient/own-record')
    expect((await enforceRoleBasedFiltering(ctx(token, 'Patient/someone-else'), '')).allowed).toBe(false)
  })

  it('still refuses a patient-scoped token when its Person links to no Patient', async () => {
    personLinks['member-5'] = {}
    const token = { scope: 'openid fhirUser patient/*.rs', fhirUser: 'Person/member-5' }
    const result = await enforceRoleBasedFiltering(ctx(token), '?_count=100')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
  })

  it('lets an unlinked Person read its own Person, which linking a record needs, and nothing else', async () => {
    personLinks['member-3'] = {}
    const token = { scope: 'openid user/*.rs', fhirUser: 'Person/member-3' }
    expect((await enforceRoleBasedFiltering(ctx(token, 'Person/member-3'), '')).allowed).toBe(true)
    expect((await enforceRoleBasedFiltering(ctx(token, 'Person/someone-else'), '')).allowed).toBe(false)
    expect((await enforceRoleBasedFiltering(ctx(token, 'DocumentReference'), '')).allowed).toBe(false)
  })
})
