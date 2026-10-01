/**
 * Admin Auth Guard — Structural Enforcement Tests (TDD, ITEM 1)
 *
 * Root cause being fixed: the `.guard()` on the admin router only sets OpenAPI
 * `security` METADATA — it enforces NO authentication. Auth historically depended
 * on each handler remembering to call validateAdminToken, and several did NOT:
 *
 *   - POST /admin/access-control/doors/:id/unlock fell through to provider.unlock()
 *     for non-UniFi providers with NO token check (door-unlock bypass).
 *   - GET /admin/access-control/{doors,members,...} called getAccessControl() with
 *     no auth at all (unauthenticated door-ID + member-email enumeration).
 *
 * These tests assert the SECURE behavior: a scoped `onBeforeHandle` on the admin
 * router enforces validateAdminToken BEFORE any admin handler runs:
 *   - missing/invalid token            → 401, handler/provider NOT reached
 *   - valid token lacking admin role   → 403, handler/provider NOT reached
 *   - valid admin token                → handler runs (no regression)
 *
 * Tokens are REAL RS256-signed JWTs verified against a locally-generated key
 * (jwks-rsa is mocked via the shared helper). This uses the real auth pipeline —
 * including the ITEM 2 audience binding — so admin tokens must carry the proxy
 * admin-client audience to be accepted. The access-control provider is mocked so
 * we can assert provider.unlock / getMembers is never invoked on a rejection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
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

// ── Mock the access-control provider plugin + factory ─────────────────────────
const unlockSpy = mock(async (id: string) => ({ message: `Unlocked ${id}` }))
const getMembersSpy = mock(async () => ({
  data: [{ id: 'mem-1', email: 'leak@example.com', name: 'Leaked Member', groupIds: [], enabled: true }],
  pagination: { offset: 0, limit: 100, count: 1 },
}))
const getDoorsSpy = mock(async () => ({
  data: [{ id: 'door-1', name: 'Secret Door', locationId: 'loc-1', online: true }],
  pagination: { offset: 0, limit: 100, count: 1 },
}))

const mockProvider = {
  name: 'kisi',
  displayName: 'Kisi',
  capabilities: { groups: true, members: true, sync: true, events: true, groupDoors: true, realtime: false },
  isHealthy: mock(async () => true),
  getLocations: mock(async () => ({ data: [], pagination: { offset: 0, limit: 100, count: 0 } })),
  getDoors: getDoorsSpy,
  getDoor: mock(async (id: string) => ({ id, name: 'Secret Door', locationId: 'loc-1', online: true })),
  unlock: unlockSpy,
  getMembers: getMembersSpy,
}

mock.module('../src/lib/access-control/plugin', () => ({
  accessControlPlugin: new Elysia({ name: 'access-control-plugin' })
    .decorate('getAccessControl', () => mockProvider),
  getAccessControlInstance: () => mockProvider,
  resetAccessControlPlugin: () => {},
}))

mock.module('../src/lib/access-control/factory', () => ({
  detectProvider: () => 'kisi',
  createProvider: () => mockProvider,
}))

// ── Import the REAL admin routes after mocks are installed ────────────────────
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
  unlockSpy.mockClear()
  getMembersSpy.mockClear()
  getDoorsSpy.mockClear()
})

describe('Admin auth guard — door unlock', () => {
  it('rejects unlock with NO Authorization header → 401 and never calls provider.unlock', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('POST', '/admin/access-control/doors/door-1/unlock'))
    expect(res.status).toBe(401)
    expect(unlockSpy).not.toHaveBeenCalled()
  })

  it('rejects unlock with a valid NON-admin token → 403 and never calls provider.unlock', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('POST', '/admin/access-control/doors/door-1/unlock', nonAdminToken()))
    expect(res.status).toBe(403)
    expect(unlockSpy).not.toHaveBeenCalled()
  })

  it('rejects unlock with an invalid token → 401 and never calls provider.unlock', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('POST', '/admin/access-control/doors/door-1/unlock', INVALID_TOKEN))
    expect(res.status).toBe(401)
    expect(unlockSpy).not.toHaveBeenCalled()
  })
})

describe('Admin auth guard — GET enumeration', () => {
  it('rejects GET /admin/access-control/members with no auth → 401 and never calls provider.getMembers', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('GET', '/admin/access-control/members'))
    expect(res.status).toBe(401)
    expect(getMembersSpy).not.toHaveBeenCalled()
  })

  it('rejects GET /admin/access-control/doors with no auth → 401 and never calls provider.getDoors', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('GET', '/admin/access-control/doors'))
    expect(res.status).toBe(401)
    expect(getDoorsSpy).not.toHaveBeenCalled()
  })

  it('rejects GET /admin/access-control/members with a valid NON-admin token → 403', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('GET', '/admin/access-control/members', nonAdminToken()))
    expect(res.status).toBe(403)
    expect(getMembersSpy).not.toHaveBeenCalled()
  })
})

describe('Admin auth guard — positive (no regression)', () => {
  it('allows GET /admin/access-control/members with a valid admin token → reaches handler', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('GET', '/admin/access-control/members', adminToken()))
    expect(res.status).toBe(200)
    expect(getMembersSpy).toHaveBeenCalledTimes(1)
  })

  it('allows POST unlock with a valid admin token → reaches provider.unlock', async () => {
    const app = createApp()
    const res = await app.handle(adminReq('POST', '/admin/access-control/doors/door-1/unlock', adminToken()))
    expect(res.status).toBe(200)
    expect(unlockSpy).toHaveBeenCalledTimes(1)
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
