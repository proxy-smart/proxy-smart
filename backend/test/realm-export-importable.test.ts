// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Every realm export must survive Keycloak's `--import-realm`; a failed import aborts Keycloak startup.
import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel, type RealmExport } from './helpers/realm-exports'

/** Exports in this checkout plus REALM_EXPORT_PATHS (deployed realms live in proxy-smart-infra). */
const EXPORT_PATHS = realmExportPaths()

/** Fields Keycloak's UserRepresentation accepts (from its own rejection message). */
const USER_REPRESENTATION_FIELDS = new Set([
  'disableableCredentialTypes', 'lastName', 'emailVerified', 'self', 'applicationRoles',
  'createdTimestamp', 'groups', 'username', 'attributes', 'id', 'email', 'federationLink',
  'serviceAccountClientId', 'access', 'origin', 'userProfileMetadata', 'realmRoles',
  'clientRoles', 'totp', 'credentials', 'enabled', 'clientConsents', 'socialLinks',
  'firstName', 'requiredActions', 'notBefore', 'federatedIdentities',
])

/** Keycloak stores these as varchar(255); the import aborts on overflow. */
const VARCHAR_255 = 255

/** Every (label, value) pair the import writes into a varchar(255) column. */
function boundedFields(realm: RealmExport): { where: string; field: string; value: string }[] {
  const out: { where: string; field: string; value: string }[] = []
  const add = (where: string, field: string, value?: string) => {
    if (typeof value === 'string') out.push({ where, field, value })
  }

  for (const role of realm.roles?.realm ?? []) {
    add(`realm role ${role.name}`, 'name', role.name)
    add(`realm role ${role.name}`, 'description', role.description)
  }
  for (const [clientId, roles] of Object.entries(realm.roles?.client ?? {})) {
    for (const role of roles) {
      add(`client role ${clientId}/${role.name}`, 'name', role.name)
      add(`client role ${clientId}/${role.name}`, 'description', role.description)
    }
  }
  for (const client of realm.clients ?? []) {
    add(`client ${client.clientId}`, 'name', client.name)
    add(`client ${client.clientId}`, 'description', client.description)
  }
  for (const scope of realm.clientScopes ?? []) {
    add(`client scope ${scope.name}`, 'description', scope.description)
  }
  return out
}

const EXPORTS = EXPORT_PATHS.map((path) => ({ name: realmExportLabel(path), realm: readRealmExport(path) }))

/** Walk every object key in the document, reporting dotted paths. */
function* everyKey(value: unknown, path = '$'): Generator<{ key: string; path: string }> {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* everyKey(item, `${path}[${i}]`)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      yield { key, path: `${path}.${key}` }
      yield* everyKey(child, `${path}.${key}`)
    }
  }
}

/** Dev/CI-only seed accounts with plaintext passwords; the repo is public, so never in a deployed realm. */
const DEV_SEED_USERNAMES = ['admin', 'doctor', 'testuser']

const DEPLOY_EXPORTS = EXPORTS.filter((e) => !e.name.endsWith('keycloak/realm-export.json'))

// `--import-realm` skips an existing realm, so stale dev accounts would persist unnoticed.
describe.each(DEPLOY_EXPORTS)('$name — deployed environment', ({ realm }) => {
  it('seeds no user with a plaintext password', () => {
    const withPasswords = (realm.users ?? [])
      .filter((u) => Array.isArray(u.credentials) && u.credentials.length > 0)
      .map((u) => String(u.username ?? '<unnamed>'))

    expect(withPasswords).toEqual([])
  })

  it('seeds none of the dev/CI accounts', () => {
    const seeds = (realm.users ?? [])
      .map((u) => String(u.username ?? ''))
      .filter((name) => DEV_SEED_USERNAMES.includes(name))

    expect(seeds).toEqual([])
  })
})

describe.each(EXPORTS)('$name', ({ realm }) => {
  it('carries no pseudo-comment keys anywhere', () => {
    const comments = [...everyKey(realm)]
      .filter(({ key }) => key.startsWith('//'))
      .map(({ path }) => path)

    expect(comments).toEqual([])
  })

  it('declares only fields UserRepresentation accepts on every seeded user', () => {
    const unknown = (realm.users ?? []).flatMap((user) =>
      Object.keys(user)
        .filter((key) => !USER_REPRESENTATION_FIELDS.has(key))
        .map((key) => `${String(user.username ?? '<unnamed>')}.${key}`),
    )

    expect(unknown).toEqual([])
  })

  it('keeps every name and description within Keycloak\'s varchar(255) columns', () => {
    const tooLong = boundedFields(realm)
      .filter(({ value }) => value.length > VARCHAR_255)
      .map(({ where, field, value }) => `${where}.${field} is ${value.length} chars`)

    expect(tooLong).toEqual([])
  })

  // Keycloak's createRole for `defaultRole` does not wire composites; only the roles.realm[] pass does.
  it('declares the default role in roles.realm[] so its composites are wired', () => {
    const defaultRole = realm.defaultRole
    if (!defaultRole?.name) return

    const declared = (realm.roles?.realm ?? []).find((role) => role.name === defaultRole.name)
    expect(declared, `${defaultRole.name} must appear in roles.realm[], not only under defaultRole`).toBeDefined()

    expect(declared?.composites?.realm ?? []).toEqual(defaultRole.composites?.realm ?? [])
  })

  it('resolves every composite child to a declared realm role', () => {
    const declaredNames = new Set((realm.roles?.realm ?? []).map((role) => role.name))
    const dangling = (realm.roles?.realm ?? []).flatMap((role) =>
      (role.composites?.realm ?? [])
        .filter((child) => !declaredNames.has(child))
        .map((child) => `${role.name} -> ${child}`),
    )

    expect(dangling).toEqual([])
  })
})
