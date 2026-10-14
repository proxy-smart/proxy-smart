// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * An OIDC identity provider must be creatable through the API.
 *
 * THE DEFECT THIS PINS. Keycloak requires clientId, clientSecret, authorizationUrl and
 * tokenUrl for an `oidc` provider. `IdentityProviderConfig` declared neither clientId
 * nor authorizationUrl, and Elysia STRIPS undeclared body properties instead of
 * rejecting them — so a caller that sent them anyway had them removed before the
 * handler ran, silently. Keycloak then answered 500 `{"error":"unknown_error"}`, which
 * the error handler passed through as the bare word `unknown_error`.
 *
 * The result was that no caller could create an OIDC broker: not the admin UI (whose
 * form had no inputs for either field), not the generated client, not the MCP tool.
 * It read as "the MCP is hard to use" because the model's calls kept failing, but the
 * fields it needed were absent from the advertised schema in the first place.
 *
 * `additionalConfig` looked like an escape hatch and was not one — Keycloak has no such
 * key, so anything nested under it was forwarded and ignored.
 */

import { describe, it, expect } from 'bun:test'
import { Elysia, t, type Context } from 'elysia'
import type { TSchema } from '@sinclair/typebox'
import { IdentityProviderConfig, CreateIdentityProviderRequest, UpdateIdentityProviderRequest } from '../src/schemas/admin/identity-providers'
import { missingConfigKeys, requiredConfigFor } from '../src/lib/idp-required-config'
import { handleAdminError } from '../src/lib/admin-error-handler'

/**
 * Echo whatever survived body validation, which is exactly what a route handler sees.
 * Built inline per call so Elysia's route-map generics stay inside this function.
 */
async function probe(schema: TSchema, body: unknown) {
  const app = new Elysia().post('/x', ({ body }) => body, { body: schema })
  await app.modules
  const res = await app.handle(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: await res.json().catch(() => null) }
}

const OIDC_CONFIG = {
  clientId: 'my-client',
  clientSecret: 's3cret',
  authorizationUrl: 'https://idp.example.com/authorize',
  tokenUrl: 'https://idp.example.com/token',
}

describe('IdentityProviderConfig reaches the handler intact', () => {
  it('keeps every key Keycloak requires for oidc', async () => {
    const { status, body } = await probe(t.Object({ config: IdentityProviderConfig }), { config: OIDC_CONFIG })

    expect(status).toBe(200)
    // Each of these was previously stripped or undeclared.
    expect(body.config.clientId).toBe('my-client')
    expect(body.config.authorizationUrl).toBe('https://idp.example.com/authorize')
    expect(body.config.clientSecret).toBe('s3cret')
    expect(body.config.tokenUrl).toBe('https://idp.example.com/token')
  })

  it('keeps the rest of what an OIDC broker actually needs', async () => {
    const { body } = await probe(t.Object({ config: IdentityProviderConfig }), {
      config: {
        ...OIDC_CONFIG,
        jwksUrl: 'https://idp.example.com/jwks',
        useJwksUrl: true,
        clientAuthMethod: 'client_secret_post',
        pkceEnabled: true,
        pkceMethod: 'S256',
        syncMode: 'FORCE',
      },
    })

    expect(body.config.jwksUrl).toBe('https://idp.example.com/jwks')
    expect(body.config.useJwksUrl).toBe(true)
    expect(body.config.clientAuthMethod).toBe('client_secret_post')
    expect(body.config.pkceEnabled).toBe(true)
    expect(body.config.pkceMethod).toBe('S256')
    expect(body.config.syncMode).toBe('FORCE')
  })

  it('passes through a provider-specific key it does not name', async () => {
    const { body } = await probe(t.Object({ config: IdentityProviderConfig }), {
      config: { ...OIDC_CONFIG, uiLocales: 'true', prompt: 'consent', allowedClockSkew: 30 },
    })

    expect(body.config.uiLocales).toBe('true')
    expect(body.config.prompt).toBe('consent')
    // Not string-only: a numeric key must not dead-end either.
    expect(body.config.allowedClockSkew).toBe(30)
  })

  it('rejects additionalConfig, which Keycloak errors on', async () => {
    // It was advertised as the escape hatch for unnamed keys and was the opposite:
    // Keycloak has no such key and answers unknown_error for create AND update.
    const { status } = await probe(t.Object({ config: IdentityProviderConfig }), {
      config: { ...OIDC_CONFIG, additionalConfig: { clientId: 'nested' } },
    })

    expect(status).toBe(422)
  })

  it('survives a full create request, not just the bare config', async () => {
    const { status, body } = await probe(CreateIdentityProviderRequest, {
      alias: 'my-idp',
      providerId: 'oidc',
      config: OIDC_CONFIG,
    })

    expect(status).toBe(200)
    expect(body.config.clientId).toBe('my-client')
    expect(body.config.authorizationUrl).toBe('https://idp.example.com/authorize')
  })

  it('survives an update request too', async () => {
    // The same closed object backed the update body, so update was broken identically.
    const { status, body } = await probe(UpdateIdentityProviderRequest, { config: { clientId: 'rotated', authorizationUrl: 'https://new/authorize' } })

    expect(status).toBe(200)
    expect(body.config.clientId).toBe('rotated')
    expect(body.config.authorizationUrl).toBe('https://new/authorize')
  })
})

