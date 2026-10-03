/**
 * Who counts as an administrator — the policy previously hardcoded inside `validateAdminToken`.
 *
 * TWO DEFECTS THIS PINS.
 *
 * 1. The admin-UI client name was hardcoded as `'admin-ui'` in the ROLE lookup while the AUDIENCE
 *    check three lines above read `config.keycloak.adminUiClientId`. On any deployment overriding
 *    `KEYCLOAK_ADMIN_UI_CLIENT_ID` the two disagreed, so client roles went silently invisible.
 *
 * 2. The realm is shared — beta's `admin` carries `gateway-admin`, which belongs to llm-gateway
 *    and appears in no Proxy Smart export. A bare `admin` role therefore means "administrator of
 *    something", so the product needs a namespaced role of its own.
 *
 * The env-override tests matter beyond configurability: an empty or blank variable must fall back
 * to the defaults, because an empty role set locks every administrator out and the opposite
 * shortcut — empty meaning "allow anything" — would be a silent authorization bypass.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import {
  DEFAULT_ADMIN_CLIENT_ROLES,
  DEFAULT_ADMIN_REALM_ROLES,
  KEYCLOAK_REALM_MANAGEMENT_CLIENT,
  PRODUCT_ADMIN_ROLE,
  PRODUCT_AUDITOR_ROLE,
  adminClientRoles,
  adminRealmRoles,
  hasAdminAccess,
  hasAdminRole,
} from '../src/lib/admin-roles'

const REALM_ENV = 'KEYCLOAK_ADMIN_REALM_ROLES'
const CLIENT_ENV = 'KEYCLOAK_ADMIN_CLIENT_ROLES'
const UI_CLIENT_ENV = 'KEYCLOAK_ADMIN_UI_CLIENT_ID'

/** Restore the environment so these cases cannot leak into each other or into other suites. */
const saved = new Map<string, string | undefined>()
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

describe('the product admin role', () => {
  it('is namespaced to this product', () => {
    // Not `admin`: the realm is shared with other services' roles.
    expect(PRODUCT_ADMIN_ROLE).toBe('proxy-smart-admin')
  })

  it('is accepted as a realm role and as an admin-UI client role', () => {
    expect(DEFAULT_ADMIN_REALM_ROLES).toContain(PRODUCT_ADMIN_ROLE)
    expect(DEFAULT_ADMIN_CLIENT_ROLES).toContain(PRODUCT_ADMIN_ROLE)
    expect(hasAdminRole({ realm_access: { roles: [PRODUCT_ADMIN_ROLE] } })).toBe(true)
  })

  it('keeps the legacy roles during transition', () => {
    // Nobody holds proxy-smart-admin yet, and on beta the only working admin passes via the
    // realm-management branch. Shipping a narrower set would lock every environment out.
    for (const legacy of ['admin', 'realm-admin', 'manage-users', 'manage-realm']) {
      expect(hasAdminRole({ realm_access: { roles: [legacy] } })).toBe(true)
    }
  })
})

describe('hasAdminRole', () => {
  it('refuses a token with no admin-conferring role', () => {
    // The shape a brokered user has: baseline roles only.
    expect(hasAdminRole({ realm_access: { roles: ['user', 'offline_access'] } })).toBe(false)
    expect(hasAdminRole({})).toBe(false)
  })

  it('does not match a role that merely contains "admin"', () => {
    // Exact set membership, never substring — `gateway-admin` is another product's role and must
    // not confer admin here, however similar it looks.
    expect(hasAdminRole({ realm_access: { roles: ['gateway-admin'] } })).toBe(false)
    expect(hasAdminRole({ realm_access: { roles: ['not-admin-really'] } })).toBe(false)
  })

  it('reads admin-UI client roles from the CONFIGURED client id, not a hardcoded name', () => {
    // The original defect. With the ui client id overridden, roles under the OLD literal name
    // must no longer count, and roles under the configured name must.
    setEnv(UI_CLIENT_ENV, 'my-console')
    expect(hasAdminRole({ resource_access: { 'my-console': { roles: ['admin'] } } })).toBe(true)
    expect(hasAdminRole({ resource_access: { 'admin-ui': { roles: ['admin'] } } })).toBe(false)
  })

  it('counts only write-capable realm-management roles, so a read-only console role confers no write', () => {
    const management = (roles: string[]) => ({ resource_access: { [KEYCLOAK_REALM_MANAGEMENT_CLIENT]: { roles } } })
    expect(hasAdminRole(management(['view-users', 'view-identity-providers', 'query-clients']))).toBe(false)
    expect(hasAdminRole(management(['manage-users']))).toBe(true)
    expect(hasAdminRole(management(['realm-admin']))).toBe(true)
  })
})

describe('the auditor role', () => {
  it('is namespaced to this product', () => {
    expect(PRODUCT_AUDITOR_ROLE).toBe('proxy-smart-auditor')
  })

  it('reads, as a realm role or an admin-UI client role, and never writes', () => {
    for (const claims of [
      { realm_access: { roles: [PRODUCT_AUDITOR_ROLE] } },
      { resource_access: { 'admin-ui': { roles: [PRODUCT_AUDITOR_ROLE] } } },
    ]) {
      expect(hasAdminAccess(claims, 'read')).toBe(true)
      expect(hasAdminAccess(claims, 'write')).toBe(false)
      expect(hasAdminRole(claims)).toBe(false)
    }
  })

  it('leaves an administrator able to do both', () => {
    const admin = { realm_access: { roles: [PRODUCT_ADMIN_ROLE] } }
    expect(hasAdminAccess(admin, 'read')).toBe(true)
    expect(hasAdminAccess(admin, 'write')).toBe(true)
  })

  it('can be renamed per deployment', () => {
    setEnv('KEYCLOAK_AUDITOR_ROLES', 'ops-reader')
    expect(hasAdminAccess({ realm_access: { roles: ['ops-reader'] } }, 'read')).toBe(true)
    expect(hasAdminAccess({ realm_access: { roles: [PRODUCT_AUDITOR_ROLE] } }, 'read')).toBe(false)
  })
})

describe('env overrides', () => {
  it('replaces the defaults when set', () => {
    setEnv(REALM_ENV, 'only-this-role')
    expect([...adminRealmRoles()]).toEqual(['only-this-role'])
    expect(hasAdminRole({ realm_access: { roles: ['only-this-role'] } })).toBe(true)
    expect(hasAdminRole({ realm_access: { roles: ['admin'] } })).toBe(false)
  })

  it('trims whitespace and drops empty entries', () => {
    setEnv(CLIENT_ENV, ' a , , b ')
    expect([...adminClientRoles()]).toEqual(['a', 'b'])
  })

  it('falls back to the defaults on a blank value rather than locking everyone out', () => {
    for (const blank of ['', '   ', ',,']) {
      setEnv(REALM_ENV, blank)
      expect([...adminRealmRoles()]).toEqual([...DEFAULT_ADMIN_REALM_ROLES])
      // And specifically: still an admin, not locked out.
      expect(hasAdminRole({ realm_access: { roles: [PRODUCT_ADMIN_ROLE] } })).toBe(true)
    }
  })

  it('never treats a blank value as "allow anything"', () => {
    setEnv(REALM_ENV, '')
    expect(hasAdminRole({ realm_access: { roles: ['some-unrelated-role'] } })).toBe(false)
  })
})
