// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Admin Auth Guard — structural enforcement tests.
 *
 * The admin router's `.guard()` only sets OpenAPI `security` metadata, so a scoped
 * `onBeforeHandle` must enforce validateAdminToken before any admin handler runs:
 *   - missing/invalid token            → 401, handler NOT reached
 *   - valid token lacking admin role   → 403, handler NOT reached
 *   - valid admin token                → handler runs (no regression)
 *
 * Tokens are real RS256 JWTs verified against a local key (the JWKS resolver is mocked via the
 * shared helper), so admin tokens must carry the admin-client audience. The DICOM
 * server list is the fixture: it reads runtime config only, so a spy proves whether
 * the handler ran.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'

// ── Shared JWKS mock + key (side-effect import BEFORE auth is imported) ────────
import { signTestToken } from './helpers/jwt-test-keys'

// ── Config env so issuer + audience resolve from real config ──────────────────
const KC_BASE = 'http://localhost:8080'
const REALM = 'proxy-smart'
const ISSUER = `${KC_BASE}/realms/${REALM}`
const ADMIN_CLIENT_ID = 'admin-ui'

const ENV: Record<string, string> = {
  KEYCLOAK_BASE_URL: KC_BASE,
  KEYCLOAK_PUBLIC_URL: KC_BASE,
  KEYCLOAK_REALM: REALM,
  KEYCLOAK_ADMIN_CLIENT_ID: ADMIN_CLIENT_ID,
  BASE_URL: 'http://localhost:8445',
}
const ENV_SNAPSHOT: Record<string, string | undefined> = {}

// ── Token fixtures (real, correctly-audienced RS256 JWTs) ─────────────────────
function adminToken(): string {
  return signTestToken({
    iss: ISSUER,
    sub: 'admin-user',
    aud: ADMIN_CLIENT_ID,
    azp: ADMIN_CLIENT_ID,
    realmRoles: ['admin'],
    clientRoles: { 'realm-management': ['manage-users'] },
    email: 'admin@example.com',
    preferred_username: 'admin',
  })
}

function nonAdminToken(): string {
  // Valid signature + correct admin-client audience, but NO admin role → 403.
  return signTestToken({
    iss: ISSUER,
    sub: 'patient-user',
    aud: ADMIN_CLIENT_ID,
    azp: ADMIN_CLIENT_ID,
    realmRoles: ['offline_access'],
    email: 'patient@example.com',
    preferred_username: 'patient',
  })
}

/**
 * What a signed-in end user actually holds: audienced to the proxy FHIR base, no admin role.
 * `validateToken`'s default audience set prefix-matches that base, so this token satisfied the
 * FHIR-server management routes back when they were mounted outside the admin router.
 */
function fhirAudiencedToken(): string {
  return signTestToken({
    iss: ISSUER,
    sub: 'patient-user',
    aud: 'http://localhost:8445/proxy-smart-backend/hapi-fhir-server/R4',
    azp: 'patient-portal',
    realmRoles: ['offline_access'],
    email: 'patient@example.com',
    preferred_username: 'patient',
  })
}

// Wrong-signature token → 401 (signed with a throwaway HS256 secret).
const INVALID_TOKEN = 'not.a.valid-jwt'

// ── Spy on the fixture handler's only dependency ──────────────────────────────
import * as runtimeConfig from '../src/lib/runtime-config'
const listDicomSpy = spyOn(runtimeConfig, 'getRuntimeDicomServers').mockImplementation(() => [])

// ── Import the REAL admin routes after the spy is installed ────────────────────
const { adminRoutes } = await import('../src/routes/admin')

// Scoped lifecycle hooks resolve only when mounted in a root Elysia instance,
// exactly as app-factory.ts does (`rootApp.use(adminRoutes)`).
function createApp() {
  return new Elysia().use(adminRoutes)
}

function adminReq(method: string, path: string, token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new Request(`http://localhost${path}`, { method, headers })
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    ENV_SNAPSHOT[k] = process.env[k]
    process.env[k] = v
  }
})

afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = ENV_SNAPSHOT[k]!
  }
})

beforeEach(() => {
  listDicomSpy.mockClear()
})

