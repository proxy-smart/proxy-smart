// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Who counts as an administrator of THIS deployment.
 *
 * One place, one predicate. Previously two role sets were hardcoded inside `validateAdminToken`
 * alongside a hardcoded `admin-ui` client name — which disagreed with the audience check three
 * lines above it, since that one reads `config.keycloak.adminUiClientId`. On any deployment
 * overriding `KEYCLOAK_ADMIN_UI_CLIENT_ID`, the audience check followed the config while the role
 * lookup kept reading `resource_access['admin-ui']`, so client roles went silently invisible and
 * admins fell through to the realm-management catch-all — or were locked out.
 *
 * WHY A PRODUCT-NAMESPACED ROLE. The Keycloak realm is shared: beta's `admin` user carries
 * `gateway-admin`, which belongs to llm-gateway and appears in no Proxy Smart export. So a bare
 * `admin` realm role means "administrator of something", and accepting it means anyone made an
 * admin of any product in this realm administers Proxy Smart too.
 * {@link PRODUCT_ADMIN_ROLE} is how a grant says THIS product — the same reasoning behind
 * llm-gateway's `gateway-admin` (see its src/middleware/admin.ts, which this deliberately mirrors:
 * one configurable role, one exported predicate).
 *
 * The legacy roles stay in the defaults ON PURPOSE. Nobody holds `proxy-smart-admin` yet, and on
 * beta the only working admin passes solely via the realm-management branch, so shipping a
 * narrower set would lock every environment out with no way back short of the Keycloak console.
 * Narrowing is a later, deliberate step once grants are visible — see NARROWING below.
 *
 * NARROWING. Only write-capable `realm-management` roles count, so a read-only Keycloak console
 * role (view-users, query-clients, view-identity-providers) no longer confers write access here.
 * Reading without writing is what {@link PRODUCT_AUDITOR_ROLE} is for.
 */

import { config } from '../config'

/** This deployment's own admin role. Namespaced, because the realm hosts more than one product. */
export const PRODUCT_ADMIN_ROLE = 'proxy-smart-admin'

/** Reads the admin API, never writes: a monitoring or CI principal, such as a drift check. */
export const PRODUCT_AUDITOR_ROLE = 'proxy-smart-auditor'

/** What a caller wants to do with the admin API. */
export type AdminAccess = 'read' | 'write'

/**
 * Keycloak's built-in client that carries realm-administration roles.
 *
 * Left literal deliberately: this name is fixed by Keycloak, not chosen by us. Making it
 * configurable would invite pointing it at something meaningless. Hardcoding a value the upstream
 * product defines is a different thing from hardcoding our own policy.
 */
export const KEYCLOAK_REALM_MANAGEMENT_CLIENT = 'realm-management'

/** Realm roles that confer admin, unless overridden by `KEYCLOAK_ADMIN_REALM_ROLES`. */
export const DEFAULT_ADMIN_REALM_ROLES: readonly string[] = [
  PRODUCT_ADMIN_ROLE,
  'admin',
  'realm-admin',
  'manage-users',
  'manage-realm',
  'realm-management',
]

/** Realm or admin-UI client roles that confer read-only access, unless overridden by `KEYCLOAK_AUDITOR_ROLES`. */
export const DEFAULT_AUDITOR_ROLES: readonly string[] = [PRODUCT_AUDITOR_ROLE]

/** The `realm-management` roles that can change the realm. Keycloak defines these names. */
export const REALM_MANAGEMENT_WRITE_ROLES: ReadonlySet<string> = new Set([
  'realm-admin',
  'manage-realm',
  'manage-users',
  'manage-clients',
  'manage-identity-providers',
  'manage-authorization',
  'manage-events',
  'create-client',
  'impersonation',
])

/** Admin-UI client roles that confer admin, unless overridden by `KEYCLOAK_ADMIN_CLIENT_ROLES`. */
export const DEFAULT_ADMIN_CLIENT_ROLES: readonly string[] = [
  PRODUCT_ADMIN_ROLE,
  'admin',
  'manage-users',
  'manage-clients',
  'manage-realm',
]

/**
 * A comma-separated env override, or the defaults.
 *
 * Falls back to the DEFAULTS rather than to an empty list. An empty set would make every
 * `.some()` below false and lock all administrators out; the opposite temptation — treating empty
 * as "allow anything" — would be a silent authorization bypass. Both directions of failing open
 * are worse than ignoring a blank variable.
 */
function fromEnv(name: string, defaults: readonly string[]): Set<string> {
  const raw = process.env[name]
  const parsed = raw?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  return new Set(parsed.length > 0 ? parsed : defaults)
}

export function adminRealmRoles(): Set<string> {
  return fromEnv('KEYCLOAK_ADMIN_REALM_ROLES', DEFAULT_ADMIN_REALM_ROLES)
}

export function adminClientRoles(): Set<string> {
  return fromEnv('KEYCLOAK_ADMIN_CLIENT_ROLES', DEFAULT_ADMIN_CLIENT_ROLES)
}

export function auditorRoles(): Set<string> {
  return fromEnv('KEYCLOAK_AUDITOR_ROLES', DEFAULT_AUDITOR_ROLES)
}

/** The role claims a Keycloak access token carries, in the three places they appear. */
export interface RoleClaims {
  realm_access?: { roles?: string[] }
  resource_access?: Record<string, { roles?: string[] } | undefined>
}

/**
 * Whether a token's roles confer administrator access to this deployment.
 *
 * The single decision point, so the three claim locations cannot drift apart. Matching is exact
 * (set membership) rather than substring, so a role merely CONTAINING "admin" never qualifies.
 */
export function hasAdminRole(claims: RoleClaims): boolean {
  const realmRoles = claims.realm_access?.roles ?? []
  // The admin-UI client id comes from config, exactly as the audience check does. These two used
  // to disagree; that was the bug.
  const clientRoles = claims.resource_access?.[config.keycloak.adminUiClientId]?.roles ?? []
  const realmManagementRoles =
    claims.resource_access?.[KEYCLOAK_REALM_MANAGEMENT_CLIENT]?.roles ?? []

  const realmSet = adminRealmRoles()
  const clientSet = adminClientRoles()

  return (
    realmRoles.some((role) => realmSet.has(role)) ||
    clientRoles.some((role) => clientSet.has(role)) ||
    realmManagementRoles.some((role) => REALM_MANAGEMENT_WRITE_ROLES.has(role))
  )
}

/** Whether a token may do `access` with the admin API: an admin may do anything, an auditor may read. */
export function hasAdminAccess(claims: RoleClaims, access: AdminAccess): boolean {
  if (hasAdminRole(claims)) return true
  if (access !== 'read') return false
  const auditor = auditorRoles()
  const realmRoles = claims.realm_access?.roles ?? []
  const clientRoles = claims.resource_access?.[config.keycloak.adminUiClientId]?.roles ?? []
  return realmRoles.some((role) => auditor.has(role)) || clientRoles.some((role) => auditor.has(role))
}
