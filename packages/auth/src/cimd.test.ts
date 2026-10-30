// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * cimd.test.ts — OAuth Client ID Metadata Documents.
 *
 * The proxy rewrites `redirect_uri` when it intercepts, so it owns the RFC 6749
 * §10.6 check. For a CIMD client the metadata document is the only source of
 * truth, which makes every failure mode here a security decision: anything we
 * cannot verify must yield an EMPTY allowlist, because the caller reads empty as
 * "reject every redirect_uri". A fetch failure that widened the allowlist instead
 * would be an authorization-code-theft hole.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  isCimdClientId,
  validateCimdDocument,
  resolveCimdRedirectUris,
  clearCimdCache,
} from './cimd'

const CLIENT_ID = 'https://claude.ai/api/mcp/client-metadata.json'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const PUBLIC_DNS = { resolve: async () => ['160.79.104.10'] }

/** A fetch stub returning one canned response, counting calls. */
function stubFetch(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: string[] = []
  const impl = (async (url: string | URL) => {
    calls.push(String(url))
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

beforeEach(() => clearCimdCache())

describe('isCimdClientId', () => {
  test('accepts an https URL with a path', () => {
    expect(isCimdClientId(CLIENT_ID)).toBe(true)
  })

  test('rejects a bare origin — the spec requires a path component', () => {
    expect(isCimdClientId('https://claude.ai')).toBe(false)
    expect(isCimdClientId('https://claude.ai/')).toBe(false)
  })

  test('rejects http, and anything that is not a URL', () => {
    expect(isCimdClientId('http://claude.ai/meta.json')).toBe(false)
    expect(isCimdClientId('smart_app_6c68ed0a')).toBe(false)
    expect(isCimdClientId(undefined)).toBe(false)
  })
})

describe('validateCimdDocument', () => {
  test('accepts a well-formed document', () => {
    const doc = validateCimdDocument(
      { client_id: CLIENT_ID, client_name: 'Claude', redirect_uris: [REDIRECT] },
      CLIENT_ID,
    )
    expect(doc.redirect_uris).toEqual([REDIRECT])
    expect(doc.client_name).toBe('Claude')
  })

  test('rejects a client_id that does not match the document URL', () => {
    // The anti-spoofing check: otherwise any URL could vouch for any client id.
    expect(() =>
      validateCimdDocument(
        { client_id: 'https://evil.example.com/meta.json', redirect_uris: [REDIRECT] },
        CLIENT_ID,
      ),
    ).toThrow(/does not match document URL/)
  })

  test('rejects missing or empty redirect_uris', () => {
    expect(() => validateCimdDocument({ client_id: CLIENT_ID }, CLIENT_ID)).toThrow(/redirect_uris/)
    expect(() =>
      validateCimdDocument({ client_id: CLIENT_ID, redirect_uris: [] }, CLIENT_ID),
    ).toThrow(/redirect_uris/)
  })

  test('rejects a relative or non-absolute redirect_uri', () => {
    expect(() =>
      validateCimdDocument({ client_id: CLIENT_ID, redirect_uris: ['/callback'] }, CLIENT_ID),
    ).toThrow(/absolute URI/)
  })

  test('rejects a non-object body', () => {
    expect(() => validateCimdDocument([1, 2, 3], CLIENT_ID)).toThrow(/not a JSON object/)
    expect(() => validateCimdDocument('nope', CLIENT_ID)).toThrow(/not a JSON object/)
  })
})

describe('resolveCimdRedirectUris', () => {
  test('returns the document redirect_uris on success', async () => {
    const { impl, calls } = stubFetch({ client_id: CLIENT_ID, redirect_uris: [REDIRECT] })
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([REDIRECT])
    expect(calls).toEqual([CLIENT_ID])
  })

  // Every branch below must yield [] — the caller reads that as "reject all".
  test('returns [] on a non-2xx response', async () => {
    const { impl } = stubFetch({}, { status: 404 })
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([])
  })

  test('returns [] on malformed JSON', async () => {
    const { impl } = stubFetch('{ not json')
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([])
  })

  test('returns [] when client_id does not match the URL', async () => {
    const { impl } = stubFetch({ client_id: 'https://evil.example.com/m.json', redirect_uris: [REDIRECT] })
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([])
  })

  test('returns [] when the fetch throws', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([])
  })

  test('caches by default, so a second resolve does not refetch', async () => {
    const { impl, calls } = stubFetch({ client_id: CLIENT_ID, redirect_uris: [REDIRECT] })
    await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })
    await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })
    expect(calls).toHaveLength(1)
  })

  test('honours no-store by refetching every time', async () => {
    const { impl, calls } = stubFetch(
      { client_id: CLIENT_ID, redirect_uris: [REDIRECT] },
      { headers: { 'cache-control': 'no-store' } },
    )
    await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })
    await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })
    expect(calls).toHaveLength(2)
  })

  test('honours max-age=0 by refetching every time', async () => {
    const { impl, calls } = stubFetch(
      { client_id: CLIENT_ID, redirect_uris: [REDIRECT] },
      { headers: { 'cache-control': 'max-age=0' } },
    )
    await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })
    await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })
    expect(calls).toHaveLength(2)
  })

  test('does not cache a document it rejected', async () => {
    const bad = stubFetch({ client_id: 'https://evil.example.com/m.json', redirect_uris: [REDIRECT] })
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: bad.impl, urlPolicy: PUBLIC_DNS })).toEqual([])
    // A later good response must be used, not a poisoned cache entry.
    const good = stubFetch({ client_id: CLIENT_ID, redirect_uris: [REDIRECT] })
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: good.impl, urlPolicy: PUBLIC_DNS })).toEqual([REDIRECT])
  })

  test.each([
    'https://localhost/meta.json',
    'https://[::ffff:127.0.0.1]/meta.json',
    'https://[fd12::1]/meta.json',
    'https://100.64.0.1/meta.json',
    'https://keycloak/meta.json',
    'https://foo.localhost/meta.json',
  ])('does not fetch a document at %s', async (clientId) => {
    const { impl, calls } = stubFetch({ client_id: clientId, redirect_uris: [REDIRECT] })
    expect(await resolveCimdRedirectUris(clientId, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('does not fetch a document whose host resolves to a private address', async () => {
    const { impl, calls } = stubFetch({ client_id: CLIENT_ID, redirect_uris: [REDIRECT] })
    const urlPolicy = { resolve: async () => ['169.254.169.254'] }
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('stops reading a document that streams past the size limit', async () => {
    let pulled = 0
    const impl = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    }))) as unknown as typeof fetch
    expect(await resolveCimdRedirectUris(CLIENT_ID, { fetchImpl: impl, urlPolicy: PUBLIC_DNS })).toEqual([])
    expect(pulled).toBeLessThan(16)
  })
})
