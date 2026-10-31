// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { shareConsentStatus } from '../src/lib/consent/shl-consent'

const SERVER = 'https://fhir.test/fhir'
const originalFetch = global.fetch
const token = async () => 'service-token'
let counter = 0
const nextShl = () => `shl-status-${++counter}`

function respondWith(handler: () => Promise<Response>): ReturnType<typeof mock> {
  const fetchMock = mock(handler)
  global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })
  return fetchMock
}

function consentBundle(status?: string): Response {
  const entry = status ? [{ resource: { resourceType: 'Consent', id: 'c1', status } }] : []
  return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry }), {
    status: 200, headers: { 'content-type': 'application/fhir+json' },
  })
}

describe('shareConsentStatus', () => {
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('reports an active share consent as standing', async () => {
    respondWith(async () => consentBundle('active'))
    expect(await shareConsentStatus(nextShl(), SERVER, token)).toBe('standing')
  })

  it('reports a share whose consent is not mirrored yet as standing', async () => {
    respondWith(async () => consentBundle())
    expect(await shareConsentStatus(nextShl(), SERVER, token)).toBe('standing')
  })

  it('reports an inactive share consent as revoked', async () => {
    respondWith(async () => consentBundle('inactive'))
    expect(await shareConsentStatus(nextShl(), SERVER, token)).toBe('revoked')
  })

  it('reports an upstream error status as unverifiable', async () => {
    respondWith(async () => new Response('down', { status: 503 }))
    expect(await shareConsentStatus(nextShl(), SERVER, token)).toBe('unverifiable')
  })

  it('reports an unreadable answer as unverifiable', async () => {
    respondWith(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(await shareConsentStatus(nextShl(), SERVER, token)).toBe('unverifiable')
  })

  it('reports an unreachable server as unverifiable', async () => {
    respondWith(async () => { throw new Error('connection refused') })
    expect(await shareConsentStatus(nextShl(), SERVER, token)).toBe('unverifiable')
  })

  it('reports a missing service token as unverifiable', async () => {
    respondWith(async () => consentBundle('active'))
    expect(await shareConsentStatus(nextShl(), SERVER, async () => { throw new Error('no token') })).toBe('unverifiable')
  })

  it('asks again after an unverifiable answer instead of remembering it', async () => {
    const shl = nextShl()
    respondWith(async () => new Response('down', { status: 503 }))
    expect(await shareConsentStatus(shl, SERVER, token)).toBe('unverifiable')
    const fetchMock = respondWith(async () => consentBundle('inactive'))
    expect(await shareConsentStatus(shl, SERVER, token)).toBe('revoked')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('remembers a definite answer for a short while', async () => {
    const shl = nextShl()
    respondWith(async () => consentBundle('active'))
    expect(await shareConsentStatus(shl, SERVER, token)).toBe('standing')
    const fetchMock = respondWith(async () => consentBundle('inactive'))
    expect(await shareConsentStatus(shl, SERVER, token)).toBe('standing')
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })
})
