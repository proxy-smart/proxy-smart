// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import { buildCreatePlan, validateCreateRequest } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'
import { KeyMaterialError } from '../src/routes/admin/smart-apps/key-material'

const JWKS = '{"keys":[{"kty":"EC","crv":"P-384","x":"x","y":"y","kid":"k","alg":"ES384"}]}'
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()

const existing = {
  clientId: 'svc',
  publicClient: false,
  serviceAccountsEnabled: true,
  standardFlowEnabled: false,
  attributes: { 'use.jwks.string': 'true', 'jwks.string': JWKS },
}

const attributesOf = (representation: { attributes?: Record<string, unknown> }) =>
  new Map(Object.entries(representation.attributes ?? {}))

describe('updating a SMART app key', () => {
  it('stores a new jwksUri and stops using the inline JWKS', () => {
    const updated = attributesOf(buildUpdateRepresentation({ jwksUri: 'https://svc.example.com/jwks', tokenEndpointAuthSigningAlg: 'ES256' }, existing))
    expect(updated.get('use.jwks.url')).toBe('true')
    expect(updated.get('jwks.url')).toBe('https://svc.example.com/jwks')
    expect(updated.get('use.jwks.string')).toBe('false')
    expect(updated.get('token.endpoint.auth.signing.alg')).toBe('ES256')
  })

  it('writes the jwksUri the same way create does', () => {
    const body = { jwksUri: 'https://svc.example.com/jwks', tokenEndpointAuthSigningAlg: 'ES256' as const }
    const created = attributesOf(buildCreatePlan({ clientId: 'svc', name: 'Service', appType: 'backend-service', ...body }).representation)
    const updated = attributesOf(buildUpdateRepresentation(body, existing))
    expect(updated.get('jwks.url')).toBe(created.get('jwks.url'))
    expect(updated.get('use.jwks.url')).toBe(created.get('use.jwks.url'))
  })

  it('converts a PEM key to an inline JWKS', () => {
    const updated = attributesOf(buildUpdateRepresentation({ publicKey: PEM }, { ...existing, attributes: { 'use.jwks.url': 'true', 'jwks.url': 'https://old' } }))
    expect(updated.get('use.jwks.string')).toBe('true')
    expect(updated.get('use.jwks.url')).toBe('false')
    expect(String(updated.get('jwks.string'))).toContain('"kty":"RSA"')
  })

  it('keeps the stored key when no key material is sent', () => {
    expect(attributesOf(buildUpdateRepresentation({ name: 'Renamed' }, existing)).get('jwks.string')).toBe(JWKS)
  })

  it('refuses a key that is not a PEM public key', () => {
    expect(() => buildUpdateRepresentation({ publicKey: 'not a key' }, existing)).toThrow(KeyMaterialError)
  })
})

describe('creating a SMART app with key material', () => {
  const base = { clientId: 'svc', name: 'Service', appType: 'backend-service' as const }

  it('refuses an inline JWKS without a keys array', () => {
    expect(validateCreateRequest({ ...base, jwksString: '{"kty":"RSA"}' })).toContain('keys array')
  })

  it('refuses a key that is not a PEM public key', () => {
    expect(validateCreateRequest({ ...base, publicKey: 'not a key' })).toContain('PEM')
  })

  it('accepts a valid PEM key', () => {
    expect(validateCreateRequest({ ...base, publicKey: PEM })).toBeNull()
  })
})
