// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import jwt from 'jsonwebtoken'

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'
const TEST_REALM = 'smart-health'
const REVOKE_URL = `${TEST_KC_BASE_URL}/realms/${TEST_REALM}/protocol/openid-connect/revoke`

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

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('@/lib/kc-session-resolver', () => ({
  autoResolvePatient: async () => null,
}))

interface KeycloakCall {
  url: string
  authorization: string | null
  params: URLSearchParams
}

interface KeycloakAnswer {
  status: number
  body: string
}

const calls: KeycloakCall[] = []
let answer: KeycloakAnswer = { status: 200, body: '' }

mock.module('cross-fetch', () => ({
  default: async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (!urlStr.endsWith('/protocol/openid-connect/revoke')) return new Response('{}', { status: 404 })
    calls.push({
      url: urlStr,
      authorization: new Headers(opts?.headers).get('authorization'),
      params: new URLSearchParams(opts?.body?.toString() ?? ''),
    })
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } })
  },
}))

import { authRoutes } from '../src/routes/auth'
import { tokenContextStore } from '../src/lib/token-context-store'
import { isTokenRevoked } from '../src/lib/revoked-tokens'

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ iss: `${TEST_KC_BASE_URL}/realms/${TEST_REALM}`, ...claims }, 'k', { expiresIn: '5m' })
const exp = () => Math.floor(Date.now() / 1000) + 300

function revoke(form: Record<string, string>, authorization?: string): Promise<Response> {
  return authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(authorization && { Authorization: authorization }),
    },
    body: new URLSearchParams(form).toString(),
  }))
}

describe('POST /auth/revoke (RFC 7009)', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    calls.length = 0
    answer = { status: 200, body: '' }
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('forwards to Keycloak with the client_secret_basic header unchanged', async () => {
    const token = sign({ jti: 'rev-basic' })
    const res = await revoke({ token, token_type_hint: 'access_token' }, basic('conf-app', 's3cret'))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(REVOKE_URL)
    expect(calls[0].authorization).toBe(basic('conf-app', 's3cret'))
    expect(calls[0].params.get('token')).toBe(token)
    expect(calls[0].params.get('token_type_hint')).toBe('access_token')
  })

  it('forwards client_secret_post credentials in the body', async () => {
    const res = await revoke({ token: sign({}), client_id: 'conf-app', client_secret: 's3cret' })

    expect(res.status).toBe(200)
    expect(calls[0].authorization).toBeNull()
    expect(calls[0].params.get('client_id')).toBe('conf-app')
    expect(calls[0].params.get('client_secret')).toBe('s3cret')
  })

  it('lets a public client revoke with only its client_id', async () => {
    const res = await revoke({ token: sign({}), client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(calls[0].params.get('client_id')).toBe('public-app')
  })

  it('refuses a request that names no client, without calling Keycloak', async () => {
    const res = await revoke({ token: sign({}) })

    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('invalid_client')
    expect(res.headers.get('www-authenticate')).toStartWith('Basic')
    expect(calls).toHaveLength(0)
  })

  it('refuses a request without a token, without calling Keycloak', async () => {
    const res = await revoke({ client_id: 'public-app' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
    expect(calls).toHaveLength(0)
  })

  it('refuses a client_assertion that does not verify, without calling Keycloak', async () => {
    const res = await revoke({
      token: sign({}),
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'not-a-jwt',
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_client')
    expect(calls).toHaveLength(0)
  })

  it('answers 200 when Keycloak reports the token as invalid', async () => {
    answer = { status: 200, body: JSON.stringify({ error: 'invalid_token', error_description: 'Invalid token' }) }

    const res = await revoke({ token: 'garbage', client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers 200 when Keycloak refuses the token itself with a 400 invalid_token', async () => {
    answer = { status: 400, body: JSON.stringify({ error: 'invalid_token' }) }

    const res = await revoke({ token: 'garbage', client_id: 'public-app' })

    expect(res.status).toBe(200)
  })

  it('passes a client authentication failure through', async () => {
    answer = { status: 401, body: JSON.stringify({ error: 'invalid_client', error_description: 'Invalid client credentials' }) }

    const res = await revoke({ token: sign({}) }, basic('conf-app', 'wrong'))

    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('invalid_client')
  })

  it('passes a refusal for a token issued to another client through', async () => {
    answer = { status: 400, body: JSON.stringify({ error: 'invalid_request', error_description: 'Unmatching clients' }) }

    const res = await revoke({ token: sign({}), client_id: 'public-app' })

    expect(res.status).toBe(400)
  })

  it('drops the launch context stored for a revoked access token', async () => {
    tokenContextStore.set('rev-ctx-1', { patient: 'p-1', clientId: 'public-app', exp: exp() })

    const res = await revoke({ token: sign({ jti: 'rev-ctx-1', azp: 'public-app' }), client_id: 'public-app' })

    expect(res.status).toBe(200)
    expect(tokenContextStore.get('rev-ctx-1')).toBeNull()
  })

  it('makes this proxy refuse the revoked access token from then on', async () => {
    await revoke({ token: sign({ jti: 'rev-deny-1' }), client_id: 'public-app' })

    expect(isTokenRevoked('rev-deny-1')).toBe(true)
  })

  it('does not mark a token Keycloak refused to revoke', async () => {
    answer = { status: 400, body: JSON.stringify({ error: 'invalid_request', error_description: 'Unmatching clients' }) }

    await revoke({ token: sign({ jti: 'rev-deny-2' }), client_id: 'other-app' })

    expect(isTokenRevoked('rev-deny-2')).toBe(false)
  })

  it('keeps the launch context when Keycloak refuses the revocation', async () => {
    answer = { status: 400, body: JSON.stringify({ error: 'invalid_request', error_description: 'Unmatching clients' }) }
    tokenContextStore.set('rev-ctx-2', { patient: 'p-2', clientId: 'owner-app', exp: exp() })

    await revoke({ token: sign({ jti: 'rev-ctx-2', azp: 'owner-app' }), client_id: 'other-app' })

    expect(tokenContextStore.get('rev-ctx-2')?.patient).toBe('p-2')
  })

  it('keeps the launch context bound to another client', async () => {
    tokenContextStore.set('rev-ctx-3', { patient: 'p-3', clientId: 'owner-app', exp: exp() })

    await revoke({ token: sign({ jti: 'rev-ctx-3' }) }, basic('other-app', 'x'))

    expect(tokenContextStore.get('rev-ctx-3')?.patient).toBe('p-3')
  })
})

describe('token context store delete', () => {
  it('removes an entry and reports whether one was there', () => {
    tokenContextStore.set('del-1', { patient: 'p-9', clientId: 'app', exp: exp() })

    expect(tokenContextStore.delete('del-1', 'app')).toBe(true)
    expect(tokenContextStore.get('del-1')).toBeNull()
    expect(tokenContextStore.delete('del-1', 'app')).toBe(false)
  })

  it('refuses to remove an entry bound to a different client', () => {
    tokenContextStore.set('del-2', { patient: 'p-9', clientId: 'app', exp: exp() })

    expect(tokenContextStore.delete('del-2', 'intruder')).toBe(false)
    expect(tokenContextStore.get('del-2')?.patient).toBe('p-9')
  })
})
