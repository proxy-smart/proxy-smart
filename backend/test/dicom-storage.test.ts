// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach } from 'bun:test'
import { clearDicomStorageCache, measureStudyStorage, orthancRootOf } from '../src/lib/dicom-storage'
import type { DicomServerConfigType } from '../src/schemas'
import type { UpstreamFetch } from '../src/lib/upstream-fetch'

const SERVER: DicomServerConfigType = {
  id: 'orthanc', name: 'Orthanc', baseUrl: 'http://orthanc:8042/dicom-web', authType: 'basic', username: 'u', password: 'p',
}

const SIZES: Record<string, string> = { '1.2.1': '1000', '1.2.2': '2500' }

function orthanc(overrides: { system?: () => Response; statistics?: (id: string) => Response } = {}) {
  const calls: string[] = []
  const fetcher: UpstreamFetch = async (url, init) => {
    calls.push(url)
    expect(new Headers(init?.headers).get('authorization')).toStartWith('Basic ')
    const path = new URL(url).pathname
    if (path === '/system') return overrides.system?.() ?? Response.json({ ApiVersion: 27, Name: 'Orthanc' })
    if (path === '/tools/lookup') {
      const uid = String(init?.body)
      return Response.json(SIZES[uid] ? [{ ID: `orthanc-${uid}`, Type: 'Study', Path: `/studies/orthanc-${uid}` }] : [])
    }
    const stats = /^\/studies\/orthanc-(.+)\/statistics$/.exec(path)
    if (stats) return overrides.statistics?.(stats[1]) ?? Response.json({ DiskSize: SIZES[stats[1]], CountInstances: 3 })
    return new Response('not found', { status: 404 })
  }
  return { fetcher, calls }
}

describe('PACS storage usage', () => {
  beforeEach(clearDicomStorageCache)

  it('finds the Orthanc REST API above its DICOMweb root', () => {
    expect(orthancRootOf('http://orthanc:8042/dicom-web')).toBe('http://orthanc:8042')
    expect(orthancRootOf('https://pacs.example/orthanc/dicom-web/')).toBe('https://pacs.example/orthanc')
  })

  it('sums the disk size of every readable study, once per study', async () => {
    const { fetcher } = orthanc()
    const usage = await measureStudyStorage(['1.2.1', '1.2.2', '1.2.1'], SERVER, fetcher)
    expect(usage).toEqual({ studies: 2, bytes: 3500, unmeasuredStudies: 0 })
  })

  it('counts a study the PACS does not hold as zero bytes', async () => {
    const { fetcher } = orthanc()
    expect(await measureStudyStorage(['1.2.1', '9.9.9'], SERVER, fetcher)).toEqual({ studies: 2, bytes: 1000, unmeasuredStudies: 0 })
  })

  it('reports a PACS without a size API as unmeasured, not empty', async () => {
    const { fetcher } = orthanc({ system: () => new Response('nope', { status: 404 }) })
    expect(await measureStudyStorage(['1.2.1'], SERVER, fetcher)).toEqual({ studies: 1, bytes: null, unmeasuredStudies: 1 })
  })

  it('keeps a study whose size lookup failed out of the total', async () => {
    const { fetcher } = orthanc({ statistics: (uid) => (uid === '1.2.2' ? new Response('boom', { status: 500 }) : Response.json({ DiskSize: SIZES[uid] })) })
    expect(await measureStudyStorage(['1.2.1', '1.2.2'], SERVER, fetcher)).toEqual({ studies: 2, bytes: 1000, unmeasuredStudies: 1 })
  })

  it('caches sizes so a settings page reload does not walk the PACS again', async () => {
    const { fetcher, calls } = orthanc()
    await measureStudyStorage(['1.2.1'], SERVER, fetcher)
    const first = calls.length
    await measureStudyStorage(['1.2.1'], SERVER, fetcher)
    expect(calls.length).toBe(first)
  })

  it('reports an account with no studies as zero bytes', async () => {
    const { fetcher } = orthanc()
    expect(await measureStudyStorage([], SERVER, fetcher)).toEqual({ studies: 0, bytes: 0, unmeasuredStudies: 0 })
  })
})
