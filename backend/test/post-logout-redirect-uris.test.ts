/**
 * Post-Logout Redirect URI Tests
 *
 * Verifies that `post.logout.redirect.uris` is correctly set to "+" in:
 * 1. Smart-apps create handler
 * 2. Smart-apps update handler (preserved or defaulted)
 * 3. ensurePostLogoutRedirectUris() startup repair function
 *
 * Keycloak 25+ requires this attribute for post-logout redirects to work.
 * "+" means "use the same URIs as Valid Redirect URIs".
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Elysia } from 'elysia'

// ---------------------------------------------------------------------------
// Mutable mock state — tests configure these before each run
// ---------------------------------------------------------------------------

let capturedCreatePayload: Record<string, unknown> | null = null
let _capturedUpdateQuery: Record<string, unknown> | null = null
let capturedUpdatePayload: Record<string, unknown> | null = null
let mockClientsList: Record<string, unknown>[] = []
let mockFindOneResult: Record<string, unknown> | null = null

// Track init-level update calls (routed when kcClientsFindResult is non-empty)
let kcClientsFindResult: Record<string, unknown>[] = []
let kcClientsUpdateCalls: Array<{ query: Record<string, unknown>; payload: Record<string, unknown> }> = []

// ---------------------------------------------------------------------------
// Module-level mocks — must be before imports that depend on them
// ---------------------------------------------------------------------------

// Mock validateToken so the real keycloakPlugin accepts our fake bearer token
const mockValidateToken = mock(async (_token: string) => ({
  sub: 'admin-user',
  preferred_username: 'admin',
  email: 'admin@test.com',
  realm_access: { roles: ['admin', 'manage-users'] },
  resource_access: {
    'admin-ui': { roles: ['admin'] },
    'realm-management': { roles: ['manage-clients', 'manage-users'] },
  },
}))

mock.module('../src/lib/auth', () => ({
  validateToken: mockValidateToken,
}))

// Mock KcAdminClient — used by both the keycloakPlugin (route tests) and
// ensurePostLogoutRedirectUris (init tests). The mock dispatches to different
// backing stores depending on whether kcClientsFindResult is set (init mode)
// or not (route mode).
mock.module('@keycloak/keycloak-admin-client', () => ({
  default: class MockKcAdminClient {
    constructor() {}
    setAccessToken(_token: string) {}
    async auth(_opts: Record<string, unknown>) {}
    clients = {
      create: async (payload: Record<string, unknown>) => {
        capturedCreatePayload = payload
        return { id: 'new-id' }
      },
      find: async (query?: Record<string, unknown>) => {
        if (kcClientsFindResult.length > 0) return kcClientsFindResult
        if (query?.clientId) return mockClientsList.filter((c) => c.clientId === query.clientId)
        return mockClientsList
      },
      findOne: async () => mockFindOneResult,
      update: async (query: Record<string, unknown>, payload: Record<string, unknown>) => {
        if (kcClientsFindResult.length > 0) {
          kcClientsUpdateCalls.push({ query, payload })
          return
        }
        _capturedUpdateQuery = query
        capturedUpdatePayload = payload
      },
      del: async () => {},
      addDefaultClientScope: async () => {},
      addOptionalClientScope: async () => {},
      delDefaultClientScope: async () => {},
      delOptionalClientScope: async () => {},
      getClientSecret: async () => ({ value: 'secret' }),
    }
    clientScopes = {
      find: async () => [
        { id: 'scope-openid', name: 'openid' },
        { id: 'scope-profile', name: 'profile' },
        { id: 'scope-email', name: 'email' },
        { id: 'scope-roles', name: 'roles' },
        { id: 'scope-web-origins', name: 'web-origins' },
        { id: 'scope-acr', name: 'acr' },
      ],
      findOne: async (q: Record<string, unknown>) => ({ id: q.id, name: q.id }),
    }
  },
}))

/*
 * ensurePostLogoutRedirectUris reaches Keycloak through kc-admin-factory, which
 * authenticates with its own fetch to the token endpoint rather than through
 * the npm client's auth() — so mocking the package alone leaves a real request
 * to localhost:8080. The factory is the seam for this, which is what it was
 * extracted for; the mock above still serves the keycloakPlugin route tests.
 */
mock.module('../src/lib/kc-admin-factory', () => ({
  getAdminClient: async () => {
    const { default: MockAdmin } = await import('@keycloak/keycloak-admin-client')
    return new MockAdmin()
  },
  invalidateAdminToken: () => {},
  resetAdminClient: () => {},
}))

