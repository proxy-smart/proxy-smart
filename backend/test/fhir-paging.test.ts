// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { bundlePageCursors, executeFhirPage, executeFhirRequest, type FhirTarget } from '../src/lib/fhir-request-pipeline'
import { PageCursorCache, pageCursorCache, pageCursorOwner, type PageCursorGrant, type SharedPageCursorBackend } from '../src/lib/cache/page-cursor-cache'

const UPSTREAM = 'http://127.0.0.1:1/fhir'
const upstreamCalls: string[] = []

function searchset(cursor: string | null): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    link: cursor ? [{ relation: 'next', url: `${UPSTREAM}?_getpages=${cursor}&_getpagesoffset=1&_count=1` }] : [],
    entry: [],
  }
}

const target: FhirTarget = {
  serverInfo: {
    name: 'hapi', url: UPSTREAM, identifier: 'paging-test', lastUpdated: 0,
    metadata: { fhirVersion: '4.0.1', supported: true },
  },
  serverName: 'hapi',
  fhirVersion: 'R4',
  upstreamFetch: mock(async (url: string) => {
    upstreamCalls.push(url)
    const cursor = new URL(url).searchParams.get('_getpages')
    return new Response(JSON.stringify(searchset(cursor ? `${cursor}-next` : 'first-page')), {
      status: 200, headers: { 'content-type': 'application/fhir+json' },
    })
  }),
}

const reader = { tokenPayload: { sub: 'u1', scope: 'openid patient/Observation.rs', patient: 'p1', aud: UPSTREAM }, authHeader: 'Bearer a' }
const otherUser = { tokenPayload: { sub: 'u2', scope: 'openid patient/Observation.rs', patient: 'p1', aud: UPSTREAM }, authHeader: 'Bearer b' }
const otherServer: FhirTarget = { ...target, serverName: 'other' }
const pageQuery = (cursor: string) => `?_getpages=${cursor}&_getpagesoffset=1&_count=1`

describe('bundlePageCursors', () => {
  it('reads the page ids from a Bundle\'s links', () => {
    expect(bundlePageCursors(searchset('abc'))).toEqual(['abc'])
  })

  it('reads nothing from a body that is not a Bundle with links', () => {
    expect(bundlePageCursors({ resourceType: 'Patient' })).toEqual([])
    expect(bundlePageCursors('text')).toEqual([])
    expect(bundlePageCursors({ resourceType: 'Bundle', link: [{ url: 'not a url' }] })).toEqual([])
  })
})

describe('search paging through the pipeline', () => {
  beforeEach(() => {
    process.env.SCOPE_ENFORCEMENT_MODE = 'enforce'
    process.env.ROLE_BASED_FILTERING_MODE = 'enforce'
    process.env.CONSENT_ENABLED = 'false'
    upstreamCalls.length = 0
    pageCursorCache.clear()
  })
  afterEach(() => {
    delete process.env.SCOPE_ENFORCEMENT_MODE
    delete process.env.ROLE_BASED_FILTERING_MODE
    delete process.env.CONSENT_ENABLED
  })

  async function firstPage() {
    return executeFhirRequest(target, reader, { method: 'GET', resourcePath: 'Observation', queryString: '?code=x', headers: new Headers() })
  }

  it.serial('serves a page of a search the same client ran', async () => {
    expect((await firstPage()).status).toBe(200)
    const page = await executeFhirPage(target, reader, pageQuery('first-page'), new Headers())
    expect(page.status).toBe(200)
    expect(upstreamCalls[upstreamCalls.length - 1]).toContain('_getpages=first-page')
  })

  it.serial('serves the next page from a page it served', async () => {
    await firstPage()
    await executeFhirPage(target, reader, pageQuery('first-page'), new Headers())
    expect((await executeFhirPage(target, reader, pageQuery('first-page-next'), new Headers())).status).toBe(200)
  })

  it.serial('refuses a page id no search produced, without asking the upstream server', async () => {
    const page = await executeFhirPage(target, reader, pageQuery('guessed'), new Headers())
    expect(page.status).toBe(403)
    expect(upstreamCalls).toHaveLength(0)
  })

  it.serial('refuses a page of a search another user ran', async () => {
    await firstPage()
    upstreamCalls.length = 0
    expect((await executeFhirPage(target, otherUser, pageQuery('first-page'), new Headers())).status).toBe(403)
    expect(upstreamCalls).toHaveLength(0)
  })

  it.serial('refuses a page of a search run on another server', async () => {
    await firstPage()
    const page = await executeFhirPage(otherServer, { ...reader, tokenPayload: { ...reader.tokenPayload, aud: UPSTREAM } }, pageQuery('first-page'), new Headers())
    expect(page.status).not.toBe(200)
  })
})

describe('PageCursorCache', () => {
  const grant: PageCursorGrant = { owner: pageCursorOwner({ azp: 'app-a', sub: 'u1' }), server: 'hapi', screenReads: true }

  it('finds a remembered cursor and nothing else', async () => {
    const cache = new PageCursorCache({ ttlMs: 60_000 })
    await cache.remember(['c1'], grant)
    expect(await cache.grantFor('c1')).toEqual(grant)
    expect(await cache.grantFor('c2')).toBeNull()
    cache.dispose()
  })

  it('reads a cursor another instance stored in the shared backend', async () => {
    const rows = new Map<string, PageCursorGrant>()
    const shared: SharedPageCursorBackend = {
      save: async (key, value) => { rows.set(key, value) },
      find: async (key) => rows.get(key) ?? null,
      dispose: () => {},
    }
    const writer = new PageCursorCache({ shared, ttlMs: 60_000 })
    const other = new PageCursorCache({ shared, ttlMs: 60_000 })
    await writer.remember(['c1'], grant)
    expect(await other.grantFor('c1')).toEqual(grant)
    writer.dispose()
    other.dispose()
  })

  it('refuses rather than throws when the shared backend is down', async () => {
    const shared: SharedPageCursorBackend = {
      save: async () => { throw new Error('down') },
      find: async () => { throw new Error('down') },
      dispose: () => {},
    }
    const cache = new PageCursorCache({ shared, ttlMs: 60_000 })
    expect(await cache.grantFor('c1')).toBeNull()
    cache.dispose()
  })

  it('binds a cursor to the client and the user', () => {
    expect(pageCursorOwner({ azp: 'app-a', sub: 'u1' })).not.toBe(pageCursorOwner({ azp: 'app-b', sub: 'u1' }))
    expect(pageCursorOwner({ azp: 'app-a', sub: 'u1' })).not.toBe(pageCursorOwner({ azp: 'app-a', sub: 'u2' }))
  })
})
