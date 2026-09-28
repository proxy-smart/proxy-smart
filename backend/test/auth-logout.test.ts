// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * GET /auth/logout — sign-out must end the Keycloak session even when the server cannot.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'

mockLoggerModule()
mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

const kcLogoutCalls: string[] = []
mock.module('cross-fetch', () => ({
  default: async (url: string) => {
    kcLogoutCalls.push(String(url))
    return new Response(null, { status: 204 })
  },
}))

const adminLogouts: string[] = []
mock.module('@/lib/kc-admin-factory', () => ({
  getAdminClient: async () => ({ users: { logout: async ({ id }: { id: string }) => { adminLogouts.push(id) } } }),
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

process.env.BASE_URL = 'http://localhost:8445'
process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
process.env.KEYCLOAK_REALM = 'smart-health'
process.env.SMART_LAUNCH_SECRET = 'test-launch-secret-32-bytes-long!'

const { authRoutes } = await import('@/routes/auth')
const { smartStore } = await import('@/routes/auth/smart-proxy-setup')

const KC_END_SESSION = 'http://localhost:8080/realms/smart-health/protocol/openid-connect/logout'

async function logout(query = ''): Promise<string> {
  const res = await authRoutes.handle(new Request(`http://localhost:8445/auth/logout${query}`))
  expect(res.status).toBe(302)
  return res.headers.get('location') ?? ''
}

describe('GET /auth/logout', () => {
  beforeEach(() => {
    kcLogoutCalls.length = 0
    adminLogouts.length = 0
  })

  it('hands the browser to Keycloak when there is nothing to log out with server-side', async () => {
    expect(await logout()).toStartWith(KC_END_SESSION)
  })

  it('hands the browser to Keycloak when the launch session is already gone', async () => {
    // The error-page case: the button carries a state the store no longer holds.
    expect(await logout('?state=expired-session-key')).toStartWith(KC_END_SESSION)
    expect(adminLogouts).toEqual([])
  })

  it('ends the session through the admin API when the launch session knows the user', async () => {
    smartStore.set('live-key', {
      clientRedirectUri: 'https://app.example.com/callback',
      clientState: 's',
      clientId: 'patient-portal',
      scope: 'openid',
      userSub: 'user-123',
      createdAt: Date.now(),
    })

    const location = await logout('?state=live-key')

    expect(adminLogouts).toEqual(['user-123'])
    expect(location).not.toStartWith(KC_END_SESSION)
  })

  it('ends the session server-side with a usable id_token_hint', async () => {
    const hint = `${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(30)}`
    const location = await logout(`?id_token_hint=${hint}`)

    expect(kcLogoutCalls.some((url) => url.includes('id_token_hint='))).toBe(true)
    expect(location).not.toStartWith(KC_END_SESSION)
  })
})
