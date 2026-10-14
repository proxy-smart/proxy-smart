// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { randomUUID } from 'crypto'
import { Elysia } from 'elysia'
import { mockLoggerModule } from './helpers/mock-logger'
import { mockKcAdminFactory } from './helpers/keycloak-admin'

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_KC_BASE_URL = 'http://localhost:8080'

const ENV = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: TEST_KC_BASE_URL,
  KEYCLOAK_REALM: 'smart-health',
  KEYCLOAK_PUBLIC_URL: TEST_KC_BASE_URL,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
  TRUSTED_PROXY_HOPS: '1',
  AUTH_RATE_LIMIT_PER_MINUTE: '2',
} as const

mockLoggerModule()
mockKcAdminFactory()

mock.module('@/lib/oauth-metrics-logger', () => ({
  oauthMetricsLogger: { logEvent: async () => {} },
}))

mock.module('@/lib/service-account-admin', () => ({
  getServiceAccountAdmin: async () => {
    throw new Error('no Keycloak in this test')
  },
}))

mock.module('cross-fetch', () => ({
  default: async () =>
    new Response(JSON.stringify({ access_token: 'opaque', token_type: 'Bearer', expires_in: 300 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
}))

import { authRoutes } from '../src/routes/auth'
import { rateLimit } from '../src/lib/rate-limit'

/** A fresh client address per test, so buckets never carry over between tests. */
const newClient = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`

function send(method: string, path: string, client: string, spoofed = '6.6.6.6'): Promise<Response> {
  return authRoutes.handle(new Request(`${TEST_BASE_URL}/auth/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': `${spoofed}, ${client}`,
    },
    ...(method === 'POST' && { body: new URLSearchParams({ grant_type: 'client_credentials' }).toString() }),
  }))
}

async function statuses(method: string, path: string, client: string, count: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push((await send(method, path, client)).status)
  return out
}

describe('rateLimit', () => {
  it('limits the route that declares it and no other', async () => {
    const app = new Elysia()
      .get('/limited', () => 'ok', { transform: rateLimit({ max: () => 1, keyFn: () => 'one-client' }) })
      .get('/open', () => 'ok')
    const get = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).status

    expect(await get('/limited')).toBe(200)
    expect(await get('/limited')).toBe(429)
    expect(await get('/open')).toBe(200)
    expect(await get('/open')).toBe(200)
  })

  it('opens a new window once the old one has passed', async () => {
    const app = new Elysia()
      .get('/limited', () => 'ok', { transform: rateLimit({ max: () => 1, windowMs: 20, keyFn: () => 'one-client' }) })
    const get = async () => (await app.handle(new Request('http://localhost/limited'))).status

    expect(await get()).toBe(200)
    expect(await get()).toBe(429)
    await Bun.sleep(30)
    expect(await get()).toBe(200)
  })
})

describe('/auth credential endpoints', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
  })

  afterEach(() => {
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  for (const [method, path] of [
    ['POST', 'token'],
    ['POST', 'introspect'],
    ['POST', 'register'],
    ['POST', 'device'],
  ] as const) {
    it(`answers 429 on ${method} /auth/${path} once a client exceeds AUTH_RATE_LIMIT_PER_MINUTE`, async () => {
      const client = newClient()
      const results = await statuses(method, path, client, 3)

      expect(results.slice(0, 2)).not.toContain(429)
      expect(results[2]).toBe(429)
    })
  }

  it('sends Retry-After and the limit headers with a 429', async () => {
    const client = newClient()
    await statuses('POST', 'token', client, 2)
    const res = await send('POST', 'token', client)

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(res.headers.get('x-ratelimit-limit')).toBe('2')
    expect((await res.json()).error).toBe('too_many_requests')
  })

  it('keys on the trusted hop, so rotating the client-supplied X-Forwarded-For prefix does not reset the budget', async () => {
    const client = newClient()
    const results: number[] = []
    for (const spoofed of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      results.push((await send('POST', 'token', client, spoofed)).status)
    }

    expect(results[2]).toBe(429)
  })

  it('counts each client separately', async () => {
    const first = newClient()
    await statuses('POST', 'token', first, 3)

    expect((await send('POST', 'token', newClient())).status).not.toBe(429)
  })

  it('counts each endpoint separately for the same client', async () => {
    const client = newClient()
    await statuses('POST', 'token', client, 3)

    expect((await send('POST', 'introspect', client)).status).not.toBe(429)
  })

  it('leaves the other /auth routes alone', async () => {
    const results = await statuses('GET', 'userinfo', newClient(), 4)

    expect(results).not.toContain(429)
  })

  it('is off when AUTH_RATE_LIMIT_PER_MINUTE is unset', async () => {
    delete process.env.AUTH_RATE_LIMIT_PER_MINUTE
    const results = await statuses('POST', 'token', newClient(), 5)

    expect(results).not.toContain(429)
  })

  it('is off when AUTH_RATE_LIMIT_PER_MINUTE is 0', async () => {
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = '0'
    const results = await statuses('POST', 'token', newClient(), 5)

    expect(results).not.toContain(429)
  })
})
