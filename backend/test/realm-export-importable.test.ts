// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Every realm export must survive Keycloak's realm import.
 *
 * THE BUG THIS GUARDS. A `"//"` key was added inside a seeded user to explain
 * why that account is the sole administrator. JSON has no comments, and
 * Keycloak deserializes `users[]` into `UserRepresentation` with unknown fields
 * rejected — so the import failed with `Unrecognized field "//"`, which aborts
 * startup entirely. Keycloak never came up and the beta deploy died with it.
 * Nothing caught it before the deploy because the file is still valid JSON and
 * nothing else reads that key.
 *
 * The rationale that comment carried now lives in docs/deployment.md.
 *
 * Asserting "no `//` key" alone would only re-fix the instance, so this asserts
 * the shape: a seeded user may only carry fields UserRepresentation declares.
 * The property list is Keycloak's own, copied from the error it printed.
 *
 * THE SECOND BUG THIS GUARDS. Two realm-role descriptions grew past 255
 * characters while documenting why the `admin` composite exists. `--import-realm`
 * writes straight into Keycloak's schema, where those columns are varchar(255),
 * so the import aborted and Keycloak again refused to start:
 *
 *   ERROR: value too long for type character varying(255)
 *   [update KEYCLOAK_ROLE set CLIENT=?,...,DESCRIPTION=?,NAME=?,...]
 *
 * That took the SMART compliance workflow down for a day, reported as
 * "proxy-smart realm not found" — which reads as a broken test rig rather than
 * an over-long string. The reasoning moved to docs/keycloak-features.md.
 */
import { describe, it, expect } from 'bun:test'
import { readRealmExport, realmExportPaths, realmExportLabel, type RealmExport } from './helpers/realm-exports'

/**
 * Every realm export present in this checkout, plus any REALM_EXPORT_PATHS
 * points at. The environment realms live in proxy-smart-infra and are layered
 * onto the Keycloak base image there, so they reach these assertions from that
 * repository's CI rather than from a hardcoded path here.
 */
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

/**
 * Seed accounts that exist ONLY for local development and CI.
 *
 * They carry plaintext passwords in keycloak/realm-export.json, which is
 * deliberate: the dev realm is a throwaway container and the per-stage
 * inferno-config.json files authenticate with them. Because this repository is
 * public, those credentials are for local use only and must not seed a deployed
 * environment.
 */
const DEV_SEED_USERNAMES = ['admin', 'doctor', 'testuser']

/**
 * Exports that seed a REAL environment. keycloak/realm-export.json is excluded:
 * it is the dev/CI seed and is allowed to carry dev passwords.
 */
const DEPLOY_EXPORTS = EXPORTS.filter((e) => !e.name.endsWith('keycloak/realm-export.json'))

/**
 * A deployed environment must not be seeded with dev accounts or passwords.
 *
 * Worth pinning because the failure is invisible: `--import-realm` skips a realm
 * that already exists, so a realm first created from the dev export keeps those
 * accounts even after the deploy export is changed to declare a single IdP-only
 * admin with no credentials. The exports then disagree with reality and nothing
 * reports it.
 *
 * Asserts the shape rather than any one account, so this holds for the next
 * environment too.
 */
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
    // Not scoped to users: Keycloak tolerates unknown fields on some
    // representations and not others, and which is which is not worth
    // depending on. JSON has no comments, so none of these belong.
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
    // A description is a UI label with a hard length cap, not somewhere to put
    // rationale — that belongs in docs/keycloak-features.md.
    const tooLong = boundedFields(realm)
      .filter(({ value }) => value.length > VARCHAR_255)
      .map(({ where, field, value }) => `${where}.${field} is ${value.length} chars`)

    expect(tooLong).toEqual([])
  })

  /**
   * THE THIRD BUG THIS GUARDS. `defaultRole` alone does not produce a working
   * composite. Keycloak's RealmManager does:
   *
   *   realm.setDefaultRole(RepresentationToModel.createRole(realm, rep.getDefaultRole()))
   *
   * and `createRole` does NOT wire composites — those are attached by the
   * separate pass over `roles.realm[]`. A default role declared only under
   * `realm.defaultRole` is therefore created EMPTY: every user who holds it,
   * seeded or created at runtime, silently gets none of the roles it names.
   *
   * That is how `offline_access` went missing, which surfaces at the token
   * exchange as "Offline tokens not allowed for the user or client" — after a
   * successful login, so it reads as a broken server rather than a missing role.
   */
  it('declares the default role in roles.realm[] so its composites are wired', () => {
    const defaultRole = realm.defaultRole
    if (!defaultRole?.name) return

    const declared = (realm.roles?.realm ?? []).find((role) => role.name === defaultRole.name)
    expect(declared, `${defaultRole.name} must appear in roles.realm[], not only under defaultRole`).toBeDefined()

    // Same composites in both places, or the two disagree about what a new user gets.
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
