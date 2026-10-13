// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { grantsFor } from '../src/routes/admin/smart-apps/client-config'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'

const MCP = 'https://mcp.example.com/mcp'
const JWKS = '{"keys":[{"kty":"EC","crv":"P-384","x":"x","y":"y","alg":"ES384"}]}'

describe('grants', () => {
  it('gives a backend service client_credentials and no login', () => {
    expect(grantsFor('backend-service')).toEqual({ publicClient: false, standardFlowEnabled: false, serviceAccountsEnabled: true })
  })

  it('gives a resource server no service account, since it only exchanges the tokens issued for it', () => {
    expect(grantsFor('backend-service', { resourceServer: true })).toEqual({ publicClient: false, standardFlowEnabled: false, serviceAccountsEnabled: false })
  })

  it('lets an explicit choice win either way', () => {
    expect(grantsFor('backend-service', { resourceServer: true, serviceAccount: true }).serviceAccountsEnabled).toBe(true)
    expect(grantsFor('backend-service', { serviceAccount: false }).serviceAccountsEnabled).toBe(false)
  })

  it('never gives a browser app a service account', () => {
    expect(grantsFor('public', { serviceAccount: true })).toEqual({ publicClient: true, standardFlowEnabled: true, serviceAccountsEnabled: false })
    expect(grantsFor('confidential')).toEqual({ publicClient: false, standardFlowEnabled: true, serviceAccountsEnabled: false })
  })
})

describe('creating an MCP resource server', () => {
  const server = { clientId: MCP, name: 'MCP server', appType: 'backend-service' as const, jwksString: JWKS, tokenEndpointAuthMethod: 'private_key_jwt' as const, resourceServer: true, tokenExchangeEnabled: true }

  it('is confidential with assertion auth and token exchange, with no service account and no login', () => {
    const { representation, clientAuthenticatorType } = buildCreatePlan(server)
    expect(representation.publicClient).toBe(false)
    expect(representation.serviceAccountsEnabled).toBe(false)
    expect(representation.standardFlowEnabled).toBe(false)
    expect(clientAuthenticatorType).toBe('federated-jwt')
    expect(new Map(Object.entries(representation.attributes ?? {})).get('standard.token.exchange.enabled')).toBe('true')
  })

  it('keeps the service account for an agent that reads as itself', () => {
    const { representation } = buildCreatePlan({ ...server, clientId: 'my-agent', appType: 'agent', resourceServer: undefined })
    expect(representation.serviceAccountsEnabled).toBe(true)
  })
})

describe('updating', () => {
  const resourceServer = {
    clientId: MCP,
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    redirectUris: [],
    attributes: { client_type: 'backend-service', resource_url: MCP, 'use.jwks.string': 'true' },
  }

  it('drops the service account of an existing resource server when asked', () => {
    expect(buildUpdateRepresentation({ serviceAccountsEnabled: false }, resourceServer).serviceAccountsEnabled).toBe(false)
  })

  it('drops it by default when the app type is set again on a resource server', () => {
    expect(buildUpdateRepresentation({ appType: 'backend-service' }, resourceServer).serviceAccountsEnabled).toBe(false)
  })

  it('leaves the grants alone when an update only renames', () => {
    const updated = buildUpdateRepresentation({ name: 'Renamed' }, resourceServer)
    expect(updated.serviceAccountsEnabled).toBe(true)
    expect(updated.redirectUris).toEqual([])
  })

  it('never gives a public client a service account', () => {
    const publicApp = { ...resourceServer, publicClient: true, serviceAccountsEnabled: false, standardFlowEnabled: true, attributes: {} }
    expect(buildUpdateRepresentation({ serviceAccountsEnabled: true }, publicApp).serviceAccountsEnabled).toBe(false)
  })
})
