// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import type { DicomServerConfigType } from '../src/schemas'
import { mergeUpstreamCredentials, redactUpstreamCredentials } from '../src/lib/http-auth'
import * as runtimeConfig from '../src/lib/runtime-config'

const BASIC: DicomServerConfigType = {
  id: 'orthanc-main',
  name: 'Orthanc Main',
  baseUrl: 'http://pacs.internal:8042/dicom-web',
  authType: 'basic',
  username: 'orthanc',
  password: 'stored-password',
  timeoutMs: 30000,
  isDefault: true,
}

const HEADER: DicomServerConfigType = {
  id: 'archive',
  name: 'Archive PACS',
  baseUrl: 'http://archive.internal/dicom-web',
  authType: 'header',
  authHeader: 'Bearer stored-token',
}

const SECRETS = ['stored-password', 'stored-token']

describe('redactUpstreamCredentials', () => {
  it('drops the password and auth header and reports only whether they are set', () => {
    expect(redactUpstreamCredentials(BASIC)).toEqual({
      id: 'orthanc-main',
      name: 'Orthanc Main',
      baseUrl: 'http://pacs.internal:8042/dicom-web',
      authType: 'basic',
      username: 'orthanc',
      timeoutMs: 30000,
      isDefault: true,
      hasPassword: true,
      hasAuthHeader: false,
    })
    expect(redactUpstreamCredentials(HEADER)).toMatchObject({ hasPassword: false, hasAuthHeader: true })
  })
})

describe('mergeUpstreamCredentials', () => {
  it('keeps the stored password when an edit leaves it blank', () => {
    expect(mergeUpstreamCredentials(BASIC, { name: 'Renamed', password: '' })).toEqual({ ...BASIC, name: 'Renamed' })
    expect(mergeUpstreamCredentials(BASIC, { timeoutMs: 5000 }).password).toBe('stored-password')
  })

  it('replaces the stored password when a new one is given', () => {
    expect(mergeUpstreamCredentials(BASIC, { password: 'rotated' }).password).toBe('rotated')
  })

  it('keeps the stored auth header when an edit leaves it blank', () => {
    expect(mergeUpstreamCredentials(HEADER, { authHeader: '' }).authHeader).toBe('Bearer stored-token')
  })

  it('drops credentials the new auth type does not use', () => {
    const toHeader = mergeUpstreamCredentials(BASIC, { authType: 'header', authHeader: 'ApiKey new' })
    expect(toHeader).toMatchObject({ authType: 'header', authHeader: 'ApiKey new' })
    expect(toHeader).not.toHaveProperty('username')
    expect(toHeader).not.toHaveProperty('password')

    const toNone = mergeUpstreamCredentials(HEADER, { authType: 'none' })
    expect(toNone.authType).toBe('none')
    expect(toNone).not.toHaveProperty('authHeader')
  })
})

spyOn(runtimeConfig, 'getRuntimeDicomServers').mockImplementation(() => [BASIC, HEADER])
spyOn(runtimeConfig, 'getDicomServerById').mockImplementation(id => [BASIC, HEADER].find(s => s.id === id) ?? null)

const { dicomServersAdminRoutes } = await import('../src/routes/dicom-servers')
const app = new Elysia().use(dicomServersAdminRoutes)
const get = (path: string) => app.handle(new Request(`http://localhost${path}`))

describe('admin DICOM server reads', () => {
  it('lists servers without any stored secret', async () => {
    const res = await get('/dicom-servers')
    expect(res.status).toBe(200)
    const raw = await res.text()
    for (const secret of SECRETS) expect(raw).not.toContain(secret)
    const body = JSON.parse(raw)
    expect(body.totalServers).toBe(2)
    expect(body.servers.map((s: { hasPassword: boolean; hasAuthHeader: boolean }) => [s.hasPassword, s.hasAuthHeader]))
      .toEqual([[true, false], [false, true]])
  })

  it('returns one server without any stored secret', async () => {
    const res = await get('/dicom-servers/orthanc-main')
    expect(res.status).toBe(200)
    const raw = await res.text()
    for (const secret of SECRETS) expect(raw).not.toContain(secret)
    expect(JSON.parse(raw)).toMatchObject({ id: 'orthanc-main', username: 'orthanc', hasPassword: true })
  })
})
