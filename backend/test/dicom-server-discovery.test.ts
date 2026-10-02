// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { config } from '../src/config'
import type { DicomServerConfigType } from '../src/schemas'
import * as runtimeConfig from '../src/lib/runtime-config'

const SERVERS: DicomServerConfigType[] = [
  {
    id: 'orthanc-main',
    name: 'Orthanc Main',
    baseUrl: 'http://pacs-up.internal:8042/dicom-web',
    wadoRoot: 'http://pacs-up.internal:8042/wado',
    qidoRoot: 'http://pacs-up.internal:8042/qido',
    authType: 'basic',
    username: 'orthanc',
    password: 'secret-password',
    timeoutMs: 30000,
  },
  {
    id: 'archive',
    name: 'Archive PACS',
    baseUrl: 'http://pacs-down.internal/dicom-web',
    authType: 'header',
    authHeader: 'Bearer upstream-secret-token',
    isDefault: true,
  },
]

spyOn(runtimeConfig, 'getRuntimeDicomServers').mockImplementation(() => SERVERS)
spyOn(runtimeConfig, 'getDicomServerById').mockImplementation(id => SERVERS.find(s => s.id === id) ?? null)

const { dicomServerDiscoveryRoutes } = await import('../src/routes/dicom-servers')
const app = new Elysia().use(dicomServerDiscoveryRoutes)

const ORIGINAL_FETCH = globalThis.fetch
const upstreamCalls: { url: string; authorization: string | null }[] = []

beforeAll(() => {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      upstreamCalls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      if (url.startsWith('http://pacs-down.internal')) throw new Error('fetch failed: ECONNREFUSED')
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/dicom+json' } })
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  )
})

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

const get = (path: string) => app.handle(new Request(`http://localhost${path}`))

describe('GET /dicom-servers', () => {
  it('lists every server with its proxied DICOMweb base and a single effective default', async () => {
    const res = await get('/dicom-servers')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      totalServers: 2,
      servers: [
        { id: 'orthanc-main', name: 'Orthanc Main', isDefault: false, dicomweb: `${config.baseUrl}/dicomweb/servers/orthanc-main` },
        { id: 'archive', name: 'Archive PACS', isDefault: true, dicomweb: `${config.baseUrl}/dicomweb/servers/archive` },
      ],
    })
  })

  it('exposes only the public fields, never upstream URLs or credentials', async () => {
    const res = await get('/dicom-servers')
    const raw = await res.text()
    const body = JSON.parse(raw)
    expect(Object.keys(body).sort()).toEqual(['servers', 'totalServers'])
    for (const server of body.servers) {
      expect(Object.keys(server).sort()).toEqual(['dicomweb', 'id', 'isDefault', 'name'])
    }
    for (const secret of ['pacs-up.internal', 'pacs-down.internal', 'secret-password', 'upstream-secret-token', 'orthanc"']) {
      expect(raw).not.toContain(secret)
    }
  })

  it('needs no Authorization header', async () => {
    const res = await get('/dicom-servers')
    expect(res.status).toBe(200)
  })
})

describe('GET /dicom-servers/:server_id/status', () => {
  it('reports a reachable server, probing upstream with its stored credentials', async () => {
    const res = await get('/dicom-servers/orthanc-main/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ id: 'orthanc-main', reachable: true, message: 'PACS is available' })
    expect(Object.keys(body).sort()).toEqual(['id', 'message', 'reachable'])

    const call = upstreamCalls.find(c => c.url.startsWith('http://pacs-up.internal'))
    expect(call?.url).toBe('http://pacs-up.internal:8042/dicom-web/studies?limit=1')
    expect(call?.authorization).toBe(`Basic ${Buffer.from('orthanc:secret-password').toString('base64')}`)
  })

  it('reports an unreachable server without leaking its address', async () => {
    const res = await get('/dicom-servers/archive/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('archive')
    expect(body.reachable).toBe(false)
    expect(body.message).toContain('Connection refused')
    expect(JSON.stringify(body)).not.toContain('pacs-down.internal')
  })

  it('returns 404 for an unknown server id', async () => {
    const res = await get('/dicom-servers/does-not-exist/status')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "DICOM server 'does-not-exist' not found" })
  })
})
