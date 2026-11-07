// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it, mock } from 'bun:test'

const HAPI = {
  identifier: 'hapi',
  name: 'HAPI FHIR',
  url: 'http://hapi-fhir:8080/fhir',
  metadata: { fhirVersion: 'R4', serverName: 'HAPI FHIR', serverVersion: '8.6.5', supported: true },
  lastUpdated: 0,
}

mock.module('@/lib/auth', () => ({ validateAdminToken: async () => ({ sub: 'admin' }) }))
mock.module('@/lib/fhir-server-store', () => ({
  DEFAULT_PUBLIC_SERVER_NAME: 'FHIR Server',
  publicServerName: () => 'FHIR Server',
  ensureServersInitialized: async () => {},
  retryUnknownServers: async () => {},
  getAllServers: async () => [HAPI],
  getServerInfoByName: async (name: string) => (name === 'hapi' ? HAPI : null),
  fhirResourceUrlFor: () => 'http://localhost/proxy-smart-backend/hapi/R4',
  addServer: mock(async () => null),
  updateServer: mock(async () => null),
  deleteServer: mock(async () => {}),
  refreshServer: mock(async () => null),
  setStrictCapabilities: mock(async () => null),
  setMcpEnabled: mock(async () => null),
}))

const { fhirServersAdminRoutes } = await import('../src/routes/fhir-servers/admin')

const get = (path: string) =>
  fhirServersAdminRoutes.handle(new Request(`http://localhost${path}`, { headers: { authorization: 'Bearer admin-token' } }))

describe('GET /admin/fhir-servers', () => {
  it('gives an admin the upstream address, software and public name of every server', async () => {
    const res = await get('/fhir-servers')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalServers).toBe(1)
    expect(body.servers[0]).toMatchObject({
      id: 'hapi', url: HAPI.url, serverName: 'HAPI FHIR', serverVersion: '8.6.5', publicName: 'FHIR Server',
    })
  })

  it('gives an admin one server in the same shape, and 404 for an unknown one', async () => {
    const res = await get('/fhir-servers/hapi')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: HAPI.url, serverVersion: '8.6.5', publicName: 'FHIR Server' })
    expect((await get('/fhir-servers/nope')).status).toBe(404)
  })
})
