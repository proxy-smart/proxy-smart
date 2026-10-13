// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, spyOn, afterEach, mock } from 'bun:test'
import { createApp } from '../src/app-factory'
import { brandBundleService, type BrandBundle } from '../src/lib/brand-bundle'

const app = createApp()
const headers = { etag: 'W/"abc"', 'cache-control': 'public, max-age=60', 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' }
const bundle: BrandBundle = { resourceType: 'Bundle', id: 'user-access-brands', type: 'collection', timestamp: '2026-01-01T00:00:00.000Z', entry: [] }

function get(ifNoneMatch?: string): Promise<Response> {
  return app.handle(new Request('http://localhost/branding.json', {
    headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {},
  }))
}

describe('GET /branding.json', () => {
  afterEach(() => {
    mock.restore()
  })

  it('returns 304 with ETag and Cache-Control and no body when the tag is current', async () => {
    const respond = spyOn(brandBundleService, 'respond').mockResolvedValue({ status: 304, headers })
    const res = await get('W/"abc"')

    expect(respond).toHaveBeenCalledWith('W/"abc"')
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('W/"abc"')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(await res.text()).toBe('')
  })

  it('returns the bundle with its validators otherwise', async () => {
    spyOn(brandBundleService, 'respond').mockResolvedValue({ status: 200, headers, bundle })
    const res = await get()

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('W/"abc"')
    expect(res.headers.get('last-modified')).toBe(headers['last-modified'])
    expect((await res.json()).resourceType).toBe('Bundle')
  })
})
