// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * /admin/profile — the signed-in admin's own record.
 *
 * The property worth guarding is that the subject comes from the TOKEN and
 * nowhere else, so a body parameter can never redirect a read or write onto
 * another account.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'

let tokenSub: string | undefined = 'user-self'
let storedUsers: Record<string, Record<string, unknown>> = {}
let federatedFor: Record<string, unknown[]> = {}
const updates: { id: string; body: Record<string, unknown> }[] = []
const passwordResets: { id: string; value: string }[] = []
let resetShouldThrow: Error | null = null

// validateAdminToken, not validateToken: the route is an admin route, and the
// bare validator is fail-closed on audience, which 401'd every real admin token.
mock.module('../src/lib/auth', () => ({
  validateToken: mock(async () => ({ sub: tokenSub, realm_access: { roles: ['admin'] } })),
  validateAdminToken: mock(async () => ({ sub: tokenSub, realm_access: { roles: ['admin'] } })),
}))

const fakeAdmin = {
  users: {
    findOne: async ({ id }: { id: string }) => storedUsers[id] ?? null,
    update: async ({ id }: { id: string }, body: Record<string, unknown>) => {
      updates.push({ id, body })
      storedUsers[id] = { ...storedUsers[id], ...body }
    },
    resetPassword: async ({ id, credential }: { id: string; credential: { value: string } }) => {
      if (resetShouldThrow) throw resetShouldThrow
      passwordResets.push({ id, value: credential.value })
    },
    listFederatedIdentities: async ({ id }: { id: string }) => federatedFor[id] ?? [],
  },
}

// admin-utils stays real: admin-error-handler imports its error classes.
mock.module('../src/lib/keycloak-plugin', () => ({
  keycloakPlugin: new Elysia({ name: 'kc-stub' }).decorate('getAdmin', async () => fakeAdmin),
}))

const { profileAdminRoutes } = await import('../src/routes/admin/profile')

const app = () => new Elysia().use(profileAdminRoutes)

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

beforeEach(() => {
  tokenSub = 'user-self'
  storedUsers = {
    'user-self': {
      id: 'user-self',
      username: 'self',
      email: 'self@example.com',
      firstName: 'Self',
      lastName: 'User',
      emailVerified: true,
      attributes: { fhirUser: ['Practitioner/self'] },
    },
    'someone-else': { id: 'someone-else', username: 'victim', email: 'victim@example.com' },
  }
  federatedFor = {}
  updates.length = 0
  passwordResets.length = 0
  resetShouldThrow = null
})

describe('GET /profile', () => {
  it('returns the caller own profile', async () => {
    const res = await app().handle(req('GET', '/profile/', { token: 'valid' }))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.id).toBe('user-self')
    expect(body.fhirUser).toBe('Practitioner/self')
    expect(body.federated).toBe(false)
  })

  it('401s without a bearer token', async () => {
    const res = await app().handle(req('GET', '/profile/'))
    expect(res.status).toBe(401)
  })
})

describe('PUT /profile', () => {
  it('updates only the caller own record', async () => {
    const res = await app().handle(req('PUT', '/profile/', { token: 'valid', body: { firstName: 'Renamed' } }))
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('user-self')
  })

  it('ignores an id smuggled in the body', async () => {
    // The subject comes from the token; a body field must not redirect it.
    await app().handle(req('PUT', '/profile/', {
      token: 'valid',
      body: { firstName: 'Mallory', id: 'someone-else', userId: 'someone-else', sub: 'someone-else' },
    }))
    expect(updates.map(u => u.id)).toEqual(['user-self'])
    expect(storedUsers['someone-else'].firstName).toBeUndefined()
  })

  it('preserves fields that were not sent', async () => {
    await app().handle(req('PUT', '/profile/', { token: 'valid', body: { firstName: 'Only' } }))
    expect(updates[0].body.lastName).toBe('User')
    expect(updates[0].body.email).toBe('self@example.com')
  })

  it('clears emailVerified when the address changes', async () => {
    await app().handle(req('PUT', '/profile/', { token: 'valid', body: { email: 'new@example.com' } }))
    expect(updates[0].body.emailVerified).toBe(false)
  })

  it('keeps emailVerified when the address is unchanged', async () => {
    await app().handle(req('PUT', '/profile/', { token: 'valid', body: { email: 'self@example.com' } }))
    expect(updates[0].body.emailVerified).toBe(true)
  })
})

describe('PUT /profile/password', () => {
  it('sets a new password for the caller', async () => {
    const res = await app().handle(req('PUT', '/profile/password', { token: 'valid', body: { newPassword: 'a-long-enough-secret' } }))
    expect(res.status).toBe(200)
    expect(passwordResets).toEqual([{ id: 'user-self', value: 'a-long-enough-secret' }])
  })

  it('refuses a brokered account', async () => {
    // Nothing local to change — the password lives at the identity provider.
    federatedFor['user-self'] = [{ identityProvider: 'maxhealth' }]
    const res = await app().handle(req('PUT', '/profile/password', { token: 'valid', body: { newPassword: 'a-long-enough-secret' } }))
    expect(res.status).toBe(409)
    expect(passwordResets).toHaveLength(0)
  })

  it('rejects a password below the minimum length before reaching Keycloak', async () => {
    const res = await app().handle(req('PUT', '/profile/password', { token: 'valid', body: { newPassword: 'short' } }))
    expect(res.status).toBe(422)
    expect(passwordResets).toHaveLength(0)
  })

  it('401s without a bearer token', async () => {
    const res = await app().handle(req('PUT', '/profile/password', { body: { newPassword: 'a-long-enough-secret' } }))
    expect(res.status).toBe(401)
    expect(passwordResets).toHaveLength(0)
  })
})
