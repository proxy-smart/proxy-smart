// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * A missing GRANT must answer 403, never 401.
 *
 * THE DEFECT THIS PINS. Every admin route that touches Keycloak goes through
 * `createAdminClient`, which requires `realm-management` client roles on top of the
 * admin-role check the guard already made. That extra refusal was raised as an
 * `AuthenticationError`, and `handleAdminError` turned it into 401 with the fixed body
 * `{ error: 'Authorization header required' }` — for a request that carried a perfectly
 * good header. Clients refresh and retry on 401, so an admin holding `proxy-smart-admin`
 * but no realm-management role got an endless refresh/retry loop against
 * /admin/profile/ and /admin/smart-apps/, and a message naming the wrong cause.
 *
 * `AuthorizationError` was additionally not handled by `handleAdminError` at all, so had
 * the type simply been corrected first, the same case would have become a 500.
 */

import { describe, it, expect } from 'bun:test'
import type { Context } from 'elysia'
import { AuthenticationError, AuthorizationError } from '../src/lib/admin-utils'
import { handleAdminError } from '../src/lib/admin-error-handler'
import { hasAdminRole, KEYCLOAK_REALM_MANAGEMENT_CLIENT, PRODUCT_ADMIN_ROLE } from '../src/lib/admin-roles'

/** Elysia's mutable `set`, typed as the handler receives it — no assertion needed. */
function makeSet(): Context['set'] {
  return { headers: {}, status: undefined }
}

type ErrorBody = { error: string; details?: string }

describe('handleAdminError status semantics', () => {
  it('answers 403 for an insufficient grant', () => {
    const set = makeSet()
    const body = handleAdminError(
      new AuthorizationError('holds no realm-management client role'),
      set,
    ) as ErrorBody

    expect(set.status).toBe(403)
    expect(body.error).toBe('Forbidden')
    // The reason has to survive: it names the grant an operator must add.
    expect(body.details).toContain('realm-management')
  })

  it('does not fall through to 500 for an AuthorizationError', () => {
    const set = makeSet()
    handleAdminError(new AuthorizationError('nope'), set)
    expect(set.status).not.toBe(500)
  })

  it('answers 401 for a genuine authentication failure, carrying the real reason', () => {
    const set = makeSet()
    const body = handleAdminError(
      new AuthenticationError('Token has expired'),
      set,
    ) as ErrorBody

    expect(set.status).toBe(401)
    expect(body.details).toBe('Token has expired')
    // The old fixed answer blamed a header the caller had in fact sent.
    expect(body.details).not.toBe('Authorization header required')
  })

  it('names Keycloak as the rejecting party when Keycloak is the one refusing', () => {
    const set = makeSet()
    const body = handleAdminError(
      { response: { status: 403 } },
      set,
    ) as ErrorBody

    expect(set.status).toBe(403)
    expect(body.details).toContain('Keycloak')
  })

  it("passes Keycloak's own reason through when a 403 carries one", () => {
    const set = makeSet()
    const reason = 'This identity provider is not configured to allow granting admin roles via mappers.'
    const body = handleAdminError({ response: { status: 403 }, responseData: { errorMessage: reason } }, set)

    expect(set.status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden', details: reason })
  })

  it('still reports an unrecognised failure as 500', () => {
    const set = makeSet()
    handleAdminError(new Error('disk on fire'), set)
    expect(set.status).toBe(500)
  })
})

describe('the guard/admin-client policy gap this exposed', () => {
  it('admits a product admin who carries no realm-management role', () => {
    // Precisely the caller that used to loop: the guard says admin, so the request
    // reaches a route, and only then does the Keycloak client refuse it.
    const claims = { realm_access: { roles: [PRODUCT_ADMIN_ROLE] } }
    expect(hasAdminRole(claims)).toBe(true)
    expect(claims.realm_access.roles).not.toContain(KEYCLOAK_REALM_MANAGEMENT_CLIENT)
  })
})
