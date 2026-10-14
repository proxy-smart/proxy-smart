// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, isAbsolute } from 'path'
import type ClientScopeRepresentation from '@keycloak/keycloak-admin-client/lib/defs/clientScopeRepresentation.js'
import type RealmRepresentation from '@keycloak/keycloak-admin-client/lib/defs/realmRepresentation.js'

const REPO = join(import.meta.dir, '..', '..', '..')

export const DEV_REALM_EXPORT_PATH = join(REPO, 'keycloak', 'realm-export.json')

/** Keycloak's realm representation, with the client scopes it leaves untyped. */
export interface RealmExport extends Omit<RealmRepresentation, 'clientScopes'> {
  clientScopes?: ClientScopeRepresentation[]
}

export function readRealmExport(path: string): RealmExport {
  const realm: RealmExport = JSON.parse(readFileSync(path, 'utf8'))
  return realm
}

/**
 * Every realm export these tests should validate.
 *
 * The list is discovered rather than hardcoded because the environment realms
 * moved out of this repository: they name one operator's users, clients and
 * identity providers, so they live in proxy-smart-infra. A hardcoded list would
 * have made this repo's tests fail the moment they left, and — worse — would
 * have quietly stopped covering them.
 *
 * REALM_EXPORT_PATHS lets another repository point these same tests at its own
 * realms instead of forking the assertions. That is how proxy-smart-infra
 * validates prod and beta: one copy of the rules, two sets of data.
 */
export function realmExportPaths(): string[] {
  const override = process.env.REALM_EXPORT_PATHS?.trim()
  if (override) {
    // Comma or newline only. A colon separator would split "C:/..." at the
    // drive letter, and .gitattributes makes this repo's CI run on paths from
    // both platforms.
    return override
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (isAbsolute(p) ? p : join(REPO, p)))
  }

  const found = [DEV_REALM_EXPORT_PATH].filter(existsSync)

  const deployDir = join(REPO, 'deploy')
  if (existsSync(deployDir)) {
    for (const entry of readdirSync(deployDir)) {
      const candidate = join(deployDir, entry, 'realm-export.json')
      if (existsSync(candidate)) found.push(candidate)
    }
  }

  if (found.length === 0) {
    throw new Error(
      'No realm exports found. Set REALM_EXPORT_PATHS, or run from a checkout containing keycloak/realm-export.json.',
    )
  }
  return found
}

/** Repo-relative label for test names, so output reads the same either way. */
export function realmExportLabel(path: string): string {
  return path.startsWith(REPO) ? path.slice(REPO.length + 1).replace(/\\/g, '/') : path
}
