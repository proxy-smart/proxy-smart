/**
 * Additive User Role Assignment Tests
 *
 * Verifies the non-destructive role endpoints on /admin/healthcare-users:
 *  - POST   /:userId/realm-roles                 -> add realm roles (additive)
 *  - DELETE /:userId/realm-roles/:roleName       -> remove a single realm role
 *  - POST   /:userId/client-roles/:clientId      -> add client roles (additive)
 *  - DELETE /:userId/client-roles/:clientId/:roleName -> remove a single client role
 *
 * The mock admin client asserts that ADD uses addRealmRoleMappings/addClientRoleMappings
 * (which are additive in Keycloak) and never delRealmRoleMappings, so editing one role
 * cannot wipe the others.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'

// Mock the Keycloak plugin so the real route file gets our mock getAdmin.
let currentMockAdmin: ReturnType<typeof createMockAdmin>

mock.module('@/lib/keycloak-plugin', () => {
  // Lazily resolve Elysia here: a top-level import binding is still in the TDZ
  // when mock.module evaluates this factory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Elysia } = require('elysia')
  return {
    createAdminClient: async () => currentMockAdmin,
    keycloakPlugin: new Elysia().decorate('getAdmin', async () => currentMockAdmin),
  }
})

// Avoid noisy logs during tests. The logger is accessed both as logger.debug(...)
// (admin-utils) and logger.admin.debug(...) (routes), so every property access must
// resolve to something that is simultaneously callable AND further-indexable.
const noopLogger: unknown = new Proxy(function () {}, {
  get: () => noopLogger,
  apply: () => undefined,
})
mock.module('@/lib/logger', () => ({ logger: noopLogger }))

const ALL_REALM_ROLES = [
  { id: 'role-user', name: 'user' },
  { id: 'role-admin', name: 'admin' },
  { id: 'role-offline', name: 'offline_access' },
]

const ADMIN_UI_CLIENT = { id: 'client-admin-ui', clientId: 'admin-ui' }
const ADMIN_UI_ROLES = [
  { id: 'cr-admin', name: 'admin' },
  { id: 'cr-practitioner', name: 'practitioner' },
]

function createMockAdmin(overrides?: { userExists?: boolean }) {
  const userExists = overrides?.userExists ?? true
  return {
    users: {
      findOne: mock(async (_q: { id: string }) => (userExists ? { id: _q.id, username: 'jdoe' } : null)),
      addRealmRoleMappings: mock(async (_o: unknown) => {}),
      delRealmRoleMappings: mock(async (_o: unknown) => {}),
      addClientRoleMappings: mock(async (_o: unknown) => {}),
      delClientRoleMappings: mock(async (_o: unknown) => {}),
    },
    roles: {
      find: mock(async () => ALL_REALM_ROLES),
      findOneByName: mock(async ({ name }: { name: string }) => ALL_REALM_ROLES.find(r => r.name === name) ?? null),
    },
    clients: {
      find: mock(async ({ clientId }: { clientId: string }) => (clientId === 'admin-ui' ? [ADMIN_UI_CLIENT] : [])),
      listRoles: mock(async (_o: { id: string }) => ADMIN_UI_ROLES),
    },
  }
}

// Import AFTER mocks are registered.
const { healthcareUsersRoutes } = await import('../src/routes/admin/healthcare-users')
const { Elysia } = await import('elysia')

function buildApp() {
  return new Elysia().group('/admin', (app) => app.use(healthcareUsersRoutes))
}

const AUTH = { authorization: 'Bearer test-token' }

beforeEach(() => {
  currentMockAdmin = createMockAdmin()
})

describe('POST /:userId/realm-roles (additive)', () => {
  it('adds requested realm roles without removing existing ones', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/realm-roles', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['user'] }),
    }))
    expect(res.status).toBe(200)
    expect(currentMockAdmin.users.addRealmRoleMappings).toHaveBeenCalledTimes(1)
    // Critically: never removes roles.
    expect(currentMockAdmin.users.delRealmRoleMappings).not.toHaveBeenCalled()
    const call = currentMockAdmin.users.addRealmRoleMappings.mock.calls[0][0] as { roles: { name: string }[] }
    expect(call.roles.map(r => r.name)).toEqual(['user'])
  })

  it('returns 401 without a token', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/realm-roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['user'] }),
    }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user does not exist', async () => {
    currentMockAdmin = createMockAdmin({ userExists: false })
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/missing/realm-roles', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['user'] }),
    }))
    expect(res.status).toBe(404)
  })

  it('returns 404 when no requested role exists', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/realm-roles', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['does-not-exist'] }),
    }))
    expect(res.status).toBe(404)
    expect(currentMockAdmin.users.addRealmRoleMappings).not.toHaveBeenCalled()
  })
})

describe('DELETE /:userId/realm-roles/:roleName', () => {
  it('removes a single realm role', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/realm-roles/user', {
      method: 'DELETE',
      headers: AUTH,
    }))
    expect(res.status).toBe(200)
    expect(currentMockAdmin.users.delRealmRoleMappings).toHaveBeenCalledTimes(1)
    const call = currentMockAdmin.users.delRealmRoleMappings.mock.calls[0][0] as { roles: { name: string }[] }
    expect(call.roles.map(r => r.name)).toEqual(['user'])
  })

  it('returns 404 for an unknown role', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/realm-roles/ghost', {
      method: 'DELETE',
      headers: AUTH,
    }))
    expect(res.status).toBe(404)
  })
})

describe('POST /:userId/client-roles/:clientId (additive)', () => {
  it('adds requested client roles without removing existing ones', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/client-roles/admin-ui', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['practitioner'] }),
    }))
    expect(res.status).toBe(200)
    expect(currentMockAdmin.users.addClientRoleMappings).toHaveBeenCalledTimes(1)
    expect(currentMockAdmin.users.delClientRoleMappings).not.toHaveBeenCalled()
    const call = currentMockAdmin.users.addClientRoleMappings.mock.calls[0][0] as { roles: { name: string }[] }
    expect(call.roles.map(r => r.name)).toEqual(['practitioner'])
  })

  it('returns 404 for an unknown client', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/client-roles/nope', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['practitioner'] }),
    }))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /:userId/client-roles/:clientId/:roleName', () => {
  it('removes a single client role', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/client-roles/admin-ui/practitioner', {
      method: 'DELETE',
      headers: AUTH,
    }))
    expect(res.status).toBe(200)
    expect(currentMockAdmin.users.delClientRoleMappings).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for an unknown client role', async () => {
    const app = buildApp()
    const res = await app.handle(new Request('http://localhost/admin/healthcare-users/u1/client-roles/admin-ui/ghost', {
      method: 'DELETE',
      headers: AUTH,
    }))
    expect(res.status).toBe(404)
  })
})
