// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { AuthorizeInterceptorDeps } from './authorize-interceptor'
import type { CallbackHandlerDeps } from './callback-handler'
import type { IdPAdapter } from './idp/interface'
import type { ILaunchContextStore } from './stores/interface'
import type { AuthorizeParams, LaunchSession, SmartProxyConfig } from './types'

/** RFC 7636 Appendix B: the S256 challenge of a known verifier. */
export const PKCE_VERIFIER = 'dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW1gFWFOEjXk'
export const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

export const PKCE_PARAMS = { code_challenge: PKCE_CHALLENGE, code_challenge_method: 'S256' }

export const TEST_BASE_URL = 'https://proxy.example.com'
export const TEST_LAUNCH_CODE_SECRET = 'test-secret-key-for-testing-only'
export const TEST_CLIENT_ID = 'smart-app-client'
export const TEST_REDIRECT_URI = 'https://app.example.com/callback'
export const TEST_CLIENT_STATE = 'client-state-123'
export const TEST_SCOPE = 'openid launch/patient patient/*.read'

const TEST_IDP_OIDC = 'https://kc.example.com/realms/test/protocol/openid-connect'
export const TEST_IDP_AUTHORIZE_URL = `${TEST_IDP_OIDC}/auth`

export const TEST_IDP: IdPAdapter = {
  getAuthorizationUrl: () => TEST_IDP_AUTHORIZE_URL,
  getTokenUrl: () => `${TEST_IDP_OIDC}/token`,
  getIntrospectionUrl: () => `${TEST_IDP_OIDC}/token/introspect`,
  getLogoutUrl: () => `${TEST_IDP_OIDC}/logout`,
}

export function testProxyConfig(overrides: Partial<SmartProxyConfig> = {}): SmartProxyConfig {
  return { baseUrl: TEST_BASE_URL, launchCodeSecret: TEST_LAUNCH_CODE_SECRET, ...overrides }
}

export function makeLaunchSession(overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    clientRedirectUri: TEST_REDIRECT_URI,
    clientState: TEST_CLIENT_STATE,
    clientId: TEST_CLIENT_ID,
    scope: TEST_SCOPE,
    createdAt: Date.now(),
    ...overrides,
  }
}

export function makeAuthorizeParams(overrides: AuthorizeParams = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: TEST_CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    scope: TEST_SCOPE,
    state: TEST_CLIENT_STATE,
    ...PKCE_PARAMS,
    ...overrides,
  }
}

export interface RedirectAllowlist {
  clientId?: string
  /** Registered redirect URIs of `clientId`; absent or null leaves the lookup unwired. */
  redirectUris?: string[] | null
}

function redirectLookup({ clientId = TEST_CLIENT_ID, redirectUris }: RedirectAllowlist): Pick<CallbackHandlerDeps, 'getRegisteredRedirectUris'> {
  if (!redirectUris) return {}
  return { getRegisteredRedirectUris: async (id: string) => (id === clientId ? redirectUris : []) }
}

export function makeAuthorizeDeps(
  store: ILaunchContextStore,
  { clientId, redirectUris, ...overrides }: RedirectAllowlist & Partial<Omit<AuthorizeInterceptorDeps, 'store'>> = {},
): AuthorizeInterceptorDeps {
  return { config: testProxyConfig(), store, idp: TEST_IDP, ...redirectLookup({ clientId, redirectUris }), ...overrides }
}

export function makeCallbackDeps(
  store: ILaunchContextStore,
  { clientId, redirectUris, ...overrides }: RedirectAllowlist & Partial<Omit<CallbackHandlerDeps, 'store'>> = {},
): CallbackHandlerDeps {
  return { config: testProxyConfig(), store, ...redirectLookup({ clientId, redirectUris }), ...overrides }
}
