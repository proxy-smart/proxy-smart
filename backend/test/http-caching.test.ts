// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { cacheLifetimeMs, ifNoneMatchSatisfied, mergeVary, weakEtag } from '../src/lib/http-caching'

describe('cacheLifetimeMs', () => {
  const fallback = 60_000
  const ceiling = 3_600_000

  it('uses the fallback without a Cache-Control header', () => {
    expect(cacheLifetimeMs(null, fallback, ceiling)).toBe(fallback)
  })

  it('honours max-age', () => {
    expect(cacheLifetimeMs('public, max-age=120', fallback, ceiling)).toBe(120_000)
  })

  it('prefers s-maxage, the directive for shared caches', () => {
    expect(cacheLifetimeMs('max-age=600, s-maxage=30', fallback, ceiling)).toBe(30_000)
  })

  it('never caches no-store, no-cache or max-age=0', () => {
    expect(cacheLifetimeMs('no-store', fallback, ceiling)).toBe(0)
    expect(cacheLifetimeMs('no-cache, max-age=600', fallback, ceiling)).toBe(0)
    expect(cacheLifetimeMs('max-age=0', fallback, ceiling)).toBe(0)
  })

  it('caps a long max-age at the ceiling', () => {
    expect(cacheLifetimeMs('max-age=31536000', fallback, ceiling)).toBe(ceiling)
  })

  it('treats a malformed max-age as no indication', () => {
    expect(cacheLifetimeMs('max-age=soon', fallback, ceiling)).toBe(fallback)
  })

  it('reads directives case-insensitively and tolerates quoted values', () => {
    expect(cacheLifetimeMs('Max-Age="45"', fallback, ceiling)).toBe(45_000)
  })
})

describe('weakEtag', () => {
  it('is weak and stable for equal content', () => {
    const etag = weakEtag('{"a":1}')
    expect(etag).toMatch(/^W\/"[^"]+"$/)
    expect(weakEtag('{"a":1}')).toBe(etag)
  })

  it('changes with the content', () => {
    expect(weakEtag('{"a":1}')).not.toBe(weakEtag('{"a":2}'))
  })
})

describe('ifNoneMatchSatisfied', () => {
  const etag = 'W/"abc"'

  it('is false without the header', () => {
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false)
  })

  it('matches by weak comparison', () => {
    expect(ifNoneMatchSatisfied('W/"abc"', etag)).toBe(true)
    expect(ifNoneMatchSatisfied('"abc"', etag)).toBe(true)
  })

  it('matches any entry of a list', () => {
    expect(ifNoneMatchSatisfied('"zzz", W/"abc" , "yyy"', etag)).toBe(true)
    expect(ifNoneMatchSatisfied('"zzz", "yyy"', etag)).toBe(false)
  })

  it('matches the wildcard', () => {
    expect(ifNoneMatchSatisfied('*', etag)).toBe(true)
  })

  it('does not match a different tag', () => {
    expect(ifNoneMatchSatisfied('W/"abd"', etag)).toBe(false)
  })
})

describe('mergeVary', () => {
  it('unions field lists without case duplicates, and lets * absorb the rest', () => {
    expect(mergeVary('Origin', 'Accept-Encoding')).toBe('Origin, Accept-Encoding')
    expect(mergeVary('origin, Accept-Encoding', 'Origin')).toBe('origin, Accept-Encoding')
    expect(mergeVary('Origin', '*')).toBe('*')
    expect(mergeVary(null, undefined, '')).toBe('')
  })
})
