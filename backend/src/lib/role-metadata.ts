// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Role descriptive-metadata helpers.
 *
 * IMPORTANT: Everything here is DESCRIPTIVE only. The role <-> scope-set link is a
 * human-readable LABEL ("typical scopes this role represents"). It is never used for
 * FHIR/MCP access enforcement. FHIR access stays scope-based (smart-access-control.ts
 * + fhirUser filtering). Do not read an access grant/deny into any of this.
 */

import type RoleRepresentation from '@keycloak/keycloak-admin-client/lib/defs/roleRepresentation.js'
import { getScopeSet } from './scope-sets-store'
import type { RoleResponseType } from '@/schemas'
import { adminRealmRoles, adminClientRoles } from './admin-roles'
import { getAttrValues } from './keycloak-component-config'

/**
 * Attribute key under which a role stores the ID of the scope set it represents.
 * Stored as a single-element string array, the Keycloak attribute convention.
 */
export const REPRESENTED_SCOPE_SET_ATTR = 'represented_scope_set'

/**
 * Attribute key holding the raw scopes a role represents (descriptive label).
 */
export const FHIR_SCOPES_ATTR = 'fhir_scopes'

/**
 * Plumbing/technical roles the admin UI hides by default. These are Keycloak
 * internals, not clinical/admin-intent roles.
 */
const TECHNICAL_ROLE_NAMES = new Set(['offline_access', 'uma_authorization'])

/**
 * Decide whether a role is "technical" (plumbing) and should be hidden by default.
 */
export function isTechnicalRole(role: RoleRepresentation): boolean {
  const name = role.name ?? ''
  if (TECHNICAL_ROLE_NAMES.has(name)) return true
  if (name.startsWith('default-roles-')) return true
  return false
}

function nonEmptyAttrValues(role: RoleRepresentation, key: string): string[] {
  return getAttrValues(role.attributes, key).filter((value) => value.length > 0)
}

/**
 * Whether holding this role confers admin access, per `hasAdminRole`.
 *
 * Read from the same predicate the auth path uses, so the UI cannot claim a role
 * grants admin when it does not. The sets are env-overridable, which is exactly
 * why the UI must be told rather than deciding for itself.
 */
export function grantsAdminAccess(role: RoleRepresentation): boolean {
  if (!role.name) return false
  return (role.clientRole ? adminClientRoles() : adminRealmRoles()).has(role.name)
}

/**
 * Enrich a raw Keycloak role with descriptive metadata for the admin UI:
 *  - isTechnical flag (so the UI can hide plumbing roles)
 *  - grantsAdmin flag (so the UI can show what actually confers access)
 *  - the represented scope set (name + resolved scopes), purely as a label
 *
 * The represented scopes are resolved from the linked scope set when present,
 * falling back to / merged with the role's own fhir_scopes attribute.
 */
export function enrichRole(role: RoleRepresentation): RoleResponseType {
  const representedScopeSetId = nonEmptyAttrValues(role, REPRESENTED_SCOPE_SET_ATTR)[0]
  const ownScopes = nonEmptyAttrValues(role, FHIR_SCOPES_ATTR)

  let representedScopeSetName: string | undefined
  let scopeSetScopes: string[] = []
  if (representedScopeSetId) {
    const scopeSet = getScopeSet(representedScopeSetId)
    if (scopeSet) {
      representedScopeSetName = scopeSet.name
      scopeSetScopes = scopeSet.scopes
    }
  }

  // Merge scope-set scopes with the role's own fhir_scopes, de-duplicated.
  const representedScopes = [...new Set([...scopeSetScopes, ...ownScopes])]

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    composite: role.composite,
    clientRole: role.clientRole,
    attributes: role.attributes as RoleResponseType['attributes'],
    isTechnical: isTechnicalRole(role),
    grantsAdmin: grantsAdminAccess(role),
    ...(representedScopeSetId ? { representedScopeSetId } : {}),
    ...(representedScopeSetName ? { representedScopeSetName } : {}),
    ...(representedScopes.length > 0 ? { representedScopes } : {})
  }
}
