// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyEnv, overrideEnv } from './helpers/test-env'

const ENV_SERVER = 'http://hapi-fhir:8080/fhir'
const dataDir = mkdtempSync(join(tmpdir(), 'fhir-server-identity-persisted-'))
const savedEnv = overrideEnv({ DATA_DIR: dataDir, FHIR_SERVER_BASE: ENV_SERVER })

writeFileSync(join(dataDir, 'fhir-servers.json'), JSON.stringify({
  servers: { 'hapi-fhir-server': { url: `${ENV_SERVER}/`, strictCapabilities: true } },
}))

const UNKNOWN = 'Unknown FHIR Server'

mock.module('@/lib/fhir-utils', () => ({
  UNKNOWN_SERVER_NAME: UNKNOWN,
  getFHIRServerInfo: async () => ({ fhirVersion: 'Unknown', serverName: UNKNOWN, supported: false }),
  getServerIdentifier: () => 'hapi-fhir',
  clearMetadataCache: () => {},
}))

const store = await import('../src/lib/fhir-server-store')

afterAll(() => {
  applyEnv(savedEnv)
  rmSync(dataDir, { recursive: true, force: true })
})

describe('an env-configured FHIR server with saved settings', () => {
  it('keeps the id its settings were saved under even when the upstream is down at startup', async () => {
    const servers = await store.getAllServers()
    expect(servers.map((s) => s.identifier)).toEqual(['hapi-fhir-server'])
    expect(servers[0]).toMatchObject({ url: ENV_SERVER, strictCapabilities: true })
  })
})
