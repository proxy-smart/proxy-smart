// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyEnv, overrideEnv } from './helpers/test-env'

const ENV_SERVER = 'http://hapi.test/fhir'
const MOVED_SERVER = 'http://hapi-moved.test/fhir'
const dataDir = mkdtempSync(join(tmpdir(), 'fhir-server-store-'))
const savedEnv = overrideEnv({ DATA_DIR: dataDir, FHIR_SERVER_BASE: ENV_SERVER })

writeFileSync(join(dataDir, 'fhir-servers.json'), JSON.stringify({
  servers: { hapi: { url: ENV_SERVER, name: 'Renamed HAPI', strictCapabilities: true, mcpEnabled: true, organizationIds: ['org-1'] } },
}))

mock.module('@/lib/fhir-utils', () => ({
  getFHIRServerInfo: async () => ({ fhirVersion: 'R4', serverName: 'HAPI FHIR', supported: true }),
  getServerIdentifier: () => 'hapi',
  clearMetadataCache: () => {},
}))

const store = await import('../src/lib/fhir-server-store')

afterAll(() => {
  applyEnv(savedEnv)
  rmSync(dataDir, { recursive: true, force: true })
})

function persisted(): unknown {
  return JSON.parse(readFileSync(join(dataDir, 'fhir-servers.json'), 'utf-8')).servers.hapi
}

describe('settings an admin saved on an env-configured FHIR server', () => {
  it('survive a restart and a later URL edit', async () => {
    const restored = await store.getServerInfoByName('hapi')
    expect(restored).toMatchObject({ name: 'Renamed HAPI', strictCapabilities: true, mcpEnabled: true, organizationIds: ['org-1'] })

    const moved = await store.updateServer('hapi', MOVED_SERVER, 'Moved HAPI', ['org-1'])
    expect(moved).toMatchObject({ url: MOVED_SERVER, strictCapabilities: true, mcpEnabled: true })
    expect(persisted()).toMatchObject({ url: MOVED_SERVER, strictCapabilities: true, mcpEnabled: true })
  })
})
