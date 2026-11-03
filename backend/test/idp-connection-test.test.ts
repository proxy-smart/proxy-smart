// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { fakeFetch } from './helpers/fake-fetch'
import { testIdentityProviderConnection, type IdpConnectionTestDeps } from '../src/lib/idp-connection-test'

const ISSUER = 'https://idp.example.org/realms/hospital'

function deps(routes: Record<string, () => Response>, blocked: string[] = []): IdpConnectionTestDeps & { fetched: string[] } {
  const fetched: string[] = []
  return {
    fetched,
    timeoutMs: 1_000,
    checkUrl: async (url) => blocked.some((host) => url.includes(host)) ? { valid: false, reason: 'resolves to the non-public address 10.0.0.5' } : { valid: true },
    fetch: fakeFetch((url, init) => {
      fetched.push(url)
      expect(init?.redirect).toBe('manual')
      const route = routes[url]
      if (!route) throw new TypeError('fetch failed')
      return route()
    }),
  }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('testIdentityProviderConnection', () => {
  it('reads an OIDC provider\'s discovery document from its issuer', async () => {
    const d = deps({ [`${ISSUER}/.well-known/openid-configuration`]: json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth` }) })
    const result = await testIdentityProviderConnection({ alias: 'hospital', providerId: 'keycloak-oidc', config: { issuer: ISSUER, authorizationUrl: 'https://elsewhere.test/auth' } }, d)
    expect(result.status).toBe('reachable')
    expect(result.checks).toEqual([expect.objectContaining({ name: 'discovery', url: `${ISSUER}/.well-known/openid-configuration`, reachable: true, httpStatus: 200 })])
    expect(d.fetched).toEqual([`${ISSUER}/.well-known/openid-configuration`])
  })

  it('reports a discovery document that names another issuer', async () => {
    const d = deps({ [`${ISSUER}/.well-known/openid-configuration`]: json({ issuer: 'https://other.example.org' }) })
    const result = await testIdentityProviderConnection({ alias: 'hospital', providerId: 'oidc', config: { issuer: ISSUER } }, d)
    expect(result.status).toBe('unreachable')
    expect(result.checks[0]?.reason).toContain('https://other.example.org')
  })

  it('checks the endpoints of an OIDC provider without an issuer, counting any HTTP answer as reachable', async () => {
    const d = deps({
      'https://idp.example.org/auth': () => new Response('', { status: 302, headers: { location: 'https://idp.example.org/login' } }),
      'https://idp.example.org/token': () => new Response('', { status: 405 }),
    })
    const result = await testIdentityProviderConnection({ alias: 'a', providerId: 'oidc', config: { authorizationUrl: 'https://idp.example.org/auth', tokenUrl: 'https://idp.example.org/token' } }, d)
    expect(result.status).toBe('reachable')
    expect(result.checks.map((c) => [c.name, c.httpStatus])).toEqual([['authorization', 302], ['token', 405]])
  })

  it('reads SAML metadata and refuses a document that is not metadata', async () => {
    const metadata = 'https://saml.example.org/metadata'
    const ok = deps({ [metadata]: () => new Response('<md:EntityDescriptor entityID="x"/>', { status: 200 }) })
    expect((await testIdentityProviderConnection({ alias: 's', providerId: 'saml', config: { metadataDescriptorUrl: metadata } }, ok)).status).toBe('reachable')
    const wrong = deps({ [metadata]: () => new Response('<html>login</html>', { status: 200 }) })
    const result = await testIdentityProviderConnection({ alias: 's', providerId: 'saml', config: { metadataDescriptorUrl: metadata } }, wrong)
    expect(result.status).toBe('unreachable')
    expect(result.checks[0]?.reason).toContain('EntityDescriptor')
  })

  it('does not follow a redirect from a document URL', async () => {
    const d = deps({ [`${ISSUER}/.well-known/openid-configuration`]: () => new Response('', { status: 301, headers: { location: 'http://169.254.169.254/' } }) })
    const result = await testIdentityProviderConnection({ alias: 'h', providerId: 'oidc', config: { issuer: ISSUER } }, d)
    expect(result.status).toBe('unreachable')
    expect(d.fetched).toHaveLength(1)
  })

  it('never fetches a URL the outbound policy refuses', async () => {
    const d = deps({}, ['internal.corp'])
    const result = await testIdentityProviderConnection({ alias: 'i', providerId: 'oidc', config: { issuer: 'https://internal.corp/realms/x' } }, d)
    expect(result.status).toBe('unreachable')
    expect(result.checks[0]?.reason).toContain('non-public')
    expect(d.fetched).toEqual([])
  })

  it('reports a provider that does not answer', async () => {
    const result = await testIdentityProviderConnection({ alias: 'h', providerId: 'oidc', config: { issuer: ISSUER } }, deps({}))
    expect(result.status).toBe('unreachable')
    expect(result.checks[0]?.reason).toContain('fetch failed')
  })

  it('has nothing to test for a provider with built-in endpoints', async () => {
    const d = deps({})
    const result = await testIdentityProviderConnection({ alias: 'google', providerId: 'google', config: { clientId: 'x' } }, d)
    expect(result.status).toBe('untested')
    expect(result.checks).toEqual([])
    expect(d.fetched).toEqual([])
  })
})
