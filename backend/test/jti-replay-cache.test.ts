// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The private_key_jwt replay cache. A jti is spent once; on several nodes the shared backend is
 * what makes "once" hold for the deployment rather than for one process.
 */

import { describe, it, expect } from 'bun:test'
import { JtiReplayCache, type SharedJtiBackend } from '../src/lib/cache/jti-replay-cache'

const inFiveMinutes = () => Date.now() + 300_000

/** One shared table; each operation is atomic, as a single SQL statement is. */
class FakeSharedJtiBackend implements SharedJtiBackend {
  readonly rows = new Map<string, number>()
  failing = false

  async claim(key: string, expiresAt: number, now: number): Promise<boolean> {
    if (this.failing) throw new Error('database unreachable')
    const existing = this.rows.get(key)
    if (existing !== undefined && existing > now) return false
    this.rows.set(key, expiresAt)
    return true
  }

  async isClaimed(key: string, now: number): Promise<boolean> {
    if (this.failing) throw new Error('database unreachable')
    const existing = this.rows.get(key)
    return existing !== undefined && existing > now
  }

  dispose(): void {}
}

async function withCache(run: (cache: JtiReplayCache) => Promise<void>, shared: SharedJtiBackend | null = null) {
  const cache = new JtiReplayCache({ shared })
  try {
    await run(cache)
  } finally {
    cache.dispose()
  }
}

async function withCluster(run: (nodeA: JtiReplayCache, nodeB: JtiReplayCache, shared: FakeSharedJtiBackend) => Promise<void>) {
  const shared = new FakeSharedJtiBackend()
  await withCache((nodeA) => withCache((nodeB) => run(nodeA, nodeB, shared), shared), shared)
}

describe('JtiReplayCache', () => {
  it('spends a jti once', () => withCache(async (cache) => {
    expect(await cache.spend('client-a', 'jti-1', inFiveMinutes())).toBe(true)
    expect(await cache.spend('client-a', 'jti-1', inFiveMinutes())).toBe(false)
  }))

  it('reports a spent jti without spending it', () => withCache(async (cache) => {
    expect(await cache.isSpent('client-a', 'jti-2')).toBe(false)
    await cache.spend('client-a', 'jti-2', inFiveMinutes())

    expect(await cache.isSpent('client-a', 'jti-2')).toBe(true)
  }))

  it('keeps the same jti from different clients apart', () => withCache(async (cache) => {
    await cache.spend('client-a', 'shared-jti', inFiveMinutes())

    expect(await cache.spend('client-b', 'shared-jti', inFiveMinutes())).toBe(true)
  }))

  it('does not confuse an issuer and jti that concatenate to the same string', () => withCache(async (cache) => {
    await cache.spend('a:b', 'c', inFiveMinutes())

    expect(await cache.spend('a', 'b:c', inFiveMinutes())).toBe(true)
  }))

  it('lets exactly one of several concurrent spends win', () => withCache(async (cache) => {
    const results = await Promise.all([1, 2, 3, 4].map(() => cache.spend('client-a', 'race', inFiveMinutes())))

    expect(results.filter(Boolean)).toHaveLength(1)
  }))

  it('frees a jti once the assertion has expired', () => withCache(async (cache) => {
    await cache.spend('client-a', 'short', Date.now() + 20)
    await Bun.sleep(30)

    expect(await cache.spend('client-a', 'short', inFiveMinutes())).toBe(true)
  }))

  it('can be cleared', () => withCache(async (cache) => {
    await cache.spend('client-a', 'jti-clear', inFiveMinutes())
    cache.clear()

    expect(await cache.spend('client-a', 'jti-clear', inFiveMinutes())).toBe(true)
  }))
})

describe('JtiReplayCache across nodes', () => {
  it('refuses on one node a jti spent on another', () => withCluster(async (nodeA, nodeB) => {
    expect(await nodeA.spend('client-a', 'jti-x', inFiveMinutes())).toBe(true)

    expect(await nodeB.isSpent('client-a', 'jti-x')).toBe(true)
    expect(await nodeB.spend('client-a', 'jti-x', inFiveMinutes())).toBe(false)
  }))

  it('lets exactly one node win a concurrent replay', () => withCluster(async (nodeA, nodeB) => {
    const results = await Promise.all([
      nodeA.spend('client-a', 'jti-race', inFiveMinutes()),
      nodeB.spend('client-a', 'jti-race', inFiveMinutes()),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  }))

  it('stores a fixed-length digest rather than the raw client id and jti', () => withCluster(async (nodeA, _nodeB, shared) => {
    await nodeA.spend('client-a', 'jti-raw-value', inFiveMinutes())
    const [key] = [...shared.rows.keys()]

    expect(key).toMatch(/^[0-9a-f]{64}$/)
  }))

  it('still refuses a replay on the same node while the shared backend is down', () => withCluster(async (nodeA, _nodeB, shared) => {
    shared.failing = true

    expect(await nodeA.spend('client-a', 'jti-outage', inFiveMinutes())).toBe(true)
    expect(await nodeA.isSpent('client-a', 'jti-outage')).toBe(true)
    expect(await nodeA.spend('client-a', 'jti-outage', inFiveMinutes())).toBe(false)
  }))
})
