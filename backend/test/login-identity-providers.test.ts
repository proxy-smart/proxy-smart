// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import type IdentityProviderRepresentation from '@keycloak/keycloak-admin-client/lib/defs/identityProviderRepresentation.js'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()

let realmProviders: IdentityProviderRepresentation[] = []
let adminFailure: Error | null = null
let adminLookups = 0

function fakeAdmin(): KcAdminClient {
  const admin = new KcAdminClient({ baseUrl: 'http://127.0.0.1:9', realmName: 'test' })
  admin.identityProviders.find = async () => {
    adminLookups += 1
    if (adminFailure) throw adminFailure
    return realmProviders
  }
  return admin
}

mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => fakeAdmin(),
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

process.env.BASE_URL = 'http://localhost:8445'
process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
process.env.KEYCLOAK_REALM = 'smart-health'
process.env.SMART_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'

const { authRoutes } = await import('@/routes/auth')
const { createLoginIdentityProviders, loginIdentityProviders } = await import('@/lib/idp-login-options')

const google: IdentityProviderRepresentation = {
  alias: 'google',
  providerId: 'google',
  displayName: 'Google',
  enabled: true,
  internalId: 'internal-google',
  firstBrokerLoginFlowAlias: 'first broker login',
  storeToken: true,
  config: {
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    guiOrder: '2',
  },
}
const corporate: IdentityProviderRepresentation = {
  alias: 'corp-saml',
  providerId: 'saml',
  enabled: true,
  config: { signingCertificate: 'MIIC-secret-cert', singleSignOnServiceUrl: 'https://idp.corp.example/sso', guiOrder: '1' },
}
const disabled: IdentityProviderRepresentation = { alias: 'old-oidc', providerId: 'oidc', displayName: 'Old', enabled: false, config: {} }
const hiddenTopLevel: IdentityProviderRepresentation = { alias: 'proxy-smart-signing', providerId: 'oidc', enabled: true, hideOnLogin: true, config: {} }
const hiddenLegacyConfig: IdentityProviderRepresentation = { alias: 'legacy-hidden', providerId: 'oidc', enabled: true, config: { hideOnLoginPage: 'true' } }
const linkOnly: IdentityProviderRepresentation = { alias: 'link-only', providerId: 'github', enabled: true, linkOnly: true, config: {} }

const allProviders = [google, corporate, disabled, hiddenTopLevel, hiddenLegacyConfig, linkOnly]

async function fetchIdentityProviders(): Promise<{ status: number; body: unknown }> {
  const res = await authRoutes.handle(new Request('http://localhost:8445/auth/identity-providers'))
  return { status: res.status, body: await res.json() }
}

describe('GET /auth/identity-providers', () => {
  beforeEach(() => {
    realmProviders = allProviders
    adminFailure = null
    adminLookups = 0
    loginIdentityProviders.clear()
  })

  it('lists the enabled providers as login buttons, in the realm GUI order', async () => {
    const { status, body } = await fetchIdentityProviders()

    expect(status).toBe(200)
    expect(body).toEqual([
      { alias: 'corp-saml', providerId: 'saml', displayName: 'corp-saml', enabled: true },
      { alias: 'google', providerId: 'google', displayName: 'Google', enabled: true },
    ])
  })

  it('leaves out disabled, hidden and link-only providers', async () => {
    const { body } = await fetchIdentityProviders()
    const aliases = Array.isArray(body) ? body.map((p: { alias: string }) => p.alias) : []

    expect(aliases).not.toContain('old-oidc')
    expect(aliases).not.toContain('proxy-smart-signing')
    expect(aliases).not.toContain('legacy-hidden')
    expect(aliases).not.toContain('link-only')
  })

  it('exposes no configuration, secrets or internal ids', async () => {
    const { body } = await fetchIdentityProviders()
    const serialized = JSON.stringify(body)

    for (const leaked of ['google-client-id', 'google-client-secret', 'oauth2.googleapis.com', 'MIIC-secret-cert', 'idp.corp.example', 'internal-google', 'first broker login']) {
      expect(serialized).not.toContain(leaked)
    }
    for (const provider of Array.isArray(body) ? body : []) {
      expect(Object.keys(provider).sort()).toEqual(['alias', 'displayName', 'enabled', 'providerId'])
    }
  })

  it('answers an empty list when the Keycloak admin API fails', async () => {
    adminFailure = new Error('Keycloak admin token request failed: 401')

    const { status, body } = await fetchIdentityProviders()

    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('serves repeat requests from a short cache instead of the admin API', async () => {
    await fetchIdentityProviders()
    await fetchIdentityProviders()

    expect(adminLookups).toBe(1)
  })
})

describe('createLoginIdentityProviders', () => {
  beforeEach(() => {
    realmProviders = allProviders
    adminFailure = null
    adminLookups = 0
  })

  it('answers an empty list when no admin client is configured', async () => {
    const listing = createLoginIdentityProviders({ getAdmin: async () => null })

    expect(await listing.list()).toEqual([])
  })

  it('retries a failed lookup once the short failure window has passed', async () => {
    const listing = createLoginIdentityProviders({ getAdmin: async () => fakeAdmin(), ttlMs: 60_000, failureTtlMs: 0 })
    adminFailure = new Error('down')
    expect(await listing.list()).toEqual([])

    adminFailure = null
    expect((await listing.list()).map((p) => p.alias)).toEqual(['corp-saml', 'google'])
  })

  it('skips a provider without an alias or provider type, since no login button can name it', async () => {
    realmProviders = [{ providerId: 'oidc', enabled: true }, { alias: 'no-type', enabled: true }, google]
    const listing = createLoginIdentityProviders({ getAdmin: async () => fakeAdmin() })

    expect((await listing.list()).map((p) => p.alias)).toEqual(['google'])
  })
})
