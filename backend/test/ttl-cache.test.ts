// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The caching semantics eighteen modules used to each own: expiry, the
 * difference between a cached empty value and a miss, and single-flight loads.
 */

import { describe, expect, it } from 'bun:test'
import { TtlCache } from '../src/lib/cache/ttl-cache'
import { TokenCache, type FetchedToken } from '../src/lib/cache/token-cache'

describe('TtlCache', () => {
  it('returns a value until its TTL passes', async () => {
    const cache = new TtlCache<string>({ ttlMs: 20 })
    cache.set('k', 'v')

    expect(cache.get('k')).toBe('v')
    await Bun.sleep(30)
    expect(cache.get('k')).toBeUndefined()
  })

  it('distinguishes a cached null from a miss', () => {
    const cache = new TtlCache<string | null>({ ttlMs: 1000 })
    cache.set('known-absent', null)

    expect(cache.get('known-absent')).toBeNull()
    expect(cache.has('known-absent')).toBe(true)
    expect(cache.has('never-seen')).toBe(false)
  })

  it('accepts a per-entry TTL that overrides the default', async () => {
    const cache = new TtlCache<string>({ ttlMs: 5000 })
    cache.set('short', 'v', 20)
    cache.set('long', 'v')

    await Bun.sleep(30)
    expect(cache.get('short')).toBeUndefined()
    expect(cache.get('long')).toBe('v')
  })

  it('collapses concurrent misses onto one load', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 })
    let loads = 0
    const load = async () => {
      loads++
      await Bun.sleep(5)
      return 42
    }

    const results = await Promise.all([
      cache.getOrLoad('k', load),
      cache.getOrLoad('k', load),
      cache.getOrLoad('k', load),
    ])

    expect(results).toEqual([42, 42, 42])
    expect(loads).toBe(1)
  })

  it('does not cache a failed load, and retries on the next call', async () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 })
    let attempts = 0
    const load = async () => {
      attempts++
      if (attempts === 1) throw new Error('upstream down')
      return 'recovered'
    }

    await expect(cache.getOrLoad('k', load)).rejects.toThrow('upstream down')
    expect(cache.has('k')).toBe(false)
    expect(await cache.getOrLoad('k', load)).toBe('recovered')
  })

  it('derives an entry TTL from the loaded value when given a resolver', async () => {
    const cache = new TtlCache<{ ttl: number }>({ ttlMs: 5000 })
    await cache.getOrLoad('k', async () => ({ ttl: 20 }), value => value.ttl)

    expect(cache.has('k')).toBe(true)
    await Bun.sleep(30)
    expect(cache.has('k')).toBe(false)
  })

  it('evicts the soonest-to-expire entry past maxEntries', () => {
    const cache = new TtlCache<string>({ ttlMs: 5000, maxEntries: 2 })
    cache.set('a', 'a', 100)
    cache.set('b', 'b', 5000)
    cache.set('c', 'c', 5000)

    expect(cache.has('a')).toBe(false)
    expect(cache.keys().sort()).toEqual(['b', 'c'])
  })

  it('reports only live entries in size and keys', async () => {
    const cache = new TtlCache<string>({ ttlMs: 20 })
    cache.set('a', 'a')
    cache.set('b', 'b', 5000)

    await Bun.sleep(30)
    expect(cache.size).toBe(1)
    expect(cache.keys()).toEqual(['b'])
  })

  it('drops everything on dispose', () => {
    const cache = new TtlCache<string>({ ttlMs: 5000, cleanupIntervalMs: 10 })
    cache.set('a', 'a')
    cache.dispose()

    expect(cache.size).toBe(0)
  })
})

describe('TokenCache', () => {
  const token = (expiresInSeconds?: number): FetchedToken => ({ token: 'at', expiresInSeconds })

  it('reuses a token while it is valid', async () => {
    const cache = new TokenCache()
    let fetches = 0

    const get = () => cache.get('client', async () => { fetches++; return token(300) })
    expect(await get()).toBe('at')
    expect(await get()).toBe('at')
    expect(fetches).toBe(1)
  })

  it('subtracts the safety margin from expires_in', async () => {
    /*
     * A 10s token: with a 9s margin it lives ~1s and must be refetched after the
     * wait; with no margin it lives ~10s and must not be. The two lifetimes sit
     * either side of the wait with seconds to spare on each, because a tight
     * margin here made the assertion fail whenever the machine stalled — a
     * flake, not a finding.
     */
    const margin = new TokenCache({ safetyMarginSeconds: 9 })
    const none = new TokenCache({ safetyMarginSeconds: 0 })
    let withMargin = 0
    let without = 0

    await margin.get('c', async () => { withMargin++; return token(10) })
    await none.get('c', async () => { without++; return token(10) })
    await Bun.sleep(1200)
    await margin.get('c', async () => { withMargin++; return token(10) })
    await none.get('c', async () => { without++; return token(10) })

    expect(withMargin).toBe(2)
    expect(without).toBe(1)
  })

  it('never extends a token past its own lifetime, whatever the margin', async () => {
    const cache = new TokenCache({ safetyMarginSeconds: 30 })
    let fetches = 0

    const get = () => cache.get('client', async () => { fetches++; return token(1) })
    await get()
    await Bun.sleep(1050)
    await get()

    expect(fetches).toBe(2)
  })

  it('keeps tokens for different grants apart', async () => {
    const cache = new TokenCache()
    await cache.get('a', async () => ({ token: 'token-a' }))
    await cache.get('b', async () => ({ token: 'token-b' }))

    expect(await cache.get('a', async () => ({ token: 'refetched' }))).toBe('token-a')
    expect(await cache.get('b', async () => ({ token: 'refetched' }))).toBe('token-b')
  })

  it('propagates a failed fetch without caching it', async () => {
    const cache = new TokenCache()
    await expect(cache.get('client', async () => { throw new Error('401') })).rejects.toThrow('401')
    expect(await cache.get('client', async () => token(300))).toBe('at')
  })
})
