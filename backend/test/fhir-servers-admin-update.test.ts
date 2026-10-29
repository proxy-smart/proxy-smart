// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, expect, it, mock } from 'bun:test'

const updateServer = mock(async () => {
  throw new Error('updateServer must not run for a refused request')
})

mock.module('@/lib/auth', () => ({ validateAdminToken: async () => ({ sub: 'admin' }) }))
mock.module('@/lib/fhir-server-store', () => ({
  addServer: mock(async () => null),
  updateServer,
  deleteServer: mock(async () => {}),
  refreshServer: mock(async () => null),
  setStrictCapabilities: mock(async () => null),
  setMcpEnabled: mock(async () => null),
  fhirResourceUrlFor: () => 'http://localhost/fhir/hapi/R4',
  getServerInfoByName: async (name: string) => (name === 'hapi' ? { identifier: 'hapi' } : null),
}))

const { fhirServersAdminRoutes } = await import('../src/routes/fhir-servers/admin')

function put(serverId: string, url: string) {
  return fhirServersAdminRoutes.handle(new Request(`http://localhost/fhir-servers/${serverId}`, {
    method: 'PUT',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  }))
}

describe('PUT /admin/fhir-servers/:server_id', () => {
  it('refuses to repoint a server at an internal address, as adding one does', async () => {
    const res = await put('hapi', 'http://169.254.169.254/latest/meta-data')
    expect(res.status).toBe(400)
    expect(updateServer).not.toHaveBeenCalled()
  })

  it('answers 404 for a server that does not exist instead of creating it', async () => {
    const res = await put('nope', 'https://fhir.example.com/r4')
    expect(res.status).toBe(404)
    expect(updateServer).not.toHaveBeenCalled()
  })
})
