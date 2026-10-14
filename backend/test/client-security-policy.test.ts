// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect } from 'bun:test'
import { buildCreatePlan } from '../src/routes/admin/smart-apps/create-representation'
import { buildUpdateRepresentation } from '../src/routes/admin/smart-apps/update-representation'
import { buildDcrClient, redirectUriRejection } from '../src/routes/auth/dcr-client'
import type { ClientRegistrationSettingsType } from '../src/schemas'

const JWKS = '{"keys":[{"kty":"EC","crv":"P-384","x":"x","y":"y","kid":"k","alg":"ES384"}]}'
const PKCE = 'pkce.code.challenge.method'
const LIFESPAN = 'access.token.lifespan'

function attribute(representation: { attributes?: Record<string, unknown> }, key: string): unknown {
  return new Map(Object.entries(representation.attributes ?? {})).get(key)
}

const settings: ClientRegistrationSettingsType = {
  enabled: true,
  requireHttps: true,
  allowedScopes: ['openid', 'system/*.rs'],
  maxClientLifetime: 0,
  requireTermsOfService: false,
  requirePrivacyPolicy: false,
  allowPublicClients: true,
  allowConfidentialClients: true,
  allowBackendServices: true,
  adminApprovalRequired: false,
  requireConsent: true,
  rateLimitPerMinute: 10,
  maxRedirectUris: 5,
  allowedRedirectUriPatterns: ['https://.*'],
}

describe('admin API: backend-service access token lifetime', () => {
  const service = { clientId: 'svc', name: 'Service', appType: 'backend-service' as const, jwksString: JWKS }

  it('defaults a backend service to 300 seconds', () => {
    expect(attribute(buildCreatePlan(service).representation, LIFESPAN)).toBe('300')
  })

  it('keeps an explicit lifespan', () => {
    expect(attribute(buildCreatePlan({ ...service, accessTokenLifespan: 120 }).representation, LIFESPAN)).toBe('120')
  })

  it('leaves user-facing apps on the realm default', () => {
    expect(attribute(buildCreatePlan({ clientId: 'web', name: 'Web', appType: 'standalone-app', publicClient: true }).representation, LIFESPAN)).toBeUndefined()
  })

  it('gives a backend service the federated-jwt credential binding', () => {
    const { representation, clientAuthenticatorType } = buildCreatePlan(service)
    expect(clientAuthenticatorType).toBe('federated-jwt')
    expect(attribute(representation, 'jwt.credential.issuer')).toBe('proxy-smart-signing')
    expect(attribute(representation, 'jwt.credential.sub')).toBe('svc')
  })
})

describe('admin API: PKCE', () => {
  it('requires S256 for a new public app by default', () => {
    const plan = buildCreatePlan({ clientId: 'spa', name: 'SPA', appType: 'standalone-app', publicClient: true })
    expect(attribute(plan.representation, PKCE)).toBe('S256')
  })

  it('requires S256 for a new confidential app by default', () => {
    const plan = buildCreatePlan({ clientId: 'web', name: 'Web', appType: 'ehr-launch', publicClient: false })
    expect(attribute(plan.representation, PKCE)).toBe('S256')
  })

  it('lets the caller opt out explicitly', () => {
    const plan = buildCreatePlan({ clientId: 'spa', name: 'SPA', appType: 'standalone-app', publicClient: true, requirePkce: false })
    expect(attribute(plan.representation, PKCE)).toBeUndefined()
  })

  it('does not set PKCE on a backend service, which has no authorization code flow', () => {
    const plan = buildCreatePlan({ clientId: 'svc', name: 'Service', appType: 'backend-service', jwksString: JWKS })
    expect(attribute(plan.representation, PKCE)).toBeUndefined()
  })

  const existing = { clientId: 'spa', publicClient: true, standardFlowEnabled: true, attributes: { [PKCE]: 'S256', smart_app: 'true' } }

  it('lets an update clear PKCE', () => {
    expect(attribute(buildUpdateRepresentation({ requirePkce: false }, existing), PKCE)).toBe('')
  })

  it('lets an update set PKCE', () => {
    expect(attribute(buildUpdateRepresentation({ requirePkce: true }, { ...existing, attributes: {} }), PKCE)).toBe('S256')
  })

  it('leaves PKCE alone when the update does not mention it', () => {
    expect(attribute(buildUpdateRepresentation({ name: 'Renamed' }, existing), PKCE)).toBe('S256')
  })
})