// Import routes and init AFTER mocking
import { smartAppsRoutes } from '../src/routes/admin/smart-apps'
import { ensurePostLogoutRedirectUris } from '../src/init'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeKeycloakClient(opts: {
  id?: string
  clientId?: string
  attributes?: Record<string, unknown>
  publicClient?: boolean
}) {
  return {
    id: opts.id ?? 'kc-internal-id',
    clientId: opts.clientId ?? 'test-app',
    name: 'Test App',
    protocol: 'openid-connect',
    publicClient: opts.publicClient ?? true,
    bearerOnly: false,
    enabled: true,
    redirectUris: ['http://localhost:3000/callback'],
    webOrigins: ['http://localhost:3000'],
    attributes: opts.attributes ?? {},
    defaultClientScopes: ['scope-openid'],
    optionalClientScopes: [],
    serviceAccountsEnabled: false,
    standardFlowEnabled: true,
    clientAuthenticatorType: 'none',
  }
}

function bearerHeaders(token = 'test-token') {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function buildApp() {
  return new Elysia().use(smartAppsRoutes)
}

// ---------------------------------------------------------------------------
// 1. Smart-App Create — sets post.logout.redirect.uris
// ---------------------------------------------------------------------------

describe('Smart-Apps POST / — post.logout.redirect.uris on create', () => {
  beforeEach(() => {
    capturedCreatePayload = null
    capturedUpdatePayload = null
    kcClientsFindResult = [] // ensure route-mode, not init-mode
    mockClientsList = []
    mockFindOneResult = fakeKeycloakClient({
      id: 'new-id',
      clientId: 'my-smart-app',
      attributes: { smart_app: 'true', 'post.logout.redirect.uris': '+' },
    })
    mockValidateToken.mockClear()

    // Required for config.keycloak.isConfigured (checked by createAdminClient)
    process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
    process.env.KEYCLOAK_REALM = 'proxy-smart'
  })

  it('includes post.logout.redirect.uris: "+" in the Keycloak create payload', async () => {
    const app = buildApp()

    const res = await app.handle(
      new Request('http://localhost/smart-apps', {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({
          clientId: 'my-smart-app',
          name: 'My SMART App',
          redirectUris: ['http://localhost:3000/callback'],
        }),
      }),
    )

    expect(res.status).toBe(200)
    expect(capturedCreatePayload).not.toBeNull()
    const createAttrs = (capturedCreatePayload as Record<string, Record<string, string>>).attributes
    expect(createAttrs['post.logout.redirect.uris']).toBe('+')
  })

  it('sets post.logout.redirect.uris alongside PKCE config', async () => {
    const app = buildApp()

    const res = await app.handle(
      new Request('http://localhost/smart-apps', {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({
          clientId: 'pkce-app',
          name: 'PKCE App',
          requirePkce: true,
          redirectUris: ['http://localhost:3000/callback'],
        }),
      }),
    )

    expect(res.status).toBe(200)
    expect(capturedCreatePayload).not.toBeNull()
    const pkceAttrs = (capturedCreatePayload as Record<string, Record<string, string>>).attributes
    expect(pkceAttrs['post.logout.redirect.uris']).toBe('+')
    expect(pkceAttrs['pkce.code.challenge.method']).toBe('S256')
  })
})

// ---------------------------------------------------------------------------
// 2. Smart-App Update — preserves/defaults post.logout.redirect.uris
// ---------------------------------------------------------------------------

describe('Smart-Apps PUT /:clientId — post.logout.redirect.uris on update', () => {
  beforeEach(() => {
    capturedUpdatePayload = null
    _capturedUpdateQuery = null
    capturedCreatePayload = null
    kcClientsFindResult = [] // ensure route-mode
    mockValidateToken.mockClear()

    // Required for config.keycloak.isConfigured (checked by createAdminClient)
    process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
    process.env.KEYCLOAK_REALM = 'proxy-smart'
  })

  it('preserves existing post.logout.redirect.uris value on update', async () => {
    const existingClient = fakeKeycloakClient({
      id: 'existing-id',
      clientId: 'patient-portal',
      attributes: {
        smart_app: 'true',
        'post.logout.redirect.uris': '+',
        smart_version: '2.2.0',
      },
    })

    mockClientsList = [existingClient]
    mockFindOneResult = existingClient

    const app = buildApp()

    const res = await app.handle(
      new Request('http://localhost/smart-apps/patient-portal', {
        method: 'PUT',
        headers: bearerHeaders(),
        body: JSON.stringify({ name: 'Patient Portal Updated' }),
      }),
    )

    expect(res.status).toBe(200)
    expect(capturedUpdatePayload).not.toBeNull()
    const updateAttrs = (capturedUpdatePayload as Record<string, Record<string, string>>).attributes
    expect(updateAttrs['post.logout.redirect.uris']).toBe('+')
  })

  it('defaults post.logout.redirect.uris to "+" when existing client lacks it', async () => {
    const existingClient = fakeKeycloakClient({
      id: 'old-id',
      clientId: 'legacy-app',
      attributes: { smart_app: 'true' }, // no post.logout.redirect.uris
    })

    mockClientsList = [existingClient]
    mockFindOneResult = existingClient

    const app = buildApp()

    const res = await app.handle(
      new Request('http://localhost/smart-apps/legacy-app', {
        method: 'PUT',
        headers: bearerHeaders(),
        body: JSON.stringify({ name: 'Legacy App' }),
      }),
    )

    expect(res.status).toBe(200)
    expect(capturedUpdatePayload).not.toBeNull()
    const defaultAttrs = (capturedUpdatePayload as Record<string, Record<string, string>>).attributes
    expect(defaultAttrs['post.logout.redirect.uris']).toBe('+')
  })
})

// ---------------------------------------------------------------------------
// 3. ensurePostLogoutRedirectUris — startup repair function
// ---------------------------------------------------------------------------

describe('ensurePostLogoutRedirectUris — startup repair', () => {
  beforeEach(() => {
    kcClientsUpdateCalls = []
    kcClientsFindResult = []

    // Config reads env vars via getters, so setting process.env works
    process.env.KEYCLOAK_BASE_URL = 'http://localhost:8080'
    process.env.KEYCLOAK_REALM = 'proxy-smart'
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'admin-service'
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'admin-secret'
  })

  it('repairs clients missing post.logout.redirect.uris', async () => {
    kcClientsFindResult = [
      { id: 'id-1', clientId: 'my-app', attributes: { smart_app: 'true' } },
      { id: 'id-2', clientId: 'another-app', attributes: {} },
    ]

    await ensurePostLogoutRedirectUris()

    expect(kcClientsUpdateCalls.length).toBe(2)
    const attrs0 = (kcClientsUpdateCalls[0].payload as Record<string, Record<string, string>>).attributes
    const attrs1 = (kcClientsUpdateCalls[1].payload as Record<string, Record<string, string>>).attributes
    expect(attrs0['post.logout.redirect.uris']).toBe('+')
    expect(attrs1['post.logout.redirect.uris']).toBe('+')
  })

  it('skips internal Keycloak clients', async () => {
    kcClientsFindResult = [
      { id: 'id-account', clientId: 'account', attributes: {} },
      { id: 'id-admin-cli', clientId: 'admin-cli', attributes: {} },
      { id: 'id-broker', clientId: 'broker', attributes: {} },
      { id: 'id-realm', clientId: 'realm-management', attributes: {} },
      { id: 'id-sec', clientId: 'security-admin-console', attributes: {} },
      { id: 'id-acc-con', clientId: 'account-console', attributes: {} },
      { id: 'id-normal', clientId: 'patient-portal', attributes: {} },
    ]

    await ensurePostLogoutRedirectUris()

    expect(kcClientsUpdateCalls.length).toBe(1)
    expect(kcClientsUpdateCalls[0].query.id).toBe('id-normal')
  })

  it('no-ops when all clients already have the attribute', async () => {
    kcClientsFindResult = [
      { id: 'id-1', clientId: 'app-1', attributes: { 'post.logout.redirect.uris': '+' } },
      { id: 'id-2', clientId: 'app-2', attributes: { 'post.logout.redirect.uris': 'http://localhost/logout' } },
    ]

    await ensurePostLogoutRedirectUris()

    expect(kcClientsUpdateCalls.length).toBe(0)
  })

  it('skips clients without id or clientId', async () => {
    kcClientsFindResult = [
      { id: null, clientId: 'no-id', attributes: {} },
      { id: 'has-id', clientId: null, attributes: {} },
      { id: 'ok-id', clientId: 'ok-app', attributes: {} },
    ]

    await ensurePostLogoutRedirectUris()

    expect(kcClientsUpdateCalls.length).toBe(1)
    expect(kcClientsUpdateCalls[0].query.id).toBe('ok-id')
  })

  it('preserves existing attributes when repairing', async () => {
    kcClientsFindResult = [
      {
        id: 'id-1',
        clientId: 'my-app',
        attributes: {
          smart_app: 'true',
          'pkce.code.challenge.method': 'S256',
        },
      },
    ]

    await ensurePostLogoutRedirectUris()

    expect(kcClientsUpdateCalls.length).toBe(1)
    expect(kcClientsUpdateCalls[0].payload.attributes).toEqual({
      smart_app: 'true',
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': '+',
    })
  })

  it('silently skips when no admin credentials configured', async () => {
    delete process.env.KEYCLOAK_ADMIN_CLIENT_ID
    delete process.env.KEYCLOAK_ADMIN_CLIENT_SECRET

    await ensurePostLogoutRedirectUris()

    expect(kcClientsUpdateCalls.length).toBe(0)
  })
})
