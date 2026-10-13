// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, spyOn } from 'bun:test'
import * as clientConfigModule from '../src/lib/smart-client-config-cache'
import { authorizeFhirRequest, type FhirTarget } from '../src/lib/fhir-request-pipeline'
import { enforceClientServerAccess, type ServerAccessDeps } from '../src/lib/client-server-access'
import { parseServerAccess, type ServerAccess } from '../src/lib/smart-client-enrichment'
import { parseFhirPersons } from '../src/lib/fhir-person-associations'

const SERVER = { identifier: 'hapi-a', name: 'HAPI A' }

function deps(access: ServerAccess | null, personServers: string[] = []): ServerAccessDeps {
  return {
    clientServerAccess: mock(async () => access),
    userPersonServerIds: mock(async () => personServers),
  }
}

const check = (access: ServerAccess | null, token: Record<string, unknown> = { azp: 'app', sub: 'u1' }, personServers: string[] = []) =>
  enforceClientServerAccess(token, SERVER, deps(access, personServers))

describe('parseServerAccess', () => {
  it('reads the client attributes the admin API writes', () => {
    expect(parseServerAccess({ server_access_type: 'selected-servers', allowed_server_ids: 'hapi-a,hapi-b' }))
      .toEqual({ type: 'selected-servers', allowedServerIds: ['hapi-a', 'hapi-b'] })
    expect(parseServerAccess({ server_access_type: ['user-person-servers'] })).toEqual({ type: 'user-person-servers', allowedServerIds: [] })
    expect(parseServerAccess({ server_access_type: 'bogus' })).toEqual({ type: null, allowedServerIds: [] })
    expect(parseServerAccess(undefined)).toEqual({ type: null, allowedServerIds: [] })
  })
})

describe('parseFhirPersons', () => {
  it('keeps well-formed associations and drops anything else', () => {
    expect(parseFhirPersons('[{"serverId":"hapi-a","personId":"p1"}]')).toEqual([{ serverId: 'hapi-a', personId: 'p1' }])
    expect(parseFhirPersons('[{"serverId":1}]')).toEqual([])
    expect(parseFhirPersons('not json')).toEqual([])
    expect(parseFhirPersons(undefined)).toEqual([])
  })
})

describe('enforceClientServerAccess', () => {
  it('admits a client with no restriction, or no client at all', async () => {
    expect((await check(null)).allowed).toBe(true)
    expect((await check({ type: 'all-servers', allowedServerIds: [] })).allowed).toBe(true)
    expect((await check({ type: null, allowedServerIds: [] })).allowed).toBe(true)
    expect((await check({ type: 'selected-servers', allowedServerIds: [] }, {})).allowed).toBe(true)
  })

  it('holds a selected-servers client to its list', async () => {
    expect((await check({ type: 'selected-servers', allowedServerIds: ['hapi-a'] })).allowed).toBe(true)
    const refused = await check({ type: 'selected-servers', allowedServerIds: ['hapi-b'] })
    expect(refused.allowed).toBe(false)
    expect(refused.status).toBe(403)
    expect(refused.body?.error).toBe('server_not_permitted')
    expect((await check({ type: 'selected-servers', allowedServerIds: [] })).allowed).toBe(false)
  })

  it('treats an allowed-server list without a type as a restriction', async () => {
    expect((await check({ type: null, allowedServerIds: ['hapi-b'] })).allowed).toBe(false)
  })

  it('reads the client from azp, else client_id', async () => {
    const d = deps({ type: 'selected-servers', allowedServerIds: ['hapi-a'] })
    await enforceClientServerAccess({ client_id: 'cid' }, SERVER, d)
    expect(d.clientServerAccess).toHaveBeenCalledWith('cid')
  })

  it('admits a user-person-servers client only where the user has a Person', async () => {
    const access: ServerAccess = { type: 'user-person-servers', allowedServerIds: [] }
    expect((await check(access, { azp: 'app', sub: 'u1' }, ['hapi-a'])).allowed).toBe(true)
    expect((await check(access, { azp: 'app', sub: 'u1' }, ['hapi-b'])).allowed).toBe(false)
    expect((await check(access, { azp: 'app' }, ['hapi-a'])).allowed).toBe(false)
  })

  it('fails closed when the restriction cannot be read', async () => {
    const failing: ServerAccessDeps = {
      clientServerAccess: async () => { throw new Error('Keycloak down') },
      userPersonServerIds: async () => [],
    }
    const result = await enforceClientServerAccess({ azp: 'app' }, SERVER, failing)
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(503)
  })
})

describe('the FHIR request pipeline', () => {
  it.serial('refuses every request of a client restricted to other servers, before it reaches upstream', async () => {
    const spy = spyOn(clientConfigModule, 'getClientServerAccess').mockImplementation(async () => ({ type: 'selected-servers', allowedServerIds: ['hapi-b'] }))
    try {
      const calls: string[] = []
      const target: FhirTarget = {
        serverInfo: { name: 'HAPI A', url: 'https://fhir.example.com', identifier: 'hapi-a', lastUpdated: 0, metadata: { fhirVersion: 'R4', supported: true } },
        serverName: 'hapi-a',
        fhirVersion: 'R4',
        upstreamFetch: async (url) => { calls.push(url); return new Response('{}') },
      }
      const result = await authorizeFhirRequest(target, { tokenPayload: { azp: 'app', scope: 'system/*.rs' }, authHeader: 'Bearer t' }, {
        method: 'GET', resourcePath: 'Observation', queryString: '', headers: new Headers(),
      })
      expect(result.allowed).toBe(false)
      expect(result.allowed ? 0 : result.status).toBe(403)
      expect(spy).toHaveBeenCalledWith('app')
      expect(calls).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
