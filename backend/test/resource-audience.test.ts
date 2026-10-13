// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { createResourceAudienceResolver, type ResourceClientSource } from '../src/lib/resource-audience'

const FHIR = 'https://proxy.example.com/proxy-smart-backend/hapi-fhir-server/R4'

function source(...snapshots: Array<Record<string, string>>): ResourceClientSource & { loads: number } {
  const state = {
    loads: 0,
    async load() {
      const snapshot = snapshots[Math.min(state.loads, snapshots.length - 1)]
      state.loads += 1
      return new Map(Object.entries(snapshot))
    },
  }
  return state
}

describe('resource → audience for token exchange', () => {
  it('names the client whose resource_url is exactly the resource', async () => {
    const resolver = createResourceAudienceResolver(source({ [FHIR]: 'fhir-resource-server' }))
    expect(await resolver.audienceFor(FHIR)).toBe('fhir-resource-server')
    expect(await resolver.audienceFor(`${FHIR}/`)).toBeNull()
  })

  it('serves repeat lookups from the cache', async () => {
    const clients = source({ [FHIR]: 'fhir-resource-server' })
    const resolver = createResourceAudienceResolver(clients, () => 1_000)
    await resolver.audienceFor(FHIR)
    await resolver.audienceFor(FHIR)
    expect(clients.loads).toBe(1)
  })

  it('finds a client registered after the cache filled, once the miss-reload window has passed', async () => {
    const clients = source({}, { [FHIR]: 'fhir-resource-server' })
    let clock = 0
    const resolver = createResourceAudienceResolver(clients, () => clock)
    expect(await resolver.audienceFor(FHIR)).toBeNull()
    clock = 10_000
    expect(await resolver.audienceFor(FHIR)).toBeNull()
    clock = 40_000
    expect(await resolver.audienceFor(FHIR)).toBe('fhir-resource-server')
    expect(clients.loads).toBe(2)
  })

  it('reloads after the cache expires', async () => {
    const clients = source({ [FHIR]: 'old-client' }, { [FHIR]: 'fhir-resource-server' })
    let clock = 0
    const resolver = createResourceAudienceResolver(clients, () => clock)
    expect(await resolver.audienceFor(FHIR)).toBe('old-client')
    clock = 6 * 60 * 1000
    expect(await resolver.audienceFor(FHIR)).toBe('fhir-resource-server')
  })
})
