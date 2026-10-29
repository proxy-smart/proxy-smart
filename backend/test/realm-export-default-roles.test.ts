// The default role composite is the single source of baseline roles; seeded users must not restate it.
import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel, type RealmExport } from './helpers/realm-exports'

/** Every realm export; deployed realms arrive via REALM_EXPORT_PATHS from proxy-smart-infra. */
const EXPORTS: { name: string; realm: RealmExport }[] = realmExportPaths().map((path) => ({
  name: realmExportLabel(path),
  realm: readRealmExport(path),
}))

// Resolved by name: under proxy-smart-infra's REALM_EXPORT_PATHS the dev export is absent and dev blocks skip.
const devExport = EXPORTS.find(({ name }) => name.endsWith('keycloak/realm-export.json'))
const HAS_DEV_EXPORT = devExport !== undefined
const realm: RealmExport = devExport?.realm ?? {}

const DEFAULT_ROLE = 'default-roles-proxy-smart'
const composite = realm.defaultRole?.composites?.realm ?? []
/** Users the import actually creates with roles; service accounts carry none. */
const seeded = (realm.users ?? []).filter((u) => u.realmRoles !== undefined)

describe.skipIf(!HAS_DEV_EXPORT)('realm default role composite', () => {
  it('is the realm default and grants offline_access', () => {
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
    // Without a max lifespan, an offline session refreshed once per idle window never expires.
    expect(settings.offlineSessionMaxLifespanEnabled).toBe(true)
    expect(typeof settings.offlineSessionMaxLifespan).toBe('number')
    expect(settings.offlineSessionMaxLifespan as number).toBeGreaterThan(0)
  })

  it('keeps the ceiling above the idle window, or it would expire sessions early', () => {
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
    // Keycloak expands composites into realm_access.roles, so each service checks only its own role.
    expect(admin?.composite).toBe(true)
    expect(admin?.composites?.realm).toContain('proxy-smart-admin')
  })

  it('grants only roles this export defines', () => {
    // Other products (e.g. llm-gateway) add their own roles to the live realm.
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
    // A realm import takes `realmRoles` literally.
    for (const user of seeded) {
      expect(user.realmRoles).toContain(DEFAULT_ROLE)
    }
  })

  it('never restate a role the composite already grants', () => {
    for (const user of seeded) {
      for (const role of user.realmRoles ?? []) {
        expect(composite).not.toContain(role)
      }
    }
  })

  it('keeps genuinely per-user roles, which are not in the composite', () => {
    const admin = seeded.find((u) => u.username === 'admin')
    expect(admin?.realmRoles).toContain('realm-admin')
  })
})

describe('every realm export agrees', () => {
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
      expect(settings.offlineSessionMaxLifespanEnabled).toBe(true)
    })

    it(`${name}: grants offline_access through the default composite`, () => {
      expect(r.defaultRole?.composites?.realm).toContain('offline_access')
    })
  }
})

describe('the initial administrator on a fresh deploy', () => {
  // Inert in this repo; proxy-smart-infra CI runs it via REALM_EXPORT_PATHS.
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
      // Authenticates via the maxhealth IdP; a seeded password would put the top credential in git.
      const admin = admins[0] as { credentials?: unknown[] } | undefined
      expect(admin?.credentials ?? []).toEqual([])
    })

    it(`${name}: gives that admin the default composite too`, () => {
      expect(admins[0]?.realmRoles).toContain('default-roles-proxy-smart')
    })

    it(`${name}: seeds no other human account`, () => {
      const humans = users.filter((u) => !(u.username ?? '').startsWith('service-account-'))
      expect(humans.map((u) => u.username)).toEqual([SOLE_ADMIN])
    })
  }
})
