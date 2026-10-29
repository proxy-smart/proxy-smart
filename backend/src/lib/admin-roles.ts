// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { config } from '../config'

/** Namespaced because the Keycloak realm is shared with other products. */
export const PRODUCT_ADMIN_ROLE = 'proxy-smart-admin'

/** Read-only admin API access, e.g. for a drift check. */
export const PRODUCT_AUDITOR_ROLE = 'proxy-smart-auditor'

export type AdminAccess = 'read' | 'write'

/** Fixed by Keycloak, so deliberately not configurable. */
export const KEYCLOAK_REALM_MANAGEMENT_CLIENT = 'realm-management'

// Legacy roles stay until proxy-smart-admin is granted everywhere; removing them now locks admins out.
export const DEFAULT_ADMIN_REALM_ROLES: readonly string[] = [
  PRODUCT_ADMIN_ROLE,
  'admin',
  'realm-admin',
  'manage-users',
  'manage-realm',
  'realm-management',
]

export const DEFAULT_AUDITOR_ROLES: readonly string[] = [PRODUCT_AUDITOR_ROLE]

// Write-capable only: read-only console roles (view-users, query-clients) must not confer admin.
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

export const DEFAULT_ADMIN_CLIENT_ROLES: readonly string[] = [
  PRODUCT_ADMIN_ROLE,
  'admin',
  'manage-users',
  'manage-clients',
  'manage-realm',
]

// Blank override falls back to defaults: empty would lock everyone out, "allow any" would bypass auth.
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

export interface RoleClaims {
  realm_access?: { roles?: string[] }
  resource_access?: Record<string, { roles?: string[] } | undefined>
}

export function realmRoles(claims: RoleClaims): string[] {
  return claims.realm_access?.roles ?? []
}

export function clientRoles(claims: RoleClaims, clientId: string): string[] {
  return claims.resource_access?.[clientId]?.roles ?? []
}

export function allRoles(claims: RoleClaims): string[] {
  const perClient = Object.values(claims.resource_access ?? {}).flatMap((access) => access?.roles ?? [])
  return [...new Set([...realmRoles(claims), ...perClient])]
}

export function hasAdminRole(claims: RoleClaims): boolean {
  const realmSet = adminRealmRoles()
  const clientSet = adminClientRoles()

  // Admin-UI client id from config so it matches the audience check in validateAdminToken.
  return (
    realmRoles(claims).some((role) => realmSet.has(role)) ||
    clientRoles(claims, config.keycloak.adminUiClientId).some((role) => clientSet.has(role)) ||
    clientRoles(claims, KEYCLOAK_REALM_MANAGEMENT_CLIENT).some((role) => REALM_MANAGEMENT_WRITE_ROLES.has(role))
  )
}

export function hasAdminAccess(claims: RoleClaims, access: AdminAccess): boolean {
  if (hasAdminRole(claims)) return true
  if (access !== 'read') return false
  const auditor = auditorRoles()
  return [...realmRoles(claims), ...clientRoles(claims, config.keycloak.adminUiClientId)].some((role) => auditor.has(role))
}