describe('missingConfigKeys', () => {
  it('names what an oidc provider is missing instead of leaving it to Keycloak', () => {
    expect(missingConfigKeys('oidc', {})).toEqual([
      'clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl',
    ])
  })

  it('passes a complete oidc config', () => {
    expect(missingConfigKeys('oidc', OIDC_CONFIG)).toEqual([])
  })

  it('treats a blank value as missing, since Keycloak does', () => {
    expect(missingConfigKeys('oidc', { ...OIDC_CONFIG, clientId: '   ' })).toEqual(['clientId'])
  })

  it('does not ask private_key_jwt or none for a secret they do not have', () => {
    // Demanding one rejected the two strongest configurations: private_key_jwt signs with a key
    // pair, and none relies on PKCE. A live broker running clientAuthMethod: none could not be
    // re-registered through the API that manages it.
    for (const clientAuthMethod of ['private_key_jwt', 'none']) {
      const { clientSecret: _unused, ...noSecret } = OIDC_CONFIG
      expect(missingConfigKeys('oidc', { ...noSecret, clientAuthMethod })).toEqual([])
    }
  })

  it('still asks the secret-based methods for a secret', () => {
    const { clientSecret: _unused, ...noSecret } = OIDC_CONFIG
    for (const clientAuthMethod of ['client_secret_post', 'client_secret_basic', 'client_secret_jwt']) {
      expect(missingConfigKeys('oidc', { ...noSecret, clientAuthMethod })).toEqual(['clientSecret'])
    }
    // Unset means Keycloak's default, which is client_secret_post.
    expect(missingConfigKeys('oidc', noSecret)).toEqual(['clientSecret'])
  })

  it('asks a social provider only for credentials, since it ships its own endpoints', () => {
    expect(requiredConfigFor('google')).toEqual(['clientId', 'clientSecret'])
    expect(missingConfigKeys('google', { clientId: 'a', clientSecret: 'b' })).toEqual([])
  })

  it('asks saml for its SSO URL', () => {
    expect(missingConfigKeys('saml', {})).toEqual(['singleSignOnServiceUrl'])
  })

  it('leaves a provider type it does not know to Keycloak', () => {
    expect(requiredConfigFor('some-custom-broker')).toEqual([])
    expect(missingConfigKeys('some-custom-broker', {})).toEqual([])
  })
})

describe('Keycloak error detail surfacing', () => {
  function makeSet(): Context['set'] {
    return { headers: {}, status: undefined }
  }

  it('reports the description rather than the bare code', () => {
    const set = makeSet()
    const body = handleAdminError(
      {
        response: { status: 500 },
        responseData: { error: 'unknown_error', error_description: 'Could not resolve authorization endpoint' },
      },
      set,
    ) as { error: string; details?: string }

    expect(set.status).toBe(500)
    expect(body.details).toContain('Could not resolve authorization endpoint')
    // The old behaviour was this and nothing else.
    expect(body.details).not.toBe('unknown_error')
  })

  it('still says something useful when only a code came back', () => {
    const set = makeSet()
    const body = handleAdminError(
      { response: { status: 500 }, responseData: { error: 'unknown_error' } },
      set,
    ) as { error: string; details?: string }

    expect(body.details).toBe('unknown_error')
  })
})

describe('read and write must not drift apart', () => {
  /**
   * THE DRIFT THIS PINS. One resource's `config` was typed four ways in one file:
   * the read schemas (IdentityProvider, IdentityProviderResponse) used an open
   * Record<string, any>, while the write schemas (Create/Update) used a closed
   * object missing clientId and authorizationUrl.
   *
   * So the API was not round-trippable: a GET showed you a working provider's full
   * config, and POSTing that same object back silently dropped the keys that made
   * it work. Beta's broker looked perfect on read and was unreproducible on write.
   *
   * The mapper schemas in the same file use Record<string, string> on both sides
   * and never had the problem, which is what marks this as drift rather than design.
   */

  it('accepts on write everything the read side can return', () => {
    // Read is an open Record, so write must not be a closed object — that
    // asymmetry IS the bug, independent of which keys happen to be named today.
    const additional = (IdentityProviderConfig as { additionalProperties?: unknown }).additionalProperties
    expect(additional).toBeDefined()
  })

  it('round-trips a real Keycloak OIDC provider config unchanged', async () => {
    // Shaped after the working broker on beta, which was created by the CLI piping a
    // full Keycloak representation and so never passed through this schema.
    const asReadFromKeycloak = {
      clientId: 'maxhealth-broker',
      clientSecret: 'not-a-real-secret',
      authorizationUrl: 'https://login.maxhealth.tech/authorize',
      tokenUrl: 'https://login.maxhealth.tech/token',
      userInfoUrl: 'https://login.maxhealth.tech/userinfo',
      jwksUrl: 'https://login.maxhealth.tech/jwks',
      useJwksUrl: true,
      issuer: 'https://login.maxhealth.tech',
      defaultScopes: 'openid profile email',
      clientAuthMethod: 'client_secret_post',
      pkceEnabled: true,
      pkceMethod: 'S256',
      syncMode: 'FORCE',
      validateSignature: true,
    }

    const { status, body } = await probe(t.Object({ config: IdentityProviderConfig }), {
      config: asReadFromKeycloak,
    })

    expect(status).toBe(200)
    // Not a subset check: nothing may be dropped on the way through.
    expect(body.config).toEqual(asReadFromKeycloak)
  })
})
