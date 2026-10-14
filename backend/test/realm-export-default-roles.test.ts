/**
 * Every seeded user must receive the realm's DEFAULT ROLE COMPOSITE, not a hand-written copy of
 * the roles inside it.
 *
 * THE BUG THIS GUARDS. `default-roles-proxy-smart` grants `offline_access` and `user`, but no
 * seeded user was assigned it — each declared explicit `realmRoles` instead, and a realm import
 * takes that list literally. `testuser` and `doctor` had `offline_access` hand-patched back in;
 * `admin` did not. So `admin` could log in and then fail the token exchange with
 * "Offline tokens not allowed for the user or client" — after a successful login, which reads as
 * a broken server. Reproduced against beta 2026-08-01: identical request, only the requested
 * scope differing, issues a token without `offline_access` and fails with it.
 *
 * Asserting "admin has offline_access" would have re-fixed the instance and left the shape
 * intact, so these assert the shape: the composite is the single source of baseline roles, and
 * nobody may restate its contents per-user.
 */
import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel, type RealmExport } from './helpers/realm-exports'



/**
 * EVERY realm export, not just the dev one.
 *
 * The Keycloak base image ships no realm; each environment layers its own on top, and the
 * deployed ones live in proxy-smart-infra. Checking only the dev export is how three files
 * drifted apart unnoticed: `proxy-smart-admin` and the `admin` composite existed in one of
 * them, and prod still had no offline-session ceiling. REALM_EXPORT_PATHS is what keeps the
 * deployed realms inside this net from the repository that now holds them.
 */
const EXPORTS: { name: string; realm: RealmExport }[] = realmExportPaths().map((path) => ({
  name: realmExportLabel(path),
  realm: readRealmExport(path),
}))

/**
 * The dev export, for assertions that are genuinely about dev seeding.
 *
 * Resolved by name rather than by position: when proxy-smart-infra runs these
 * assertions against its own realms via REALM_EXPORT_PATHS, this file is not in
 * the set, and index 0 would silently become beta. The blocks that depend on it
 * skip instead.
 */
const devExport = EXPORTS.find(({ name }) => name.endsWith('keycloak/realm-export.json'))
const HAS_DEV_EXPORT = devExport !== undefined
const realm: RealmExport = devExport?.realm ?? {}

const DEFAULT_ROLE = 'default-roles-proxy-smart'
const composite = realm.defaultRole?.composites?.realm ?? []
/** Users the import actually creates with roles; service accounts carry none. */
const seeded = (realm.users ?? []).filter((u) => u.realmRoles !== undefined)

describe.skipIf(!HAS_DEV_EXPORT)('realm default role composite', () => {
  it('is the realm default and grants offline_access', () => {
    // offline_access here is what lets ANY user obtain a refresh-token grant that Keycloak gates
    // on the role. Stock Keycloak ships it in this composite; dropping it breaks every client
    // that requests the scope, at the token exchange rather than at login.
    expect(realm.defaultRole?.name).toBe(DEFAULT_ROLE)
    expect(composite).toContain('offline_access')
    expect(composite).toContain('user')
  })

  it('defines every role the composite references', () => {
    const defined = new Set((realm.roles?.realm ?? []).map((r) => r.name))
    for (const role of composite) {
      expect(defined.has(role)).toBe(true)
    }
  })
})

describe.skipIf(!HAS_DEV_EXPORT)('offline session lifetime', () => {
  const settings = realm as unknown as Record<string, unknown>

  it('enforces a maximum lifespan, not only an idle timeout', () => {
    // The composite grants `offline_access`, so offline tokens ARE obtainable — verified against
    // beta, where `doctor` receives one. With max lifespan disabled, an offline session survives
    // indefinitely as long as it is used once per idle window, so a connector refreshing weekly
    // keeps access alive forever. A ceiling was already configured and simply not switched on.
    expect(settings.offlineSessionMaxLifespanEnabled).toBe(true)
    expect(typeof settings.offlineSessionMaxLifespan).toBe('number')
    expect(settings.offlineSessionMaxLifespan as number).toBeGreaterThan(0)
  })

  it('keeps the ceiling above the idle window, or it would expire sessions early', () => {
    // A max lifespan shorter than the idle timeout would cut sessions off before the idle rule
    // ever applied, making the idle setting meaningless and the behaviour hard to reason about.
    expect(settings.offlineSessionMaxLifespan as number).toBeGreaterThan(
      settings.offlineSessionIdleTimeout as number,
    )
  })
})

describe.skipIf(!HAS_DEV_EXPORT)('the generic admin role', () => {
  const admin = (realm.roles?.realm ?? []).find((r) => r.name === 'admin') as
    | { name?: string; composite?: boolean; composites?: { realm?: string[] } }
    | undefined

  it('is a composite that grants the per-product admin role', () => {
    // "Administrator of everything" belongs in Keycloak as composition, not re-encoded in each
    // service. Keycloak expands composites into the token's realm_access.roles — demonstrated by
    // its own `realm-admin`, whose constituents all appear alongside it — so a user granted
    // `admin` arrives carrying `proxy-smart-admin`, and each service can accept only its own role.
    expect(admin?.composite).toBe(true)
    expect(admin?.composites?.realm).toContain('proxy-smart-admin')
  })

  it('grants only roles this export defines', () => {
    // This export cannot know about other products' roles (llm-gateway's `gateway-admin` is in no
    // Proxy Smart export), so each repo contributes its own and the live realm accumulates them.
    const defined = new Set((realm.roles?.realm ?? []).map((r) => r.name))
    for (const role of admin?.composites?.realm ?? []) {
      expect(defined.has(role)).toBe(true)
    }
  })
})

