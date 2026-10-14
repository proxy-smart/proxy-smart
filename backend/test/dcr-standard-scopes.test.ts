/**
 * Unit tests for assignStandardOidcScopes — the baseline every client the backend provisions
 * gets, whatever it registered with.
 *
 * REGRESSION THIS GUARDS. Dynamic client registration used to attach the OIDC scopes only when
 * the registration request named them in its OPTIONAL RFC 7591 `scope` field. A client that
 * omitted it — legitimate, and what a client does when it intends to read the scopes out of the
 * resource metadata afterwards — ended up holding no OIDC scopes, while the MCP 401 challenge
 * told it to request `openid profile email`. Keycloak then rejected every authorize with
 * `invalid_scope` before the login page, which read as a broken server rather than a client
 * provisioned wrong. Observed against beta 2026-08-01 with claude.ai as the client.
 */
import { describe, it, expect } from 'bun:test'
import { assignStandardOidcScopes } from '../src/lib/smart-client-enrichment'
import { fakeKcAdmin } from './helpers/keycloak-admin'
import {
  KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  MCP_SCOPES_SUPPORTED,
  MCP_SCOPE_CHALLENGE,
  STANDARD_OIDC_DEFAULT_SCOPES,
  STANDARD_OIDC_OPTIONAL_SCOPES,
} from '../src/lib/oauth-scopes'

/** The scopes a realm built from realm-export.json actually has. */
const REALM_SCOPES = [
  ...KEYCLOAK_BUILTIN_DEFAULT_SCOPES,
  ...STANDARD_OIDC_DEFAULT_SCOPES,
  ...STANDARD_OIDC_OPTIONAL_SCOPES,
].map((name) => ({ id: `scope-${name}`, name }))

describe('assignStandardOidcScopes', () => {
  it('attaches the OIDC defaults without being asked for them', async () => {
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES })

    await assignStandardOidcScopes(kc.admin, 'client-uuid', 'my-client')

    for (const name of STANDARD_OIDC_DEFAULT_SCOPES) {
      expect(kc.defaultScopeNames()).toContain(name)
    }
  })

  it('still attaches Keycloak\'s silent claim scopes, which RBAC depends on', async () => {
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES })

    await assignStandardOidcScopes(kc.admin, 'client-uuid', 'my-client')

    for (const name of KEYCLOAK_BUILTIN_DEFAULT_SCOPES) {
      expect(kc.defaultScopeNames()).toContain(name)
    }
  })

  it('grants offline_access as optional, so a refresh token is asked for rather than issued', async () => {
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES })

    await assignStandardOidcScopes(kc.admin, 'client-uuid', 'my-client')

    expect(kc.optionalScopeNames()).toEqual([...STANDARD_OIDC_OPTIONAL_SCOPES])
    for (const name of STANDARD_OIDC_OPTIONAL_SCOPES) {
      expect(kc.defaultScopeNames()).not.toContain(name)
    }
  })

  it('reuses a provided scope list instead of re-fetching', async () => {
    const realmScopes = [{ id: 'scope-profile', name: 'profile' }]
    const { admin } = fakeKcAdmin()
    admin.clientScopes.find = async () => {
      throw new Error('should not be called')
    }

    await assignStandardOidcScopes(admin, 'client-uuid', 'my-client', realmScopes)
  })

  it('keeps going when one scope is missing from the realm', async () => {
    // `openid` is implicit in some realms. Its absence must not cost the client profile/email.
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES.filter((s) => s.name !== 'openid') })

    await assignStandardOidcScopes(kc.admin, 'client-uuid', 'my-client')

    expect(kc.defaultScopeNames()).toContain('profile')
    expect(kc.defaultScopeNames()).toContain('email')
    expect(kc.defaultScopeNames()).not.toContain('openid')
  })

  it('does not throw when Keycloak rejects an attachment', async () => {
    const { admin } = fakeKcAdmin({ realmScopes: REALM_SCOPES })
    admin.clients.addDefaultClientScope = async () => {
      throw new Error('keycloak said no')
    }
    admin.clients.addOptionalClientScope = async () => {
      throw new Error('keycloak said no')
    }

    expect(assignStandardOidcScopes(admin, 'client-uuid', 'my-client')).resolves.toBeUndefined()
  })

  it('does not throw when the realm scope list cannot be read', async () => {
    const { admin } = fakeKcAdmin()
    admin.clientScopes.find = async () => {
      throw new Error('keycloak unreachable')
    }

    expect(assignStandardOidcScopes(admin, 'client-uuid', 'my-client')).resolves.toBeUndefined()
  })
})

describe('advertised scopes are granted scopes', () => {
  it('grants everything the resource metadata advertises as supported', async () => {
    // The invariant the bug violated: RFC 9728 `scopes_supported` promised four scopes and DCR
    // granted none of them unless asked. Advertising a scope no client is given is how you get
    // an `invalid_scope` that looks like a server fault.
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES })

    await assignStandardOidcScopes(kc.admin, 'client-uuid', 'my-client')

    const granted = new Set([...kc.defaultScopeNames(), ...kc.optionalScopeNames()])
    for (const name of MCP_SCOPES_SUPPORTED) {
      expect(granted.has(name)).toBe(true)
    }
  })

  it('challenges only for scopes that are attached as defaults', async () => {
    // A challenge naming an optional scope would tell a client to request something it may
    // deliberately not hold.
    const attachedByDefault: readonly string[] = STANDARD_OIDC_DEFAULT_SCOPES
    for (const name of MCP_SCOPE_CHALLENGE.split(' ')) {
      expect(attachedByDefault).toContain(name)
    }
  })

  it('advertises the challenge as a subset of what is supported', () => {
    for (const name of MCP_SCOPE_CHALLENGE.split(' ')) {
      expect(MCP_SCOPES_SUPPORTED).toContain(name)
    }
  })

  it('never advertises a scope that depends on a per-user realm role', () => {
    // `offline_access` is role-gated in Keycloak. A client requests what the resource metadata
    // advertises, so listing it told every client to ask for something a user without the role
    // cannot be granted — and Keycloak fails the WHOLE code exchange rather than degrading:
    // "Offline tokens not allowed for the user or client", after a successful login.
    // Observed against beta 2026-08-01 with claude.ai; the code grant already returns an
    // ordinary refresh token without it, so advertising it bought nothing and broke users.
    expect(MCP_SCOPES_SUPPORTED).not.toContain('offline_access')
    for (const name of STANDARD_OIDC_OPTIONAL_SCOPES) {
      expect(MCP_SCOPES_SUPPORTED).not.toContain(name)
    }
  })

  it('still attaches the optional scopes to clients, so they remain requestable', async () => {
    // Not advertised is not the same as not available: a client that genuinely wants an offline
    // token can still ask, and gets the role check it deserves.
    const kc = fakeKcAdmin({ realmScopes: REALM_SCOPES })
    await assignStandardOidcScopes(kc.admin, 'client-uuid', 'my-client')
    expect(kc.optionalScopeNames()).toEqual([...STANDARD_OIDC_OPTIONAL_SCOPES])
  })
})