describe('Admin auth guard — rejections', () => {
  it('rejects a request with NO Authorization header → 401 and never reaches the handler', async () => {
    const res = await createApp().handle(adminReq('GET', '/admin/dicom-servers'))
    expect(res.status).toBe(401)
    expect(listDicomSpy).not.toHaveBeenCalled()
  })

  it('rejects an invalid token → 401 and never reaches the handler', async () => {
    const res = await createApp().handle(adminReq('GET', '/admin/dicom-servers', INVALID_TOKEN))
    expect(res.status).toBe(401)
    expect(listDicomSpy).not.toHaveBeenCalled()
  })

  it('rejects a valid NON-admin token → 403 and never reaches the handler', async () => {
    const res = await createApp().handle(adminReq('GET', '/admin/dicom-servers', nonAdminToken()))
    expect(res.status).toBe(403)
    expect(listDicomSpy).not.toHaveBeenCalled()
  })
})

describe('Admin auth guard — positive (no regression)', () => {
  it('allows a valid admin token → reaches the handler', async () => {
    const res = await createApp().handle(adminReq('GET', '/admin/dicom-servers', adminToken()))
    expect(res.status).toBe(200)
    expect(listDicomSpy).toHaveBeenCalledTimes(1)
  })
})

/**
 * FHIR server management used to sit outside the admin router, behind a bare `validateToken`.
 * Its default audience set prefix-matches the proxy FHIR base, so an ordinary SMART app token
 * passed — and nothing checked roles. Registering, repointing and deleting servers, and
 * uploading mTLS client certificates, were all reachable by any signed-in user.
 *
 * Only routes whose body schema is trivial or absent are exercised: Elysia validates the body
 * before the guard answers, so a bodyless PATCH is a 422 rather than a 401. The guard is one
 * `onBeforeHandle` over the whole router, so these three stand for all of them.
 */
describe('smart-config reconciliation is admin-only', () => {
  // These write to the realm — reconcile-resource-indicators creates clients,
  // scopes and audience mappers; reconcile-client-home-urls sets baseUrl on every
  // SMART client. Their handlers called plain validateToken, which authenticates
  // but checks no role, so the guard was the only thing enforcing admin. Pinned
  // here so a handler-level change cannot quietly become the sole gate again.
  const PATHS = [
    '/admin/smart-config/refresh',
    '/admin/smart-config/reconcile-resource-indicators',
    '/admin/smart-config/reconcile-client-home-urls',
  ]

  it.each(PATHS)('refuses POST %s with no token', async (path) => {
    const res = await createApp().handle(adminReq('POST', path))
    expect(res.status).toBe(401)
  })

  it.each(PATHS)('refuses POST %s with a valid NON-admin token', async (path) => {
    const res = await createApp().handle(adminReq('POST', path, nonAdminToken()))
    expect(res.status).toBe(403)
  })

  it.each(PATHS)('refuses POST %s with a FHIR-audienced end-user token', async (path) => {
    const res = await createApp().handle(adminReq('POST', path, fhirAudiencedToken()))
    expect([401, 403]).toContain(res.status)
  })
})

describe('FHIR server management is admin-only', () => {
  function req(method: string, path: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = {}
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    return new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  const CASES: [string, string, unknown][] = [
    ['PATCH', '/admin/fhir-servers/hapi-fhir-server/mcp', { enabled: true }],
    ['DELETE', '/admin/fhir-servers/hapi-fhir-server', undefined],
    ['GET', '/admin/fhir-servers/hapi-fhir-server/mtls', undefined],
  ]

  it.each(CASES)('refuses %s %s with no token', async (method, path, body) => {
    const res = await createApp().handle(req(method, path, undefined, body))
    expect(res.status).toBe(401)
  })

  it.each(CASES)('refuses %s %s with a FHIR-audienced end-user token', async (method, path, body) => {
    const res = await createApp().handle(req(method, path, fhirAudiencedToken(), body))
    expect([401, 403]).toContain(res.status)
  })

  it('no longer serves FHIR server management outside the admin router', async () => {
    const res = await createApp().handle(
      req('PATCH', '/fhir-servers/hapi-fhir-server/mcp', undefined, { enabled: true }),
    )
    expect(res.status).toBe(404)
  })
})