describe.skipIf(!HAS_DEV_EXPORT)('seeded users', () => {
  it('exist, so the assertions below are not vacuous', () => {
    expect(seeded.length).toBeGreaterThan(0)
  })

  it('are all assigned the default composite', () => {
    // A realm import takes `realmRoles` literally — omitting this is how a user silently ends up
    // without the baseline every other user has.
    for (const user of seeded) {
      expect(user.realmRoles).toContain(DEFAULT_ROLE)
    }
  })

  it('never restate a role the composite already grants', () => {
    // The actual defect: `offline_access` copied onto two users and forgotten on the third. If
    // the composite is the source of truth, duplicating its contents per-user is how they drift.
    for (const user of seeded) {
      for (const role of user.realmRoles ?? []) {
        expect(composite).not.toContain(role)
      }
    }
  })

  it('keeps genuinely per-user roles, which are not in the composite', () => {
    // The rule above must not have been satisfied by flattening everyone to the same roles:
    // admin still carries its own elevated grants.
    const admin = seeded.find((u) => u.username === 'admin')
    expect(admin?.realmRoles).toContain('realm-admin')
  })
})

describe('every realm export agrees', () => {
  // Each environment layers its own realm onto the realm-less base image, so the deployed
  // file is what actually seeds beta and prod. Asserting only the dev export let three
  // files drift: two lacked `proxy-smart-admin` and the `admin` composite, and prod shipped with
  // offline sessions uncapped.
  for (const { name, realm: r } of EXPORTS) {
    const settings = r as unknown as Record<string, unknown>
    const realmRoles = r.roles?.realm ?? []
    const adminRole = realmRoles.find((x) => x.name === 'admin') as
      | { composite?: boolean; composites?: { realm?: string[] } }
      | undefined

    it(`${name}: defines proxy-smart-admin`, () => {
      expect(realmRoles.some((x) => x.name === 'proxy-smart-admin')).toBe(true)
    })

    it(`${name}: makes admin a composite granting the product role`, () => {
      expect(adminRole?.composite).toBe(true)
      expect(adminRole?.composites?.realm).toContain('proxy-smart-admin')
    })

    it(`${name}: caps offline sessions`, () => {
      // Uncapped offline sessions outlive every other control in the realm.
      expect(settings.offlineSessionMaxLifespanEnabled).toBe(true)
    })

    it(`${name}: grants offline_access through the default composite`, () => {
      expect(r.defaultRole?.composites?.realm).toContain('offline_access')
    })
  }
})

describe('the initial administrator on a fresh deploy', () => {
  // "beta and prod should not have another initial admin than max.nussbaumer@maxhealth.tech".
  // The dev export is excluded on purpose: CI and local development need the seeded `admin`,
  // `doctor` and `testuser` accounts, and that realm is never public.
  //
  // The deployed realms live in proxy-smart-infra, so in a plain checkout of this
  // repository there are none and this block is inert. That repo's CI runs these
  // same assertions with REALM_EXPORT_PATHS pointing at its realm/ directory,
  // which is where the coverage assertion below does its work.
  const DEPLOYED = EXPORTS.filter(({ name }) => !name.endsWith('keycloak/realm-export.json'))
  const SOLE_ADMIN = 'max.nussbaumer@maxhealth.tech'

  it.skipIf(DEPLOYED.length === 0)('covers both deployed environments', () => {
    expect(DEPLOYED).toHaveLength(2)
  })

  for (const { name, realm: r } of DEPLOYED) {
    const users = r.users ?? []
    const admins = users.filter((u) => (u.realmRoles ?? []).includes('admin'))

    it(`${name}: seeds exactly one administrator, and it is ${SOLE_ADMIN}`, () => {
      expect(admins.map((u) => u.username)).toEqual([SOLE_ADMIN])
    })

    it(`${name}: seeds that admin WITHOUT credentials`, () => {
      // They authenticate through the maxhealth IdP. A seeded password would be a credential
      // living in git for the single most privileged account in the realm — the exact shape of
      // the admin/admin problem this replaces.
      const admin = admins[0] as { credentials?: unknown[] } | undefined
      expect(admin?.credentials ?? []).toEqual([])
    })

    it(`${name}: gives that admin the default composite too`, () => {
      expect(admins[0]?.realmRoles).toContain('default-roles-proxy-smart')
    })

    it(`${name}: seeds no other human account`, () => {
      // Service accounts are machine identities defined by their client, not people.
      const humans = users.filter((u) => !(u.username ?? '').startsWith('service-account-'))
      expect(humans.map((u) => u.username)).toEqual([SOLE_ADMIN])
    })
  }
})
