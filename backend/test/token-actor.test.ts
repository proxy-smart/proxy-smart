// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

const { delegationActor, sanitizeActor, actorChain, MAX_ACTOR_DEPTH } = await import('../src/lib/token-actor')

describe('delegationActor', () => {
  it('names the exchanging client and nests the app that held the subject token', () => {
    expect(delegationActor('scribe', { azp: 'patient-portal', sub: 'u1' })).toEqual({
      client_id: 'scribe',
      act: { client_id: 'patient-portal' },
    })
  })

  it('keeps an existing chain instead of flattening it', () => {
    const prior = { client_id: 'scribe', act: { client_id: 'aihr' } }
    expect(delegationActor('summariser', { azp: 'scribe' }, prior)).toEqual({
      client_id: 'summariser',
      act: { client_id: 'scribe', act: { client_id: 'aihr' } },
    })
  })

  it('falls back to client_id when the subject token has no azp', () => {
    expect(delegationActor('scribe', { client_id: 'aihr' })?.act).toEqual({ client_id: 'aihr' })
  })

  it('refuses to invent an actor when the subject names no client', () => {
    expect(delegationActor('scribe', { sub: 'u1' })).toBeNull()
  })

  it('caps the chain depth', () => {
    let chain = { client_id: 'c0' }
    for (let i = 1; i < 20; i++) chain = delegationActor(`c${i}`, { azp: chain.client_id }, chain) ?? chain
    expect(actorChain(chain)).toHaveLength(MAX_ACTOR_DEPTH)
  })
})

describe('sanitizeActor', () => {
  it('drops malformed client ids and anything past the depth cap', () => {
    expect(sanitizeActor({ client_id: 'ok', act: { client_id: 'bad id<script>' } })).toEqual({ client_id: 'ok' })
    expect(sanitizeActor({ client_id: 42 })).toBeUndefined()
    expect(sanitizeActor('scribe')).toBeUndefined()
  })

  it('keeps https URL client ids, as CIMD clients and resource servers are named', () => {
    const scribe = 'https://scribe.maxhealth.tech/mcp'
    const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
    expect(delegationActor(scribe, { azp: claude })).toEqual({ client_id: scribe, act: { client_id: claude } })
  })

  it('refuses URL ids that are not https or carry markup', () => {
    expect(sanitizeActor({ client_id: 'http://scribe.example/mcp' })).toBeUndefined()
    expect(sanitizeActor({ client_id: 'https://x.example/"><script>' })).toBeUndefined()
    expect(sanitizeActor({ client_id: 'https://x.example/a b' })).toBeUndefined()
    expect(sanitizeActor({ client_id: 'javascript:alert(1)' })).toBeUndefined()
  })

  it('returns a copy that cannot be mutated through the input', () => {
    const input = { client_id: 'scribe', act: { client_id: 'patient-portal' } }
    const out = sanitizeActor(input)
    input.act.client_id = 'evil'
    expect(out?.act?.client_id).toBe('patient-portal')
  })
})

describe('actorChain', () => {
  it('lists the actors from the current one back to the origin', () => {
    expect(actorChain({ client_id: 'scribe', act: { client_id: 'patient-portal' } })).toEqual(['scribe', 'patient-portal'])
    expect(actorChain(undefined)).toEqual([])
  })
})
