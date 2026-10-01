// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * The client-config cache must distinguish "this client has no registered
 * redirect URIs" from "Keycloak could not be asked".
 *
 * The redirect_uri check is fail-closed on an empty allowlist, so flattening an
 * unreachable Keycloak into `[]` made every SMART launch fail with
 * "redirect_uri does not match a registered redirect URI for this client" —
 * blaming the app's configuration for an outage on our side. Worse, the empty
 * result was cached, so one hiccup rejected every launch for the whole TTL.
 *
 * Driven through createClientConfigCache rather than mock.module: bun's module
 * mocks are process-global, and a sibling test mocks this whole module.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { createClientConfigCache, type ClientLookup } from '../src/lib/smart-client-config-cache'

const CLIENT = 'inferno-test-client'
const REDIRECT = 'http://localhost:4567/custom/smart_stu2_2/redirect'

let mode: 'found' | 'absent' | 'unavailable' = 'found'
let calls = 0

function source(_clientId: string): Promise<ClientLookup> {
  calls++
  if (mode === 'unavailable') {
    return Promise.resolve({ status: 'unavailable', reason: 'connect ECONNREFUSED 127.0.0.1:8080' })
  }
  if (mode === 'absent') return Promise.resolve({ status: 'absent' })
  return Promise.resolve({
    status: 'found',
    config: { redirectUris: [REDIRECT], patientFacing: true },
  })
}

let cache = createClientConfigCache(source)

describe('client config cache — allowlist vs unavailable', () => {
  beforeEach(() => {
    cache = createClientConfigCache(source)
    calls = 0
    mode = 'found'
  })

  it('returns the URIs registered for a known client', async () => {
    expect(await cache.getRegisteredRedirectUris(CLIENT)).toEqual([REDIRECT])
  })

  it('returns an empty allowlist for a client Keycloak does not have', async () => {
    mode = 'absent'
    expect(await cache.getRegisteredRedirectUris('no-such-client')).toEqual([])
  })

  it('throws instead of returning an empty allowlist when Keycloak is unreachable', async () => {
    mode = 'unavailable'
    await expect(cache.getRegisteredRedirectUris(CLIENT)).rejects.toThrow(
      /Cannot read registered redirect URIs/,
    )
  })

  it('does not cache an unreachable lookup, so recovery is immediate', async () => {
    mode = 'unavailable'
    await expect(cache.getRegisteredRedirectUris(CLIENT)).rejects.toThrow()

    mode = 'found'
    expect(await cache.getRegisteredRedirectUris(CLIENT)).toEqual([REDIRECT])
  })

  it('caches a successful lookup', async () => {
    await cache.getRegisteredRedirectUris(CLIENT)
    await cache.getRegisteredRedirectUris(CLIENT)
    expect(calls).toBe(1)
  })

  it('re-asks after an absent client is invalidated (admin recreate)', async () => {
    mode = 'absent'
    expect(await cache.getRegisteredRedirectUris(CLIENT)).toEqual([])

    cache.invalidate(CLIENT)
    mode = 'found'
    expect(await cache.getRegisteredRedirectUris(CLIENT)).toEqual([REDIRECT])
  })

  it('keeps token-time config lenient — no throw when Keycloak is unreachable', async () => {
    mode = 'unavailable'
    expect(await cache.getSmartClientConfig(CLIENT)).toEqual({ redirectUris: [] })
  })
})

describe('getClientHomeUrl', () => {
  const homeCache = (lookup: ClientLookup) => createClientConfigCache(async () => lookup)

  it("prefers the client's registered home URL", async () => {
    const cache = homeCache({ status: 'found', config: { redirectUris: ['https://app.example.com/cb'], homeUrl: 'https://app.example.com/viewer/' } })
    expect(await cache.getClientHomeUrl('app')).toBe('https://app.example.com/viewer/')
  })

  it('falls back to the origin of its redirect URIs', async () => {
    const cache = homeCache({ status: 'found', config: { redirectUris: ['https://dicom.example.com/callback'] } })
    expect(await cache.getClientHomeUrl('dicom')).toBe('https://dicom.example.com')
  })

  it('is undefined for an unknown client, so the caller uses its own fallback', async () => {
    expect(await homeCache({ status: 'absent' }).getClientHomeUrl('nope')).toBeUndefined()
  })

  it('is undefined rather than throwing when Keycloak cannot be asked', async () => {
    expect(await homeCache({ status: 'unavailable', reason: 'down' }).getClientHomeUrl('app')).toBeUndefined()
  })
})
