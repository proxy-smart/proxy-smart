// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import jwt from 'jsonwebtoken'

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'
const TEST_REALM = 'smart-health'
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'

const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: TEST_REALM,
  KEYCLOAK_PUBLIC_URL: TEST_KC_BASE_URL,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
  SMART_LAUNCH_SECRET: 'test-launch-secret-32-bytes-long!',
  FHIR_BASE_URL: 'http://localhost:8081/fhir',
  PROXY_NAME: 'fhir',
} as const

mockLoggerModule()

const loggedEvents: Record<string, unknown>[] = []
mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async (event: Record<string, unknown>) => { loggedEvents.push(event) } },
}))

mock.module('@/lib/auth', () => ({
  validateToken: async (token: string) => {
    const parts = token.split('.')
    if (parts.length === 3) return JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    throw new Error('invalid token')
  },
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, ...claims }, 'k', { expiresIn: '5m' })

let issued: Record<string, unknown> = {}
let kcStatus = 200

mock.module('cross-fetch', () => ({
  default: async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (urlStr.includes('/protocol/openid-connect/token')) {
      const body = kcStatus === 200
        ? { access_token: sign(issued), token_type: 'Bearer', expires_in: 300, scope: 'openid patient/Condition.rs' }
        : { error: 'invalid_request', error_description: 'Requester is not in the audience of the subject token' }
      return new Response(JSON.stringify(body), { status: kcStatus, headers: { 'content-type': 'application/json' } })
    }
    if (urlStr.includes('/certs')) return new Response(JSON.stringify({ keys: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  },
}))

import { authRoutes } from '../src/routes/auth'
import { tokenContextStore } from '../src/lib/token-context-store'

function exchange(subjectToken: string): Promise<Response> {
  return authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: EXCHANGE,
      client_id: 'max-health-scribe',
      client_secret: 's',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    }).toString(),
  }))
}

describe('token exchange records who acted for whom', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    loggedEvents.length = 0
    kcStatus = 200
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('stores the chain back to the portal and keeps the patient in context', async () => {
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-1' }
    const res = await exchange(sign({ sub: 'u1', azp: 'patient-portal', jti: 'portal-1', patient: '1005' }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.patient).toBe('1005')
    expect(tokenContextStore.get('scribe-1')).toMatchObject({
      patient: '1005',
      act: { client_id: 'max-health-scribe', act: { client_id: 'patient-portal' } },
    })
    expect(loggedEvents[loggedEvents.length - 1]?.actorChain).toEqual(['max-health-scribe', 'patient-portal'])
  })

  it('extends an existing chain when an exchanged token is exchanged again', async () => {
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-1b' }
    await exchange(sign({ sub: 'u1', azp: 'aihr', jti: 'aihr-1', patient: '1005' }))
    issued = { sub: 'u1', azp: 'summariser', jti: 'sum-1' }
    await exchange(sign({ sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-1b' }))

    expect(tokenContextStore.get('sum-1')?.act).toEqual({
      client_id: 'summariser',
      act: { client_id: 'max-health-scribe', act: { client_id: 'aihr' } },
    })
  })

  it('does not carry the patient over when the exchange changes the subject', async () => {
    issued = { sub: 'someone-else', azp: 'max-health-scribe', jti: 'scribe-2' }
    const res = await exchange(sign({ sub: 'u1', azp: 'patient-portal', jti: 'portal-2', patient: '1005' }))
    const data = await res.json()

    expect(data.patient).toBeUndefined()
    expect(tokenContextStore.get('scribe-2')?.patient).toBeUndefined()
    expect(tokenContextStore.get('scribe-2')?.act?.act?.client_id).toBe('patient-portal')
  })

  it('records nothing when Keycloak refuses the exchange', async () => {
    kcStatus = 400
    issued = { sub: 'u1', azp: 'max-health-scribe', jti: 'scribe-3' }
    const res = await exchange(sign({ sub: 'u1', azp: 'patient-portal', jti: 'portal-3' }))

    expect(res.status).toBe(400)
    expect(tokenContextStore.get('scribe-3')).toBeNull()
    expect(loggedEvents[loggedEvents.length - 1]?.actorChain).toBeUndefined()
  })
})
