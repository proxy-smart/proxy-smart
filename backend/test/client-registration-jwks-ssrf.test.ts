// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * DCR jwks_uri SSRF — registration-layer (fail-closed) validation (security)
 *
 * VULN 2 (HIGH): SSRF via unvalidated DCR jwks_uri.
 *
 * The Dynamic Client Registration endpoint (POST /auth/register) stores a
 * client-supplied `jwks_uri` in Keycloak as the `jwks.url` attribute. That URL
 * is later fetched server-side during private_key_jwt assertion validation
 * (backend-services.ts → fetchJwksUrl). An attacker who registers a client with
 * `jwks_uri` pointing at an internal host (cloud metadata, RFC1918, link-local)
 * could turn the proxy into an SSRF probe.
 *
 * Per the agreed two-layer design, validation is enforced at BOTH:
 *   1. the fetch layer (defense in depth — backend-services.ts), and
 *   2. THIS registration layer (fail-closed — reject the registration outright,
 *      so the malicious URL is never even stored).
 *
 * These tests cover the registration layer: a jwks_uri on an internal/metadata
 * host must be REJECTED with an OAuth `invalid_client_metadata` error and the
 * client must NOT be created in Keycloak. A normal public https jwks_uri is
 * accepted and the client is created.
 *
 * The Keycloak admin client is mocked so no live Keycloak is required. We assert
 * on whether `clients.create` was invoked to prove the client was/wasn't stored.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mockLoggerModule } from './helpers/mock-logger'
import { Elysia } from 'elysia'

// ─── Test Constants ─────────────────────────────────────────────────────────

const TEST_BASE_URL = 'http://localhost:8445'
const TEST_REALM = 'smart-health'

const CONFIG_ENV_VARS = {
  BASE_URL: TEST_BASE_URL,
  KEYCLOAK_BASE_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: TEST_REALM,
  KEYCLOAK_ADMIN_CLIENT_ID: 'admin-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret',
} as const

// A localhost redirect classifies the client as confidential-but-not-backend,
// which DEFAULT_SETTINGS permits (allowConfidentialClients=true,
// allowBackendServices=false). This isolates the test so the ONLY difference
// between an accepted and a rejected registration is the jwks_uri SSRF check —
// not the client-type policy.
const REGISTERED_REDIRECT = 'http://localhost:3000/callback'
const METADATA_JWKS = 'http://169.254.169.254/latest/meta-data/'
const RFC1918_JWKS = 'http://10.0.0.5/jwks'
const PUBLIC_JWKS = 'https://issuer.example.com/jwks'

mockLoggerModule()

// ─── Keycloak admin client mock ─────────────────────────────────────────────
// Records whether clients.create was called so we can assert the client was
// (not) persisted. realms.findOne returns no attributes → handler falls back to
// DEFAULT_SETTINGS (registration enabled, confidential clients allowed).

let createCalls: unknown[] = []

class MockKcAdminClient {
  realms = {
    findOne: async () => ({ realm: TEST_REALM, attributes: {} }),
  }
  clients = {
    create: async (payload: unknown) => {
      createCalls.push(payload)
      return { id: 'created-client-uuid' }
    },
    find: async () => [],
    getClientSecret: async () => ({ value: 'secret' }),
    addDefaultClientScope: async () => {},
    addOptionalClientScope: async () => {},
  }
  clientScopes = {
    find: async () => [],
  }
  auth = async () => {}
  setConfig = () => {}
}

mock.module('@keycloak/keycloak-admin-client', () => ({
  default: MockKcAdminClient,
}))

// Avoid side effects from CORS refresh / scope mapper provisioning.
mock.module('@/lib/cors-origins', () => ({ refreshCorsOrigins: async () => {} }))
mock.module('@/lib/smart-scope-mappers', () => ({
  ensureScopeMappers: async () => {},
  SMART_SCOPE_MAPPERS: {},
}))

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { clientRegistrationRoutes } from '../src/routes/auth/client-registration'

// Mount under /auth so the handler path matches production (POST /auth/register).
const app = new Elysia({ prefix: '/auth' }).use(clientRegistrationRoutes)

interface RegistrationBody {
  redirect_uris: string[]
  client_name?: string
  jwks_uri?: string
}

async function register(body: RegistrationBody): Promise<Response> {
  return app.handle(new Request(`${TEST_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VULN 2 — DCR jwks_uri SSRF (registration layer, fail-closed)', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    createCalls = []
  })

  afterEach(() => {
    for (const key of Object.keys(CONFIG_ENV_VARS)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('rejects a jwks_uri pointing at the cloud metadata endpoint and does NOT create the client', async () => {
    const res = await register({
      redirect_uris: [REGISTERED_REDIRECT],
      client_name: 'evil-metadata',
      jwks_uri: METADATA_JWKS,
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('invalid_client_metadata')
    // The malicious URL must never have been persisted.
    expect(createCalls.length).toBe(0)
  })

  it('rejects a jwks_uri on an RFC1918 private host and does NOT create the client', async () => {
    const res = await register({
      redirect_uris: [REGISTERED_REDIRECT],
      client_name: 'evil-rfc1918',
      jwks_uri: RFC1918_JWKS,
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('invalid_client_metadata')
    expect(createCalls.length).toBe(0)
  })

  it('accepts a normal public https jwks_uri and creates the client', async () => {
    const res = await register({
      redirect_uris: [REGISTERED_REDIRECT],
      client_name: 'good-client',
      jwks_uri: PUBLIC_JWKS,
    })

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.client_id).toBeDefined()
    expect(data.jwks_uri).toBe(PUBLIC_JWKS)
    // The client WAS persisted with the public jwks.url.
    expect(createCalls.length).toBe(1)
    const created = createCalls[0] as { attributes?: Record<string, string> }
    expect(created.attributes?.['jwks.url']).toBe(PUBLIC_JWKS)
  })
})

/**
 * RFC 7591 3.2.1 fixes the success status at 201, and strict clients enforce it.
 * oauth4webapi rejects a 200 with "not a conform Dynamic Client Registration Endpoint
 * response", so AIHR's connector sign-in failed AFTER this endpoint had already created the
 * client — and registered a fresh one on every retry, leaving orphans behind.
 */
describe('DCR success status', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONFIG_ENV_VARS)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    createCalls.length = 0
  })

  afterEach(() => {
    for (const [key] of Object.entries(CONFIG_ENV_VARS)) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('answers a successful registration with 201, not 200', async () => {
    const res = await register({
      redirect_uris: [REGISTERED_REDIRECT],
      client_name: 'status-client',
    })

    expect(res.status).toBe(201)
    expect((await res.json()).client_id).toBeDefined()
  })
})
