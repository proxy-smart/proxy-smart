// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, mock, setSystemTime, afterAll } from 'bun:test'

let adminLookups = 0
let adminLookup: () => Promise<null> = async () => null

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: () => {
    adminLookups++
    return adminLookup()
  },
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

const { refreshCorsOrigins, refreshIfStale } = await import('../src/lib/cors-origins')

const MINUTE = 60_000
let clock = Date.parse('2026-01-01T00:00:00Z')
const advance = (ms: number) => setSystemTime(new Date((clock += ms)))

afterAll(() => setSystemTime())

describe('CORS origins refresh pacing', () => {
  it('does not refresh again on the next requests after a refresh without admin credentials', async () => {
    advance(0)
    await refreshCorsOrigins()
    refreshIfStale()
    refreshIfStale()
    expect(adminLookups).toBe(1)
  })

  it('starts one refresh for a burst of requests once the cache is stale', async () => {
    advance(10 * MINUTE)
    let release = () => {}
    adminLookup = () => new Promise<null>((resolve) => { release = () => resolve(null) })
    const before = adminLookups
    refreshIfStale()
    refreshIfStale()
    refreshIfStale()
    expect(adminLookups - before).toBe(1)
    release()
  })

  it('retries a failed refresh after a short delay rather than on every request', async () => {
    advance(10 * MINUTE)
    adminLookup = async () => { throw new Error('keycloak down') }
    const before = adminLookups
    refreshIfStale()
    await Bun.sleep(0)
    refreshIfStale()
    expect(adminLookups - before).toBe(1)
    advance(MINUTE)
    refreshIfStale()
    expect(adminLookups - before).toBe(2)
  })
})
