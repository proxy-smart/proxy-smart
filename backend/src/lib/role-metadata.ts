// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

// Descriptive labels only: the role <-> scope-set link is never used for FHIR/MCP access enforcement.

import type RoleRepresentation from '@keycloak/keycloak-admin-client/lib/defs/roleRepresentation.js'
import { getScopeSet } from './scope-sets-store'
import type { RoleResponseType } from '@/schemas'
import { adminRealmRoles, adminClientRoles } from './admin-roles'
import { getAttrValues } from './keycloak-component-config'

export const REPRESENTED_SCOPE_SET_ATTR = 'represented_scope_set'

export const FHIR_SCOPES_ATTR = 'fhir_scopes'

const TECHNICAL_ROLE_NAMES = new Set(['offline_access', 'uma_authorization'])

export function isTechnicalRole(role: RoleRepresentation): boolean {
  const name = role.name ?? ''
  if (TECHNICAL_ROLE_NAMES.has(name)) return true
  if (name.startsWith('default-roles-')) return true
  return false
}

function nonEmptyAttrValues(role: RoleRepresentation, key: string): string[] {
  return getAttrValues(role.attributes, key).filter((value) => value.length > 0)
}

/** Same env-overridable role sets as hasAdminRole, so the UI cannot disagree with auth. */
export function grantsAdminAccess(role: RoleRepresentation): boolean {
  if (!role.name) return false
  return (role.clientRole ? adminClientRoles() : adminRealmRoles()).has(role.name)
}

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

  const representedScopes = [...new Set([...scopeSetScopes, ...ownScopes])]

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    composite: role.composite,
    clientRole: role.clientRole,
    attributes: role.attributes,
    isTechnical: isTechnicalRole(role),
    grantsAdmin: grantsAdminAccess(role),
    ...(representedScopeSetId ? { representedScopeSetId } : {}),
    ...(representedScopeSetName ? { representedScopeSetName } : {}),
    ...(representedScopes.length > 0 ? { representedScopes } : {})
  }
}