describe('dynamic client registration: Keycloak representation', () => {
  const base = { clientId: 'smart_app_1', registrationTokenHash: 'hash', now: 1_700_000_000_000, settings }

  it('makes a backend service authenticate with federated-jwt, which accepts the proxy-signed assertion', () => {
    const { representation } = buildDcrClient({
      ...base,
      body: { redirect_uris: [], grant_types: ['client_credentials'], jwks_uri: 'https://svc.example.com/jwks.json' },
    })
    expect(representation.clientAuthenticatorType).toBe('federated-jwt')
    expect(attribute(representation, 'jwt.credential.issuer')).toBe('proxy-smart-signing')
    expect(attribute(representation, 'jwt.credential.sub')).toBe('smart_app_1')
    expect(attribute(representation, 'jwks.url')).toBe('https://svc.example.com/jwks.json')
    expect(representation.serviceAccountsEnabled).toBe(true)
    expect(representation.standardFlowEnabled).toBe(false)
    expect(representation.consentRequired).toBe(false)
    expect(representation.publicClient).toBe(false)
  })

  it('caps a backend service token at 300 seconds and skips PKCE', () => {
    const { representation } = buildDcrClient({
      ...base,
      body: { redirect_uris: [], grant_types: ['client_credentials'], jwks: { keys: [] } },
    })
    expect(attribute(representation, LIFESPAN)).toBe('300')
    expect(attribute(representation, PKCE)).toBeUndefined()
  })

  it('keeps the legacy classification: keys plus a non-loopback redirect is a backend service', () => {
    const { kind, representation } = buildDcrClient({
      ...base,
      body: { redirect_uris: ['https://svc.example.com/cb'], jwks_uri: 'https://svc.example.com/jwks.json' },
    })
    expect(kind).toBe('backend-service')
    expect(representation.clientAuthenticatorType).toBe('federated-jwt')
    expect(attribute(representation, 'jwt.credential.sub')).toBe('smart_app_1')
  })

  it('requires S256 PKCE for a public client and leaves its token lifetime to the realm', () => {
    const { kind, representation } = buildDcrClient({ ...base, body: { redirect_uris: ['https://app.example.com/cb'] } })
    expect(kind).toBe('public')
    expect(representation.clientAuthenticatorType).toBe('none')
    expect(attribute(representation, PKCE)).toBe('S256')
    expect(attribute(representation, LIFESPAN)).toBeUndefined()
  })

  it('binds a confidential user-facing client to the proxy signing IdP as well', () => {
    const { kind, representation } = buildDcrClient({
      ...base,
      body: { redirect_uris: ['http://localhost:3000/cb'], jwks: { keys: [] } },
    })
    expect(kind).toBe('confidential')
    expect(representation.clientAuthenticatorType).toBe('federated-jwt')
    expect(attribute(representation, 'jwt.credential.issuer')).toBe('proxy-smart-signing')
    expect(attribute(representation, PKCE)).toBe('S256')
  })
})

describe('dynamic client registration: redirect URIs', () => {
  it('accepts fixed https URIs and loopback http URIs', () => {
    expect(redirectUriRejection(['https://app.example.com/callback'], true)).toBeNull()
    expect(redirectUriRejection(['http://localhost:3000/cb', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb'], true)).toBeNull()
  })

  it('rejects wildcards anywhere', () => {
    expect(redirectUriRejection(['https://app.example.com/*'], true)).toContain('wildcard')
    expect(redirectUriRejection(['https://*.example.com/cb'], false)).toContain('wildcard')
  })

  it('rejects plain http on a non-loopback host', () => {
    expect(redirectUriRejection(['http://app.example.com/cb'], true)).toContain('https')
  })

  it('is not fooled by a host that merely starts with localhost', () => {
    expect(redirectUriRejection(['http://localhost.attacker.example/cb'], true)).toContain('https')
  })

  it('rejects a fragment and an unparseable URI', () => {
    expect(redirectUriRejection(['https://app.example.com/cb#frag'], true)).toContain('fragment')
    expect(redirectUriRejection(['not a uri'], true)).not.toBeNull()
  })
})
