// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyEnv, overrideEnv } from './helpers/test-env'

const ENV_SERVER = 'http://hapi.test/fhir'
const LEGACY_SERVER = 'http://legacy.test/fhir'
const MOVED_SERVER = 'http://hapi-moved.test/fhir'
const dataDir = mkdtempSync(join(tmpdir(), 'fhir-server-names-'))
const savedEnv = overrideEnv({ DATA_DIR: dataDir, FHIR_SERVER_BASE: ENV_SERVER })

writeFileSync(join(dataDir, 'fhir-servers.json'), JSON.stringify({
  servers: {
    hapi: { url: ENV_SERVER, name: 'Clinical records' },
    legacy: { url: LEGACY_SERVER, name: 'HAPI FHIR' },
  },
}))

mock.module('@/lib/fhir-utils', () => ({
  UNKNOWN_SERVER_NAME: 'Unknown FHIR Server',
  getFHIRServerInfo: async () => ({ fhirVersion: 'R4', serverName: 'HAPI FHIR', serverVersion: '8.6.5', supported: true }),
  getServerIdentifier: () => 'hapi',
  clearMetadataCache: () => {},
}))

const store = await import('../src/lib/fhir-server-store')

afterAll(() => {
  applyEnv(savedEnv)
  rmSync(dataDir, { recursive: true, force: true })
})

function persisted(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, 'fhir-servers.json'), 'utf-8')).servers[id]
}

describe('FHIR server names', () => {
  it('keep the name an admin chose when the server metadata is refreshed', async () => {
    const refreshed = await store.refreshServer('hapi')
    expect(refreshed.name).toBe('Clinical records')
    expect(store.publicServerName(refreshed)).toBe('Clinical records')
  })

  it('treat a stored copy of the software name as no choice at all', async () => {
    const legacy = await store.getServerInfoByName('legacy')
    if (!legacy) throw new Error('the persisted legacy server did not load')
    expect(legacy.name).toBe('HAPI FHIR')
    expect(store.publicServerName(legacy)).toBe(store.DEFAULT_PUBLIC_SERVER_NAME)

    await store.setStrictCapabilities('legacy', true)
    expect(persisted('legacy')).toEqual({ url: LEGACY_SERVER, strictCapabilities: true })
  })

  it('fall back to the software name, never to the public one, when a URL edit names nothing', async () => {
    const moved = await store.updateServer('hapi', MOVED_SERVER)
    expect(moved.name).toBe('HAPI FHIR')
    expect(store.publicServerName(moved)).toBe(store.DEFAULT_PUBLIC_SERVER_NAME)
    expect(persisted('hapi').name).toBeUndefined()
  })
})
