// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { AdminConfigStore, type AdminConfigBackend, type AdminConfigValue } from '../src/lib/admin-config-store'
import {
  adoptLegacyDicomServers,
  getDicomServerById,
  getRuntimeDicomServers,
  loadDicomServers,
  updateDicomServers,
} from '../src/lib/dicom-server-config'
import type { DicomServerConfigType } from '../src/schemas'

class MemoryBackend implements AdminConfigBackend {
  readonly values = new Map<string, AdminConfigValue>()
  async load(key: string): Promise<AdminConfigValue | null> { return this.values.get(key) ?? null }
  async store(key: string, value: AdminConfigValue): Promise<void> { this.values.set(key, value) }
}

class DurableStore extends AdminConfigStore {
  override get persistsDurably(): boolean { return true }
}

const BASIC: DicomServerConfigType = {
  id: 'orthanc-main',
  name: 'Orthanc Main',
  baseUrl: 'http://pacs.internal:8042/dicom-web',
  authType: 'basic',
  username: 'orthanc',
  password: 'stored-password',
  isDefault: true,
}

const HEADER: DicomServerConfigType = {
  id: 'archive',
  name: 'Archive PACS',
  baseUrl: 'http://archive.internal/dicom-web',
  authType: 'header',
  authHeader: 'Bearer stored-token',
}

const ids = (servers: DicomServerConfigType[]) => servers.map(s => s.id)

describe('DICOM server config', () => {
  it('serves what updateDicomServers saved', async () => {
    const store = new AdminConfigStore(new MemoryBackend())
    await updateDicomServers(() => [BASIC, HEADER], store)
    expect(getRuntimeDicomServers(store)).toEqual([BASIC, HEADER])
    expect(getDicomServerById('archive', store)).toEqual(HEADER)
  })

  it('drops the env fallback once a configured server reaches the same PACS', async () => {
    // Prod listed "Default PACS" without credentials next to the real Orthanc entry.
    const placeholder: DicomServerConfigType = { id: 'env-default', name: 'Default PACS', baseUrl: `${BASIC.baseUrl}/`, authType: 'none' }
    const backend = new MemoryBackend()
    backend.values.set('dicom-servers', { servers: [placeholder, BASIC] })
    const store = new AdminConfigStore(backend)
    await loadDicomServers(store)
    expect(ids(getRuntimeDicomServers(store))).toEqual(['orthanc-main'])

    await updateDicomServers(servers => [...servers, HEADER], store)
    expect(ids(getRuntimeDicomServers(store))).toEqual(['orthanc-main', 'archive'])
  })

  it('keeps the env fallback while it is the only way to its PACS', async () => {
    const placeholder: DicomServerConfigType = { id: 'env-default', name: 'Default PACS', baseUrl: 'http://other.internal/dicom-web', authType: 'none' }
    const store = new AdminConfigStore(new MemoryBackend())
    await updateDicomServers(() => [placeholder, BASIC], store)
    expect(ids(getRuntimeDicomServers(store))).toEqual(['env-default', 'orthanc-main'])
  })

  it('drops stored entries that are not valid server configs', async () => {
    const backend = new MemoryBackend()
    backend.values.set('dicom-servers', { servers: [BASIC, { id: 7 }, 'junk'] })
    const store = new AdminConfigStore(backend)
    await loadDicomServers(store)
    expect(ids(getRuntimeDicomServers(store))).toEqual(['orthanc-main'])
  })
})

describe('adoptLegacyDicomServers', () => {
  it('moves the realm attribute into an empty store', async () => {
    const store = new AdminConfigStore(new MemoryBackend())
    await adoptLegacyDicomServers(JSON.stringify([BASIC]), store)
    expect(getRuntimeDicomServers(store)).toEqual([BASIC])
  })

  it('never overwrites servers the store already holds', async () => {
    const store = new AdminConfigStore(new MemoryBackend())
    await updateDicomServers(() => [HEADER], store)
    await adoptLegacyDicomServers(JSON.stringify([BASIC]), store)
    expect(ids(getRuntimeDicomServers(store))).toEqual(['archive'])
  })

  it('allows clearing the realm attribute only when the store persists durably', async () => {
    expect(await adoptLegacyDicomServers(JSON.stringify([BASIC]), new AdminConfigStore(new MemoryBackend()))).toBe(false)
    expect(await adoptLegacyDicomServers(JSON.stringify([BASIC]), new DurableStore(new MemoryBackend()))).toBe(true)
  })

  it('keeps an unreadable attribute in place', async () => {
    const store = new DurableStore(new MemoryBackend())
    expect(await adoptLegacyDicomServers('{not json', store)).toBe(false)
    expect(getRuntimeDicomServers(store)).toEqual([])
  })
})
