// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { grantsFor } from '../src/routes/admin/smart-apps/client-config'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'

const MCP = 'https://mcp.example.com/mcp'
const JWKS = '{"keys":[{"kty":"EC","crv":"P-384","x":"x","y":"y","alg":"ES384"}]}'

function attribute(representation: { attributes?: Record<string, unknown> }, key: string): unknown {
  return new Map(Object.entries(representation.attributes ?? {})).get(key)
}

describe('grants', () => {
  it('gives a backend service, which acts as itself, client_credentials and no login', () => {
    expect(grantsFor('backend-service', { appType: 'backend-service' })).toEqual({ publicClient: false, standardFlowEnabled: false, serviceAccountsEnabled: true })
  })

  it('gives an agent, which only acts for a user, neither a login nor a service account', () => {
    expect(grantsFor('backend-service', { appType: 'agent' })).toEqual({ publicClient: false, standardFlowEnabled: false, serviceAccountsEnabled: false })
  })

  it('lets an explicit choice win either way', () => {
    expect(grantsFor('backend-service', { appType: 'agent', serviceAccount: true }).serviceAccountsEnabled).toBe(true)
    expect(grantsFor('backend-service', { appType: 'backend-service', serviceAccount: false }).serviceAccountsEnabled).toBe(false)
  })

  it('never gives a browser app a service account', () => {
    expect(grantsFor('public', { serviceAccount: true })).toEqual({ publicClient: true, standardFlowEnabled: true, serviceAccountsEnabled: false })
    expect(grantsFor('confidential')).toEqual({ publicClient: false, standardFlowEnabled: true, serviceAccountsEnabled: false })
  })
})

describe('creating', () => {
  const mcpAgent = { clientId: MCP, name: 'MCP server', appType: 'agent' as const, jwksString: JWKS, tokenEndpointAuthMethod: 'private_key_jwt' as const, resourceServer: true }

  it('makes an MCP agent confidential with assertion auth and token exchange, without a service account or login', () => {
    const { representation, clientAuthenticatorType } = buildCreatePlan(mcpAgent)
    expect(representation.publicClient).toBe(false)
    expect(representation.serviceAccountsEnabled).toBe(false)
    expect(representation.standardFlowEnabled).toBe(false)
    expect(clientAuthenticatorType).toBe('federated-jwt')
    expect(attribute(representation, 'standard.token.exchange.enabled')).toBe('true')
    expect(attribute(representation, 'resource_url')).toBe(MCP)
    expect(representation.redirectUris).toEqual([])
  })

  it('keeps token exchange off for an agent when asked', () => {
    expect(attribute(buildCreatePlan({ ...mcpAgent, tokenExchangeEnabled: false }).representation, 'standard.token.exchange.enabled')).toBe('false')
  })

  it('keeps the service account of a backend service, resource server or not, and does not switch exchange on for it', () => {
    const { representation } = buildCreatePlan({ ...mcpAgent, appType: 'backend-service' })
    expect(representation.serviceAccountsEnabled).toBe(true)
    expect(attribute(representation, 'standard.token.exchange.enabled')).toBeUndefined()
  })
})

describe('updating', () => {
  const backendService = {
    clientId: MCP,
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    redirectUris: [],
    attributes: { client_type: 'backend-service', resource_url: MCP, 'use.jwks.string': 'true' },
  }

  it('drops the service account when a backend service becomes an agent', () => {
    const updated = buildUpdateRepresentation({ appType: 'agent' }, backendService)
    expect(updated.serviceAccountsEnabled).toBe(false)
    expect(updated.standardFlowEnabled).toBe(false)
    expect(attribute(updated, 'client_type')).toBe('agent')
  })

  it('drops it on request without changing the type', () => {
    expect(buildUpdateRepresentation({ serviceAccountsEnabled: false }, backendService).serviceAccountsEnabled).toBe(false)
  })

  it('leaves the grants alone when an update only renames', () => {
    const agent = { ...backendService, serviceAccountsEnabled: false, attributes: { ...backendService.attributes, client_type: 'agent' } }
    const updated = buildUpdateRepresentation({ name: 'Renamed' }, agent)
    expect(updated.serviceAccountsEnabled).toBe(false)
    expect(updated.redirectUris).toEqual([])
  })

  it('never gives a public client a service account', () => {
    const publicApp = { ...backendService, publicClient: true, serviceAccountsEnabled: false, standardFlowEnabled: true, attributes: {} }
    expect(buildUpdateRepresentation({ serviceAccountsEnabled: true }, publicApp).serviceAccountsEnabled).toBe(false)
  })

  it('ignores the secret mask our reads hand out, and sets a real new secret', () => {
    expect(buildUpdateRepresentation({ secret: '**********' }, backendService).secret).toBeUndefined()
    expect(buildUpdateRepresentation({ secret: 'rotated' }, backendService).secret).toBe('rotated')
  })
})
