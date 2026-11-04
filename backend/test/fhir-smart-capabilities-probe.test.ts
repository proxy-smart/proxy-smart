// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as upstream from '../src/lib/upstream-fetch'
import { clearFHIRMetadataCache, clearMetadataCache, getFHIRServerInfo } from '../src/lib/fhir-utils'

const BASE = 'http://hapi.test/fhir'
const CAPABILITY = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'HAPI FHIR' } }

function origin(): { probes: () => number; restore: () => void } {
  let probes = 0
  const spy = spyOn(upstream, 'upstreamFetch').mockImplementation(async (url) => {
    if (url.endsWith('/.well-known/smart-configuration')) {
      probes++
      return new Response('Not Found', { status: 404 })
    }
    return new Response(JSON.stringify(CAPABILITY), { status: 200, headers: { 'content-type': 'application/fhir+json' } })
  })
  return { probes: () => probes, restore: () => spy.mockRestore() }
}

afterEach(() => clearFHIRMetadataCache())

describe.serial("an origin server's SMART configuration", () => {
  it('is asked for once an hour, not on every five-minute metadata refresh, when the origin serves none', async () => {
    const server = origin()
    const start = Date.now()
    const clock = spyOn(Date, 'now')
    for (const minutes of [0, 6, 12, 18]) {
      clock.mockReturnValue(start + minutes * 60_000)
      expect((await getFHIRServerInfo(BASE)).smartCapabilities).toEqual([])
    }
    expect(server.probes()).toBe(1)
    clock.mockReturnValue(start + 61 * 60_000)
    await getFHIRServerInfo(BASE)
    expect(server.probes()).toBe(2)
    clock.mockRestore()
    server.restore()
  })

  it('is asked for again when an admin refreshes the server', async () => {
    const server = origin()
    await getFHIRServerInfo(BASE)
    clearMetadataCache(BASE)
    await getFHIRServerInfo(BASE)
    expect(server.probes()).toBe(2)
    server.restore()
  })
})
