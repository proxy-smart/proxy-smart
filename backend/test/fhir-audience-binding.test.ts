// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { enforceFhirAudience, fhirAudienceBases, fhirAudienceBinding } from '../src/lib/fhir-audience-binding'
import type { ResourceAudienceResolver } from '../src/lib/resource-audience'
import { getRuntimeAccessControlConfig } from '../src/lib/runtime-config'
import { config } from '../src/config'
import { logger } from '../src/lib/logger'

const BASE_A = 'https://proxy.example/proxy-smart-backend/hapi-a/R4'
const BASE_B = 'https://proxy.example/proxy-smart-backend/hapi-b/R4'
const UPSTREAM_A = 'http://hapi-a:8080/fhir'
const BASES_A = [BASE_A, UPSTREAM_A]

const resolver = (byResource: Record<string, string>): ResourceAudienceResolver => ({
  audienceFor: async (resource) => byResource[resource] ?? null,
})
const RESOLVER = resolver({ [BASE_A]: 'fhir-resource-server' })

describe('fhirAudienceBinding', () => {
  it('binds a token whose aud is this server\'s FHIR base, with or without a trailing slash', async () => {
    expect((await fhirAudienceBinding(BASE_A, BASES_A, RESOLVER)).bound).toBe(true)
    expect((await fhirAudienceBinding([`${BASE_A}/`, 'account'], BASES_A, RESOLVER)).bound).toBe(true)
    expect((await fhirAudienceBinding(UPSTREAM_A, BASES_A, RESOLVER)).bound).toBe(true)
  })

  it('refuses a token authorized for another FHIR base', async () => {
    const binding = await fhirAudienceBinding(BASE_B, BASES_A, RESOLVER)
    expect(binding.bound).toBe(false)
    expect(binding.bound ? '' : binding.reason).toContain(BASE_B)
  })

  it('does not accept a base as a prefix of another', async () => {
    expect((await fhirAudienceBinding(`${BASE_A}/Patient`, BASES_A, RESOLVER)).bound).toBe(false)
    expect((await fhirAudienceBinding('https://proxy.example/proxy-smart-backend/', BASES_A, RESOLVER)).bound).toBe(false)
  })

  it('binds through the resource client whose resource_url is this base, once narrowed to it', async () => {
    expect((await fhirAudienceBinding(['fhir-resource-server'], BASES_A, RESOLVER)).bound).toBe(true)
    expect((await fhirAudienceBinding(['fhir-resource-server'], [BASE_B], RESOLVER)).bound).toBe(false)
    expect((await fhirAudienceBinding(['fhir-resource-server', 'mcp-resource-server', 'account'], BASES_A, RESOLVER)).bound).toBe(false)
  })

  it('refuses tokens issued to other clients of the realm', async () => {
    expect((await fhirAudienceBinding('account', BASES_A, RESOLVER)).bound).toBe(false)
    expect((await fhirAudienceBinding(['admin-ui'], BASES_A, RESOLVER)).bound).toBe(false)
    expect((await fhirAudienceBinding('https://proxy.example/mcp', BASES_A, RESOLVER)).bound).toBe(false)
    expect((await fhirAudienceBinding(undefined, BASES_A, RESOLVER)).bound).toBe(false)
  })

  it('reads a resolver failure as unbound', async () => {
    const failing: ResourceAudienceResolver = { audienceFor: async () => { throw new Error('down') } }
    expect((await fhirAudienceBinding(['fhir-resource-server'], BASES_A, failing)).bound).toBe(false)
  })
})

describe('fhirAudienceBases', () => {
  it('names the route base, the resource indicator URL and the upstream base', () => {
    const bases = fhirAudienceBases({
      serverName: 'hapi-a',
      fhirVersion: 'R4',
      serverInfo: { identifier: 'hapi-a', url: `${UPSTREAM_A}/`, metadata: { fhirVersion: 'R4' } },
    })
    expect(bases).toContain(`${config.baseUrl}/${config.name}/hapi-a/R4`)
    expect(bases).toContain(UPSTREAM_A)
  })
})

describe('enforceFhirAudience', () => {
  afterEach(() => { delete process.env.FHIR_AUDIENCE_ENFORCEMENT })
  const foreign = { aud: BASE_B, azp: 'app' }

  it.serial('defaults to audit-only', () => {
    expect(getRuntimeAccessControlConfig().fhirAudienceEnforcement).toBe('audit-only')
  })

  it.serial('enforce refuses an unbound token with invalid_token', async () => {
    process.env.FHIR_AUDIENCE_ENFORCEMENT = 'enforce'
    const result = await enforceFhirAudience(foreign, BASES_A, 'hapi-a', RESOLVER)
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(401)
    expect(result.body?.error).toBe('invalid_token')
    expect((await enforceFhirAudience({ aud: BASE_A }, BASES_A, 'hapi-a', RESOLVER)).allowed).toBe(true)
  })

  it.serial('audit-only admits and logs exactly what enforce would refuse', async () => {
    process.env.FHIR_AUDIENCE_ENFORCEMENT = 'audit-only'
    const warn = spyOn(logger.fhir, 'warn')
    try {
      expect((await enforceFhirAudience(foreign, BASES_A, 'hapi-a', RESOLVER)).allowed).toBe(true)
      const logged = warn.mock.calls.find(([message]) => message === 'FHIR access token is not bound to this server')
      expect(logged?.[1]).toMatchObject({ server: 'hapi-a', aud: [BASE_B], azp: 'app', wouldDeny: true })
    } finally {
      warn.mockRestore()
    }
  })

  it.serial('disabled does not look at aud', async () => {
    process.env.FHIR_AUDIENCE_ENFORCEMENT = 'disabled'
    const untouched: ResourceAudienceResolver = { audienceFor: async () => { throw new Error('must not be called') } }
    expect((await enforceFhirAudience({ aud: 'account' }, BASES_A, 'hapi-a', untouched)).allowed).toBe(true)
  })
})
