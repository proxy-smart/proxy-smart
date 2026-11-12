// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, test, expect } from 'bun:test'
import { handleAuthorize } from './authorize-interceptor'
import { KeycloakAdapter } from './idp/keycloak'
import { MemoryStore } from './stores/memory'
import { TEST_CLIENT_ID, TEST_IDP, makeAuthorizeDeps, makeAuthorizeParams, redirectOf } from './test-fixtures'

const KEYCLOAK = new KeycloakAdapter({ baseUrl: 'https://kc.example.com', realm: 'test' })
const signIn = (overrides = {}) => makeAuthorizeParams({ scope: 'openid profile', ...overrides })
const preferMaxHealth = async (clientId: string) => (clientId === TEST_CLIENT_ID ? 'maxhealth' : undefined)

async function idpRedirect(params = signIn(), overrides = {}): Promise<URL> {
  const { result } = await handleAuthorize(params, makeAuthorizeDeps(new MemoryStore(), {
    idp: KEYCLOAK,
    preferredIdentityProvider: preferMaxHealth,
    ...overrides,
  }))
  return redirectOf(result)
}

describe('a client with a preferred identity provider', () => {
  test('sends its users straight to that provider, keeping prompt=none for a silent sign-in', async () => {
    const url = await idpRedirect(signIn({ prompt: 'none' }))
    expect(url.searchParams.get('kc_idp_hint')).toBe('maxhealth')
    expect(url.searchParams.get('prompt')).toBe('none')
  })

  test('leaves a provider the app named itself alone', async () => {
    const url = await idpRedirect(signIn({ kc_idp_hint: 'clinic-sso' }))
    expect(url.searchParams.get('kc_idp_hint')).toBe('clinic-sso')
  })

  test('adds nothing for a client without one, or an IdP that brokers no others', async () => {
    expect((await idpRedirect(signIn({ client_id: 'other-app' }))).searchParams.has('kc_idp_hint')).toBe(false)
    expect((await idpRedirect(signIn(), { idp: TEST_IDP })).searchParams.has('kc_idp_hint')).toBe(false)
  })
})

describe('a client that requires an acr', () => {
  const requireGold = async (clientId: string) => (clientId === TEST_CLIENT_ID ? 'gold' : undefined)

  test('asks for it, keeping prompt=none for a silent sign-in', async () => {
    const url = await idpRedirect(signIn({ prompt: 'none' }), { requiredAcr: requireGold })
    expect(url.searchParams.get('acr_values')).toBe('gold')
    expect(url.searchParams.get('prompt')).toBe('none')
    expect(url.searchParams.get('kc_idp_hint')).toBe('maxhealth')
  })

  test('leaves acr_values the app sent itself alone', async () => {
    const url = await idpRedirect(signIn({ acr_values: 'silver' }), { requiredAcr: requireGold })
    expect(url.searchParams.get('acr_values')).toBe('silver')
  })

  test('asks for nothing for a client without one', async () => {
    const url = await idpRedirect(signIn({ client_id: 'other-app' }), { requiredAcr: requireGold })
    expect(url.searchParams.has('acr_values')).toBe(false)
  })
})
