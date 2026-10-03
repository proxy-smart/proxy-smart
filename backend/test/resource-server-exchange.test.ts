// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import {
  RESOURCE_URL_ATTR,
  isExchangeResourceServer,
  resourceServerAttribute,
  resourceServerRejection,
} from '../src/lib/resource-server-exchange'
import { buildCreatePlan, validateCreateRequest } from '../src/routes/admin/smart-apps/create-representation'

const SCRIBE = 'https://scribe.maxhealth.tech/mcp'
const JWKS = '{"keys":[{"kty":"EC","crv":"P-384","x":"x","y":"y","alg":"ES384"}]}'

describe('isExchangeResourceServer', () => {
  it('is a client whose id is its own https resource URL', () => {
    expect(isExchangeResourceServer({ clientId: SCRIBE, attributes: { [RESOURCE_URL_ATTR]: SCRIBE } })).toBe(true)
  })

  it('is not the proxy resource clients, whose id differs from their URL', () => {
    expect(isExchangeResourceServer({
      clientId: 'mcp-resource-server',
      attributes: { [RESOURCE_URL_ATTR]: 'https://api.proxy-smart.com/mcp' },
    })).toBe(false)
  })

  it('is not a URL client pointing at some other resource, or an unmarked one', () => {
    expect(isExchangeResourceServer({ clientId: SCRIBE, attributes: { [RESOURCE_URL_ATTR]: 'https://other.example/mcp' } })).toBe(false)
    expect(isExchangeResourceServer({ clientId: SCRIBE, attributes: {} })).toBe(false)
    expect(isExchangeResourceServer({ clientId: SCRIBE, attributes: { [RESOURCE_URL_ATTR]: '' } })).toBe(false)
  })

  it('is never an http URL', () => {
    const http = 'http://scribe.example/mcp'
    expect(isExchangeResourceServer({ clientId: http, attributes: { [RESOURCE_URL_ATTR]: http } })).toBe(false)
  })
})

describe('marking a client as a resource server', () => {
  it('sets resource_url to the client id, and clears it when unmarked', () => {
    expect(resourceServerAttribute(SCRIBE, true)).toEqual({ [RESOURCE_URL_ATTR]: SCRIBE })
    expect(resourceServerAttribute(SCRIBE, false)).toEqual({ [RESOURCE_URL_ATTR]: '' })
  })

  it('needs an https client id', () => {
    expect(resourceServerRejection(SCRIBE)).toBeNull()
    expect(resourceServerRejection('max-health-scribe')).not.toBeNull()
  })

  it('is refused at create for a plain client id, and written for a URL one', () => {
    const base = { name: 'Scribe', clientType: 'backend-service' as const, jwksString: JWKS, resourceServer: true }
    expect(validateCreateRequest({ ...base, clientId: 'max-health-scribe' })).not.toBeNull()
    expect(validateCreateRequest({ ...base, clientId: SCRIBE })).toBeNull()
    const attributes = new Map(Object.entries(buildCreatePlan({ ...base, clientId: SCRIBE }).representation.attributes ?? {}))
    expect(attributes.get(RESOURCE_URL_ATTR)).toBe(SCRIBE)
  })
})
