// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyEnv, overrideEnv } from './helpers/test-env'

const ENV_SERVER = 'http://hapi-fhir:8080/fhir'
const dataDir = mkdtempSync(join(tmpdir(), 'fhir-server-identity-'))
const savedEnv = overrideEnv({ DATA_DIR: dataDir, FHIR_SERVER_BASE: ENV_SERVER, FHIR_UNKNOWN_SERVER_RETRY_MS: '0' })

let upstreamUp = false
const UNKNOWN = 'Unknown FHIR Server'

mock.module('@/lib/fhir-utils', () => ({
  UNKNOWN_SERVER_NAME: UNKNOWN,
  getFHIRServerInfo: async () => upstreamUp
    ? { fhirVersion: 'R4', serverName: 'HAPI FHIR Server', serverVersion: '8.12.0', supported: true }
    : { fhirVersion: 'Unknown', serverName: UNKNOWN, supported: false },
  getServerIdentifier: (info: { serverName?: string }) => (info.serverName === UNKNOWN ? 'hapi-fhir' : 'hapi-fhir-server'),
  clearMetadataCache: () => {},
}))

const store = await import('../src/lib/fhir-server-store')

afterAll(() => {
  applyEnv(savedEnv)
  rmSync(dataDir, { recursive: true, force: true })
})

describe('an env-configured FHIR server whose upstream was down when the proxy started', () => {
  it('is registered under a placeholder id while the upstream is unreachable', async () => {
    expect((await store.getAllServers()).map((s) => s.identifier)).toEqual(['hapi-fhir'])
    expect(await store.getServerInfoByName('hapi-fhir-server')).toBeNull()
  })

  it('is found under its usual id by the first request after the upstream comes back', async () => {
    upstreamUp = true
    const server = await store.getServerInfoByName('hapi-fhir-server')
    expect(server).toMatchObject({ identifier: 'hapi-fhir-server', url: ENV_SERVER, metadata: { fhirVersion: 'R4' } })
    expect((await store.getAllServers()).map((s) => s.identifier)).toEqual(['hapi-fhir-server'])
    expect(await store.getServerInfoByName('hapi-fhir')).toBeNull()
  })
})
